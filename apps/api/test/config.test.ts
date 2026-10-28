import { homedir } from "node:os";
import { join } from "node:path";
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

  it("expands ~ in GITHUB_APP_FILE and defaults it to ~/.nexus/github-app.json", () => {
    expect(loadConfig({ ...base, GITHUB_APP_FILE: "~/x/app.json" }).githubAppFile).toBe(
      join(homedir(), "x", "app.json"),
    );
    expect(loadConfig(base).githubAppFile).toBe(join(homedir(), ".nexus", "github-app.json"));
  });

  it("fails fast on a short secret, non-loopback host or bad origin", () => {
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: "short" })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => loadConfig({ ...base, API_HOST: "0.0.0.0" })).toThrow(/loopback/);
    expect(() => loadConfig({ ...base, TRUSTED_ORIGINS: "javascript:alert(1)" })).toThrow(
      /Invalid configuration/,
    );
    expect(() => loadConfig({ BETTER_AUTH_SECRET: "s".repeat(32) })).toThrow(/DATABASE_URL/);
  });

  it("binds 0.0.0.0 only with API_BIND_ALL_IN_CONTAINER=1 inside a container", () => {
    const all = { ...base, API_HOST: "0.0.0.0", API_BIND_ALL_IN_CONTAINER: "1" };
    expect(loadConfig(all, () => true).host).toBe("0.0.0.0");
    expect(() => loadConfig(all, () => false)).toThrow(/only allowed inside a container/);
    expect(() => loadConfig({ ...base, API_HOST: "0.0.0.0" }, () => true)).toThrow(/loopback/);
    expect(() => loadConfig({ ...all, API_HOST: "192.168.1.5" }, () => true)).toThrow(/loopback/);
  });

  it("defaults OWNER_TIMEZONE to Asia/Dubai and accepts IANA names only", () => {
    expect(loadConfig(base).ownerTimezone).toBe("Asia/Dubai");
    expect(loadConfig({ ...base, OWNER_TIMEZONE: "Europe/Vienna" }).ownerTimezone).toBe("Europe/Vienna");
    for (const tz of ["Mars/Olympus", "+04:00", "", "Asia/Dubai; drop table jobs"])
      expect(() => loadConfig({ ...base, OWNER_TIMEZONE: tz })).toThrow(/OWNER_TIMEZONE/);
  });
});
