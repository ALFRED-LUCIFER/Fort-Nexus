import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDataDirForTemp } from "./config.ts";

describe("useDataDirForTemp", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "nexus-data-"));
  });
  afterEach(() => rm(dataDir, { recursive: true, force: true }));

  it("points TMPDIR inside the data dir, private to this user", async () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: "/var/folders/x" };
    const dir = await useDataDirForTemp(dataDir, env);
    expect(dir).toBe(join(dataDir, "tmp"));
    expect(env.TMPDIR).toBe(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("wipes what a crashed run left behind", async () => {
    await mkdir(join(dataDir, "tmp", "nexus-claude-old"), { recursive: true });
    await writeFile(join(dataDir, "tmp", "nexus-claude-old", "task.json"), "{}");
    const dir = await useDataDirForTemp(dataDir, {});
    await expect(stat(join(dir, "nexus-claude-old"))).rejects.toThrow();
  });
});
