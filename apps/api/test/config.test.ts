import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const base = { DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db", BETTER_AUTH_SECRET: "s".repeat(32) };

describe("loadConfig", () => {
  it("applies loopback defaults and adds the Vite origin outside production", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({ host: "127.0.0.1", port: 8787, publicOrigin: "http://127.0.0.1:8787" });
    expect(c.trustedOrigins).toEqual(["http://127.0.0.1:8787", "http://localhost:5173"]);
    const prod = loadConfig({
      ...base,
      NODE_ENV: "production",
      TRUSTED_ORIGINS: "https://a.example/, https://b.example",
    });
    expect(prod.trustedOrigins).toEqual(["http://127.0.0.1:8787", "https://a.example", "https://b.example"]);
  });

  it("fails fast on a short secret, non-loopback host or bad origin", () => {
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: "short" })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => loadConfig({ ...base, API_HOST: "0.0.0.0" })).toThrow(/loopback/);
    expect(() => loadConfig({ ...base, TRUSTED_ORIGINS: "javascript:alert(1)" })).toThrow(
      /Invalid configuration/,
    );
    expect(() => loadConfig({ BETTER_AUTH_SECRET: "s".repeat(32) })).toThrow(/DATABASE_URL/);
  });
});
