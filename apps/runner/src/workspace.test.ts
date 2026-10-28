import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bareRepo, git } from "./test-support.ts";
import { createWorkspaces, withMirrorLock } from "./workspace.ts";

let data = "";
let outside = "";
let ws: ReturnType<typeof createWorkspaces>;
let mirror = "";

beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), "nexus-data-"));
  outside = await mkdtemp(join(tmpdir(), "nexus-outside-"));
  ws = createWorkspaces(data);
  mirror = await bareRepo(join(data, "repos"));
});
afterEach(async () => {
  await rm(data, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("worktrees", () => {
  it("creates work/<jobId> on a new branch from the base ref and removes it again", async () => {
    const jobId = randomUUID();
    expect(ws.mirrorPath("acme", "demo")).toBe(mirror);
    const wt = await ws.prepareWorktree({
      jobId,
      mirrorPath: mirror,
      baseRef: "main",
      branch: "nexus/job-1",
    });

    expect(wt.path).toBe(join(await realpath(data), "work", jobId));
    expect(wt.baseSha).toBe(git(["-C", mirror, "rev-parse", "main"]));
    expect(readFileSync(join(wt.path, "README.md"), "utf8")).toBe("hello\n");
    expect(git(["-C", mirror, "worktree", "list", "--porcelain"])).toContain(`branch refs/heads/nexus/job-1`);

    await ws.removeWorktree(jobId);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(["-C", mirror, "worktree", "list", "--porcelain"])).not.toContain(jobId);
    expect(git(["-C", mirror, "branch", "--list", "nexus/job-1"])).toContain("nexus/job-1"); // work is kept
  });

  it.each(["main", "Master", "trunk", "develop", "release/1.0", "HEAD", "-f", "bad..name"])(
    "refuses %s as the work branch",
    async (branch) => {
      await expect(
        ws.prepareWorktree({ jobId: randomUUID(), mirrorPath: mirror, baseRef: "main", branch }),
      ).rejects.toThrow();
      expect(git(["-C", mirror, "worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1);
    },
  );

  it("refuses the mirror's own default branch even when it is not a well-known name", async () => {
    const custom = await bareRepo(join(data, "repos"), "acme", "custom", "stable");
    await expect(
      ws.prepareWorktree({ jobId: randomUUID(), mirrorPath: custom, baseRef: "stable", branch: "stable" }),
    ).rejects.toThrow(/default branch/);
  });

  it("treats a hostile base ref as a revision, never as an option", async () => {
    await expect(
      ws.prepareWorktree({
        jobId: randomUUID(),
        mirrorPath: mirror,
        baseRef: "--output=/tmp/pwned",
        branch: "nexus/x",
      }),
    ).rejects.toThrow(/rev-parse/);
    expect(existsSync("/tmp/pwned")).toBe(false);
  });

  it("prunes worktrees older than the threshold and keeps fresh ones", async () => {
    const [old, fresh] = [randomUUID(), randomUUID()];
    const a = await ws.prepareWorktree({
      jobId: old,
      mirrorPath: mirror,
      baseRef: "main",
      branch: "nexus/a",
    });
    await ws.prepareWorktree({ jobId: fresh, mirrorPath: mirror, baseRef: "main", branch: "nexus/b" });
    const past = new Date(Date.now() - 3_600_000);
    await utimes(a.path, past, past);

    expect(await ws.pruneStale(60_000)).toEqual([old]);
    expect(existsSync(join(data, "work", fresh))).toBe(true);
  });
});

describe("path safety", () => {
  const prepare = (mirrorPath: string, jobId: string = randomUUID()) =>
    ws.prepareWorktree({ jobId, mirrorPath, baseRef: "main", branch: "nexus/x" });

  it("rejects .. and absolute paths outside the data dir", async () => {
    const elsewhere = await bareRepo(outside);
    // data and outside are siblings in tmpdir, so this climbs out of the data dir with `..`.
    const climbed = `${data}/repos/../../${basename(outside)}/acme/demo.git`;
    expect(climbed).toContain("/../");
    await expect(prepare(climbed)).rejects.toThrow(/outside/);
    await expect(prepare(elsewhere)).rejects.toThrow(/outside/);
    await expect(prepare(mirror, "../../escape")).rejects.toThrow(/uuid/);
    await expect(ws.removeWorktree("../../escape")).rejects.toThrow(/uuid/);
    expect(() => ws.mirrorPath("..", "demo")).toThrow();
    expect(() => ws.mirrorPath("acme", "../x")).toThrow();
  });

  it("rejects a mirror symlinked to a repo outside the data dir", async () => {
    const elsewhere = await bareRepo(outside);
    await mkdir(join(data, "repos", "evil"));
    await symlink(elsewhere, join(data, "repos", "evil", "x.git"));
    await expect(prepare(join(data, "repos", "evil", "x.git"))).rejects.toThrow(/outside/);
  });

  it("rejects a work dir replaced by a symlink out of the data dir", async () => {
    await rm(join(data, "work"), { recursive: true, force: true });
    await symlink(outside, join(data, "work"));
    await expect(prepare(mirror)).rejects.toThrow(/work dir resolves outside/);
  });
});

describe("per-mirror lock", () => {
  it("serialises work on one mirror and leaves other mirrors free", async () => {
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`${name}:start`);
      await sleep(ms);
      log.push(`${name}:end`);
    };
    await Promise.all([
      withMirrorLock("/m1", task("a", 40)),
      withMirrorLock("/m1", task("b", 1)),
      withMirrorLock("/m2", task("c", 1)),
    ]);
    expect(log.indexOf("b:start")).toBeGreaterThan(log.indexOf("a:end"));
    expect(log.indexOf("c:end")).toBeLessThan(log.indexOf("a:end"));
  });

  it("keeps going after a failed holder", async () => {
    await expect(withMirrorLock("/m3", async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(withMirrorLock("/m3", async () => "ok")).resolves.toBe("ok");
  });

  it("lets concurrent prepares on one mirror both succeed", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const made = await Promise.all(
      ids.map((jobId, i) =>
        ws.prepareWorktree({ jobId, mirrorPath: mirror, baseRef: "main", branch: `nexus/c${i}` }),
      ),
    );
    expect(made.map((w) => existsSync(join(w.path, "README.md")))).toEqual([true, true, true]);
    expect(git(["-C", mirror, "worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(4);
  });
});
