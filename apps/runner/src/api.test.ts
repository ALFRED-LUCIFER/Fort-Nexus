import { describe, expect, it, vi } from "vitest";
import { ApiCallError, createApi, withRetry } from "./api.ts";

const JOB = "6f1c1d3e-8a4b-4c1e-9f00-000000000001";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createApi", () => {
  it("sends the bearer token on runner calls and none on register", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, { cancelJobIds: [] }));
    await createApi({ baseUrl: "http://127.0.0.1:8787/", token: "secret-token", fetch }).heartbeat({
      activeJobIds: [],
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/runner/heartbeat");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");

    fetch.mockResolvedValueOnce(json(200, { runnerId: JOB, token: "t" }));
    await createApi({ baseUrl: "http://127.0.0.1:8787", fetch }).register({
      code: "ABCDEF",
      name: "n",
      os: "o",
      version: "1",
    });
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).has("authorization")).toBe(false);
  });

  it("maps 204 on lease to null and keeps an unknown request for the job to reject", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    const api = createApi({ baseUrl: "http://x", token: "t", fetch });
    expect(await api.lease()).toBeNull();
    const lease = {
      jobId: JOB,
      request: { jobType: "SHELL", cmd: "ls" },
      fencingToken: 1,
      leaseExpiresAt: new Date().toISOString(),
    };
    fetch.mockResolvedValueOnce(json(200, lease));
    expect(await api.lease()).toEqual(lease);
  });

  it("rejects responses that fail the contract schema", async () => {
    const api = createApi({
      baseUrl: "http://x",
      token: "t",
      fetch: async () => json(200, { cancelJobIds: ["nope"] }),
    });
    await expect(api.heartbeat({ activeJobIds: [] })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
    });
  });

  it("parses ApiError bodies and classifies retryable failures", async () => {
    const stale = json(409, { error: { code: "STALE_LEASE", message: "old token" }, requestId: "r" });
    const api = createApi({ baseUrl: "http://x", token: "t", fetch: async () => stale });
    await expect(
      api.appendEvents(JOB, { batchId: "00000000-0000-4000-8000-000000000000", fencingToken: 1, events: [] }),
    ).rejects.toMatchObject({
      status: 409,
      code: "STALE_LEASE",
      retryable: false,
    });
    const down = createApi({
      baseUrl: "http://x",
      fetch: async () => new Response("bad gateway", { status: 502 }),
    });
    await expect(down.heartbeat({ activeJobIds: [] })).rejects.toMatchObject({
      code: "HTTP_502",
      retryable: true,
    });
    const offline = createApi({
      baseUrl: "http://x",
      fetch: async () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(offline.heartbeat({ activeJobIds: [] })).rejects.toMatchObject({
      code: "NETWORK",
      retryable: true,
    });
  });
});

describe("withRetry", () => {
  it("retries transient errors and stops on permanent ones", async () => {
    const transient = new ApiCallError("down", 503, "HTTP_503", true);
    const flaky = vi.fn().mockRejectedValueOnce(transient).mockResolvedValueOnce("ok");
    expect(await withRetry(flaky, { forMs: 5_000 })).toBe("ok");
    expect(flaky).toHaveBeenCalledTimes(2);

    const permanent = vi.fn().mockRejectedValue(new ApiCallError("stale", 409, "STALE_LEASE", false));
    await expect(withRetry(permanent, { forMs: 5_000 })).rejects.toMatchObject({ code: "STALE_LEASE" });
    expect(permanent).toHaveBeenCalledTimes(1);
  });
});
