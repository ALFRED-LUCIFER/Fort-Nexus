import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANGESET_MAX_BYTES, CHANGESET_MAX_FILES } from "@nexus/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangesetError, buildChangeset } from "./changeset.ts";
import { collectArtifacts, worktreeGitDir } from "./claude.ts";
import { git } from "./test-support.ts";
import { createWorkspaces, removePlantedRepos } from "./workspace.ts";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const BINARY = Buffer.from([0, 1, 2, 255, 0, 10, 13, 0x89, 0x50]);

let data = "";
beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), "nexus-cs-"));
});
afterEach(() => rm(data, { recursive: true, force: true }));

// A worktree on nexus/t from a base commit holding README.md, old.txt, moved.txt, run.sh and .gitignore.
async function worktree() {
  const src = join(data, "src");
  git(["init", "-q", "-b", "main", src]);
  await writeFile(join(src, "README.md"), "hello\nworld\n");
  await writeFile(join(src, "old.txt"), "to delete\n");
  await writeFile(join(src, "moved.txt"), "moving\n");
  await writeFile(join(src, "run.sh"), "echo hi\n");
  await writeFile(join(src, ".gitignore"), "build/\n");
  git(["-C", src, "add", "."]);
  git(["-C", src, "commit", "-q", "-m", "base"]);
  const mirror = join(data, "repos", "acme", "demo.git");
  git(["clone", "-q", "--mirror", src, mirror]);
  const wt = await createWorkspaces(data).prepareWorktree({
    jobId: randomUUID(),
    mirrorPath: mirror,
    baseRef: "main",
    branch: "nexus/t",
  });
  return { ...wt, gitDir: await worktreeGitDir(wt.path) };
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => expect.unreachable("should have failed"),
    (err: unknown) => {
      expect(err).toBeInstanceOf(ChangesetError);
      return err as ChangesetError;
    },
  );

describe("buildChangeset", () => {
  it("captures added, modified, deleted, renamed, symlink, executable, binary and untracked files; never .git", async () => {
    const wt = await worktree();
    await writeFile(join(wt.path, "README.md"), "hello\nthere\nworld\n");
    await unlink(join(wt.path, "old.txt"));
    await rename(join(wt.path, "moved.txt"), join(wt.path, "renamed.txt"));
    await chmod(join(wt.path, "run.sh"), 0o755);
    await symlink("README.md", join(wt.path, "link"));
    await mkdir(join(wt.path, "src", "deep"), { recursive: true });
    await writeFile(join(wt.path, "src", "deep", "new.ts"), "export {};\n");
    await writeFile(join(wt.path, "logo.bin"), BINARY);
    await mkdir(join(wt.path, "build"));
    await writeFile(join(wt.path, "build", "out.js"), "ignored\n");
    // The agent can rewrite the worktree's .git file: it is neither followed nor shipped.
    await writeFile(join(wt.path, ".git"), `gitdir: ${join(data, "evil")}\n`);

    const cs = await buildChangeset(wt.path, wt.gitDir, wt.baseSha);
    expect(cs.files).toEqual([
      { change: "modified", path: "README.md", mode: "100644", contentBase64: b64("hello\nthere\nworld\n") },
      { change: "added", path: "link", mode: "120000", contentBase64: b64("README.md") },
      { change: "added", path: "logo.bin", mode: "100644", contentBase64: b64(BINARY) },
      { change: "deleted", path: "moved.txt" },
      { change: "deleted", path: "old.txt" },
      { change: "added", path: "renamed.txt", mode: "100644", contentBase64: b64("moving\n") },
      { change: "modified", path: "run.sh", mode: "100755", contentBase64: b64("echo hi\n") },
      { change: "added", path: "src/deep/new.ts", mode: "100644", contentBase64: b64("export {};\n") },
    ]);
    // README +1, link +1, renamed +1, new.ts +1; old.txt -1, moved.txt -1; binary counts 0.
    expect(cs.stats).toEqual({ added: 4, removed: 2 });
  });

  it("returns no files when nothing changed", async () => {
    const wt = await worktree();
    expect(await buildChangeset(wt.path, wt.gitDir, wt.baseSha)).toEqual({
      files: [],
      stats: { added: 0, removed: 0 },
      tree: git(["-C", wt.path, "rev-parse", `${wt.baseSha}^{tree}`]),
    });
  });

  it(`fails changeset_too_large above ${CHANGESET_MAX_FILES} files`, async () => {
    const wt = await worktree();
    await mkdir(join(wt.path, "many"));
    for (let i = 0; i <= CHANGESET_MAX_FILES; i++)
      await writeFile(join(wt.path, "many", `${i}.txt`), `${i}\n`);
    const err = await failure(buildChangeset(wt.path, wt.gitDir, wt.baseSha));
    expect(err.reason).toBe("changeset_too_large");
    expect(err.details).toEqual({ files: CHANGESET_MAX_FILES + 1, maxFiles: CHANGESET_MAX_FILES });
  });

  it("fails changeset_too_large above CHANGESET_MAX_BYTES in total", async () => {
    const wt = await worktree();
    await writeFile(join(wt.path, "a.bin"), Buffer.alloc(CHANGESET_MAX_BYTES / 2, 1));
    await writeFile(join(wt.path, "b.bin"), Buffer.alloc(CHANGESET_MAX_BYTES / 2 + 1, 2));
    const err = await failure(buildChangeset(wt.path, wt.gitDir, wt.baseSha));
    expect(err.reason).toBe("changeset_too_large");
  });

  it("refuses an embedded git repository (gitlink) and paths the contract rejects", async () => {
    const wt = await worktree();
    const nested = join(wt.path, "vendor");
    git(["init", "-q", nested]);
    await writeFile(join(nested, "x"), "x\n");
    git(["-C", nested, "add", "."]);
    git(["-C", nested, "commit", "-q", "-m", "x"]);
    expect((await failure(buildChangeset(wt.path, wt.gitDir, wt.baseSha))).details).toEqual({
      path: "vendor",
      mode: "160000",
    });

    await rm(nested, { recursive: true });
    await writeFile(join(wt.path, "back\\slash"), "x\n");
    const err = await failure(buildChangeset(wt.path, wt.gitDir, wt.baseSha));
    expect(err).toMatchObject({ reason: "changeset_invalid", details: { path: "back\\slash" } });
  });
});

describe("nested repositories planted in the worktree", () => {
  // A worktree whose base commit has a gitlink at `link`, and a repo whose HEAD is that gitlink's commit.
  async function withGitlink(link = "sub") {
    const seed = join(data, "seed");
    git(["init", "-q", "-b", "main", seed]);
    await writeFile(join(seed, "f"), "a\n");
    git(["-C", seed, "add", "f"]);
    git(["-C", seed, "commit", "-q", "-m", "seed"]);
    const oid = git(["-C", seed, "rev-parse", "HEAD"]);

    const src = join(data, "src");
    git(["init", "-q", "-b", "main", src]);
    await writeFile(join(src, "README.md"), "hello\n");
    git(["-C", src, "add", "."]);
    git(["-C", src, "update-index", "--add", "--cacheinfo", `160000,${oid},${link}`]);
    git(["-C", src, "commit", "-q", "-m", "base"]);
    const mirror = join(data, "repos", "acme", "demo.git");
    git(["clone", "-q", "--mirror", src, mirror]);
    const wt = await createWorkspaces(data).prepareWorktree({
      jobId: randomUUID(),
      mirrorPath: mirror,
      baseRef: "main",
      branch: "nexus/t",
    });
    const baseSha = git(["-C", mirror, "rev-parse", "main"]);
    return { ...wt, baseSha, seed, gitDir: await worktreeGitDir(wt.path) };
  }

  /** What an agent can write: a `.git` at `dir` whose config has a filter that runs a command, and a dirty file. */
  async function plant(seed: string, dir: string, marker: string) {
    await mkdir(dir, { recursive: true });
    await cp(join(seed, ".git"), join(dir, ".git"), { recursive: true });
    await writeFile(
      join(dir, ".git", "config"),
      `[core]\n\trepositoryformatversion = 0\n[filter "x"]\n\tclean = "touch ${marker}; cat"\n\trequired = true\n`,
    );
    await writeFile(join(dir, ".git", "info", "attributes"), "* filter=x\n");
    await writeFile(join(dir, "f"), "changed by the agent\n");
  }

  it("buildChangeset runs nothing from a repo planted at a base gitlink", async () => {
    const r = await withGitlink();
    const marker = join(data, "ran-build");
    await plant(r.seed, join(r.path, "sub"), marker);
    const built = await buildChangeset(r.path, r.gitDir, r.baseSha);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(r.path, "sub", ".git"))).toBe(false);
    expect(built.files).toEqual([]);
  });

  it("collectArtifacts runs nothing from a repo planted at a base gitlink", async () => {
    const r = await withGitlink();
    const marker = join(data, "ran-artifacts");
    await plant(r.seed, join(r.path, "sub"), marker);
    await collectArtifacts(r.path, r.gitDir);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(r.path, "sub", ".git"))).toBe(false);
  });

  it("a repo planted where the base has no gitlink runs nothing and is still refused", async () => {
    const r = await withGitlink();
    const marker = join(data, "ran-new");
    await plant(r.seed, join(r.path, "other"), marker);
    await collectArtifacts(r.path, r.gitDir);
    await expect(buildChangeset(r.path, r.gitDir, r.baseSha)).rejects.toMatchObject({
      reason: "changeset_invalid",
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("removes a planted .git file or symlink without touching what it points at", async () => {
    const r = await withGitlink();
    const outside = join(data, "outside-repo");
    await mkdir(join(outside, "keep"), { recursive: true });
    await symlink(outside, join(r.path, "sub", ".git"));
    await removePlantedRepos(r.path, r.gitDir, r.baseSha);
    expect(() => lstatSync(join(r.path, "sub", ".git"))).toThrow();
    expect(existsSync(join(outside, "keep"))).toBe(true);
  });

  it("runs nothing when the gitlink path itself is a symlink to a planted repo", async () => {
    const r = await withGitlink();
    const marker = join(data, "ran-symlink");
    await plant(r.seed, join(r.path, "inner"), marker);
    await rm(join(r.path, "sub"), { recursive: true });
    await symlink("inner", join(r.path, "sub"));
    await collectArtifacts(r.path, r.gitDir);
    await buildChangeset(r.path, r.gitDir, r.baseSha).catch(() => undefined);
    expect(existsSync(marker)).toBe(false);
  });

  it("never walks through a symlink on the way to a gitlink path", async () => {
    const r = await withGitlink("a/sub");
    const outside = join(data, "outside-tree");
    await mkdir(join(outside, "sub", ".git"), { recursive: true });
    await rm(join(r.path, "a"), { recursive: true });
    await symlink(outside, join(r.path, "a"));
    await removePlantedRepos(r.path, r.gitDir, r.baseSha);
    expect(existsSync(join(outside, "sub", ".git"))).toBe(true);
  });
});
