import { afterAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers/owner-session.ts";

// Per-client rate limits behind Tailscale Serve / the Compose gateway: request.ip is what the last trusted proxy saw.
// /v1/runner/register allows 10 a minute per IP; an empty body still counts (the limit runs before validation).
const LIMIT = 10;
const GATEWAY = "172.18.0.1"; // the Compose bridge gateway the API container sees every connection from

const apps: TestApp[] = [];
afterAll(() => Promise.all(apps.map((t) => t.app.close())));

async function app(env: Record<string, string> = {}) {
  const t = await createTestApp(env, { github: false });
  apps.push(t);
  const register = (remoteAddress: string, forwardedFor?: string) =>
    t.app
      .inject({
        method: "POST",
        url: "/v1/runner/register",
        remoteAddress,
        headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
        payload: {},
      })
      .then((r) => r.statusCode);
  return { register };
}

const spend = async (send: () => Promise<number>) => {
  for (let i = 0; i < LIMIT; i++) expect(await send()).not.toBe(429);
};

describe("client IP behind a trusted proxy", () => {
  it("gives each client behind the gateway its own bucket; a forged X-Forwarded-For doesn't escape it", async () => {
    const { register } = await app();
    await spend(() => register(GATEWAY, "100.101.1.1"));
    expect(await register(GATEWAY, "100.101.1.1")).toBe(429);
    // The client prepends a fake address; Tailscale Serve appends the real one, which is what counts.
    expect(await register(GATEWAY, "203.0.113.50, 100.101.1.1")).toBe(429);
    // Another tailnet device is not throttled by the first one.
    expect(await register(GATEWAY, "100.101.2.2")).not.toBe(429);
    expect(await register("127.0.0.1", "100.101.3.3")).not.toBe(429); // host-mode: Tailscale Serve on loopback
  });

  it("ignores X-Forwarded-For from an untrusted peer, so rotating it never resets the limit", async () => {
    const { register } = await app();
    const peer = "203.0.113.7";
    for (let i = 0; i < LIMIT; i++) expect(await register(peer, `198.51.100.${i}`)).not.toBe(429);
    expect(await register(peer, "198.51.100.99")).toBe(429);
    // A tailnet address connecting directly is a client, not a proxy.
    const tailnet = "100.101.9.9";
    let n = 0;
    await spend(() => register(tailnet, `198.51.100.${n++}`));
    expect(await register(tailnet, "198.51.100.251")).toBe(429);
  });

  it("TRUST_PROXY_HOPS=0 ignores the header entirely", async () => {
    const { register } = await app({ TRUST_PROXY_HOPS: "0" });
    await spend(() => register(GATEWAY, "100.101.1.1"));
    expect(await register(GATEWAY, "100.101.2.2")).toBe(429);
  });
});
