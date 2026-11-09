import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangesetFile } from "@nexus/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChangeset } from "./changeset.ts";
import { worktreeGitDir } from "./claude.ts";
import { applyStoredFiles, restoreTree, treeDiff } from "./repair-adapter.ts";
import { bareRepo, git } from "./test-support.ts";
import { createWorkspaces } from "./workspace.ts";

const JOB = "6f1c1d3e-8a4b-4c1e-9f00-00000000aaaa";
const b64 = (t: string) => Buffer.from(t).toString("base64");

let data = "";
let path = "";
let gitDir = "";
let baseSha = "";

beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), "nexus-adapter-"));
  const mirror = await bareRepo(join(data, "repos"), "acme", "demo", "main", {
    ".gitignore": "node_modules\n",
    "keep.txt": "keep\n",
    "old.txt": "old\n",
  });
  baseSha = git(["-C", mirror, "rev-parse", "main"]);
  const wt = await createWorkspaces(data).prepareWorktree({
    jobId: JOB,
    mirrorPath: mirror,
    baseRef: baseSha,
    branch: "nexus/t",
  });
  path = wt.path;
  gitDir = await worktreeGitDir(path);
});
afterEach(() => rm(data, { recursive: true, force: true }));

const treeOf = async () => (await buildChangeset(path, gitDir, baseSha)).tree;

describe("applyStoredFiles", () => {
  it("applies additions, edits, deletions, modes and symlinks exactly as stored", async () => {
    const files: ChangesetFile[] = [
      { change: "added", path: "src/deep/new.txt", mode: "100755", contentBase64: b64("new\n") },
      { change: "modified", path: "keep.txt", mode: "100644", contentBase64: b64("edited\n") },
      { change: "added", path: "link", mode: "120000", contentBase64: b64("../outside") },
      { change: "deleted", path: "old.txt" },
    ];
    await applyStoredFiles(path, gitDir, baseSha, files);

    expect(readFileSync(join(path, "src/deep/new.txt"), "utf8")).toBe("new\n");
    expect(lstatSync(join(path, "src/deep/new.txt")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("edited\n");
    expect(lstatSync(join(path, "link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(path, "link"))).toBe("../outside");
    expect(existsSync(join(path, "old.txt"))).toBe(false);
    const built = await buildChangeset(path, gitDir, baseSha);
    expect(built.files.map((f) => f.path).sort()).toEqual(
      ["keep.txt", "link", "old.txt", "src/deep/new.txt"].sort(),
    );
  });

  it("never writes through a symlink that points out of the worktree", async () => {
    const outside = join(data, "outside");
    await mkdir(outside);
    await symlink(outside, join(path, "escape"));
    await applyStoredFiles(path, gitDir, baseSha, [
      { change: "added", path: "escape/pwned.txt", mode: "100644", contentBase64: b64("x") },
    ]);
    expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
    expect(lstatSync(join(path, "escape")).isDirectory()).toBe(true);
    expect(readFileSync(join(path, "escape/pwned.txt"), "utf8")).toBe("x");
  });

  it("rejects a path git itself would never accept, leaving the worktree at the base", async () => {
    const before = await treeOf();
    await expect(
      applyStoredFiles(path, gitDir, baseSha, [
        { change: "added", path: "sub/.git/config", mode: "100644", contentBase64: b64("x") },
      ]),
    ).rejects.toThrow();
    expect(await treeOf()).toBe(before);
    expect(existsSync(join(path, "sub"))).toBe(false);
  });

  it("replaces a directory with a file, even though the addition sorts before the deletion", async () => {
    await mkdir(join(path, "a"));
    await writeFile(join(path, "a/b"), "nested\n");
    await writeFile(join(path, "a/c"), "nested\n");
    const mirror = join(data, "repos", "acme", "demo.git");
    git(["-C", mirror, "--work-tree", path, "add", "a"]);
    const tree = git(["-C", mirror, "write-tree"]);
    const base = git(["-C", mirror, "commit-tree", tree, "-p", baseSha, "-m", "dir"]);
    await rm(join(path, "a"), { recursive: true });
    await restoreTree(path, gitDir, tree);

    await applyStoredFiles(path, gitDir, base, [
      { change: "added", path: "a", mode: "100644", contentBase64: b64("now a file\n") },
      { change: "deleted", path: "a/b" },
      { change: "deleted", path: "a/c" },
    ]);

    expect(lstatSync(join(path, "a")).isFile()).toBe(true);
    expect(readFileSync(join(path, "a"), "utf8")).toBe("now a file\n");
  });

  it("does nothing for an answered question (no files)", async () => {
    const before = await treeOf();
    await applyStoredFiles(path, gitDir, baseSha, []);
    expect(await treeOf()).toBe(before);
  });
});

describe("restoreTree", () => {
  it("puts the exact tree back: later edits undone, later files gone, ignored install output kept", async () => {
    await writeFile(join(path, "keep.txt"), "round 1\n");
    const earlier = await treeOf();

    await writeFile(join(path, "keep.txt"), "round 2\n");
    await mkdir(join(path, "later/dir"), { recursive: true });
    await writeFile(join(path, "later/dir/file.txt"), "later\n");
    await mkdir(join(path, "node_modules/dep"), { recursive: true });
    await writeFile(join(path, "node_modules/dep/index.js"), "installed\n");
    expect(await treeOf()).not.toBe(earlier);

    await restoreTree(path, gitDir, earlier);

    expect(await treeOf()).toBe(earlier);
    expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("round 1\n");
    expect(existsSync(join(path, "later"))).toBe(false);
    expect(readFileSync(join(path, "node_modules/dep/index.js"), "utf8")).toBe("installed\n");
  });

  it("replaces a symlink an earlier round planted, without following it", async () => {
    await writeFile(join(path, "keep.txt"), "round 1\n");
    const earlier = await treeOf();
    const outside = join(data, "outside-restore");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "untouched\n");
    await rm(join(path, "keep.txt"));
    await symlink(join(outside, "keep.txt"), join(path, "keep.txt"));

    await restoreTree(path, gitDir, earlier);

    expect(lstatSync(join(path, "keep.txt")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("round 1\n");
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("untouched\n");
  });
});

describe("treeDiff", () => {
  it("diffs the given tree against the base, whatever the worktree holds now", async () => {
    await writeFile(join(path, "keep.txt"), "reviewed\n");
    const reviewed = await treeOf();
    await writeFile(join(path, "keep.txt"), "later\n");
    const diff = await treeDiff(gitDir, baseSha, reviewed);
    expect(diff).toContain("+reviewed");
    expect(diff).not.toContain("later");
  });
});
