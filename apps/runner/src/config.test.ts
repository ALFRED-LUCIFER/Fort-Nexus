import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, readToken, writeToken } from "./config.ts";

describe("loadConfig", () => {
  it("applies defaults and expands ~", () => {
    expect(loadConfig({})).toEqual({
      NEXUS_API_URL: "http://127.0.0.1:8787",
      RUNNER_TOKEN_FILE: join(homedir(), ".nexus", "runner-token"),
    });
  });

  it("only allows plain http on loopback", () => {
    expect(() => loadConfig({ NEXUS_API_URL: "http://nexus.example.com" })).toThrow(/https/);
    expect(() => loadConfig({ NEXUS_API_URL: "ftp://127.0.0.1" })).toThrow();
    expect(loadConfig({ NEXUS_API_URL: "https://nexus.tail1234.ts.net" }).NEXUS_API_URL).toBe(
      "https://nexus.tail1234.ts.net",
    );
  });
});

describe("token file", () => {
  let dir = "";
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("is written with mode 0600 (also when replacing a looser file) and read back", async () => {
    dir = await mkdtemp(join(tmpdir(), "nexus-token-"));
    const file = join(dir, "sub", "runner-token");
    await writeToken(file, "first");
    await chmod(file, 0o644);
    await writeToken(file, "second");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("second\n");
    expect(await readToken(file)).toBe("second");
  });
});
