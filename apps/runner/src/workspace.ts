import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { devNull } from "node:os";
import { join, sep } from "node:path";

// Git worktree manager (FR-RUN-03, DEC-08): one bare mirror per repo, one worktree per job.
// Layout under the data dir: repos/<owner>/<name>.git (bare mirrors), work/<jobId> (worktrees).

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO_PART = /^(?!\.{1,2}$)[\w.-]{1,100}$/; // GitHub owner/repo charset; never "." or ".."
const PROTECTED = new Set(["main", "master", "trunk", "develop", "production", "gh-pages", "head"]);

export type Worktree = { path: string; branch: string; baseSha: string };

// Host-side git on mirrors we own: no user/system config (hooks, filters, credential helpers), no prompts.
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: "0",
};

export const git = (args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile("git", args, { env: GIT_ENV, timeout: 120_000 }, (err, stdout, stderr) =>
      err
        ? reject(new Error(`git ${args.join(" ")}: ${stderr.trim() || err.message}`))
        : resolve(stdout.trim()),
    ),
  );

const inside = (root: string, p: string) => p === root || p.startsWith(root + sep);

/** Realpath of `p`, which must exist and resolve (after symlinks) inside `root`. */
async function resolveInside(root: string, p: string, what: string): Promise<string> {
  const real = await realpath(p);
  if (!inside(root, real)) throw new Error(`${what} resolves outside ${root}`);
  return real;
}

const assertJobId = (jobId: string) => {
  if (!JOB_ID.test(jobId)) throw new Error("jobId must be a uuid");
};

// shortcut: in-process lock only (one runner process per data dir), upgrade to a lock file if several processes share one.
const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` once every earlier call for the same mirror has settled (OPS-G05). */
export function withMirrorLock<T>(mirror: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(mirror) ?? Promise.resolve()).then(fn);
  const tail = next.catch(() => {});
  locks.set(mirror, tail);
  void tail.then(() => locks.get(mirror) === tail && locks.delete(mirror));
  return next;
}

export function createWorkspaces(dataDir: string) {
  // Resolved on every call, so a directory swapped for a symlink later is still caught.
  const roots = async () => {
    await mkdir(join(dataDir, "repos"), { recursive: true, mode: 0o700 });
    await mkdir(join(dataDir, "work"), { recursive: true, mode: 0o700 });
    const root = await realpath(dataDir);
    return {
      repos: await resolveInside(root, join(root, "repos"), "repos dir"),
      work: await resolveInside(root, join(root, "work"), "work dir"),
    };
  };

  const mirrorPath = (owner: string, name: string): string => {
    if (!REPO_PART.test(owner) || !REPO_PART.test(name)) throw new Error("invalid repository owner/name");
    return join(dataDir, "repos", owner, `${name}.git`);
  };

  /** Creates work/<jobId> on a new branch `branch` from `baseRef` of the bare mirror. */
  async function prepareWorktree(opts: {
    jobId: string;
    mirrorPath: string;
    baseRef: string;
    branch: string;
  }): Promise<Worktree> {
    const { jobId, baseRef, branch } = opts;
    assertJobId(jobId);
    if (branch.startsWith("-") || PROTECTED.has(branch.toLowerCase()) || /^release\//i.test(branch))
      throw new Error(`refusing to use protected branch "${branch}" as the work branch`);
    await git(["check-ref-format", `refs/heads/${branch}`]);
    const { repos, work } = await roots();
    const mirror = await resolveInside(repos, opts.mirrorPath, "mirror");
    if (mirror === repos || !mirror.endsWith(".git"))
      throw new Error("mirror must be repos/<owner>/<name>.git");
    const path = join(work, jobId);

    return withMirrorLock(mirror, async () => {
      const head = await git(["-C", mirror, "symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
      if (head && branch.toLowerCase() === head.toLowerCase())
        throw new Error(`refusing to use the default branch "${branch}" as the work branch`);
      const baseSha = await git([
        "-C",
        mirror,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${baseRef}^{commit}`,
      ]);
      await git([
        "-C",
        mirror,
        "-c",
        `core.hooksPath=${devNull}`,
        "worktree",
        "add",
        "-b",
        branch,
        path,
        baseSha,
      ]);
      return { path, branch, baseSha };
    });
  }

  /** Deletes work/<jobId> and its registration in the owning mirror. The branch stays in the mirror. */
  async function removeWorktree(jobId: string): Promise<void> {
    assertJobId(jobId);
    const { repos, work } = await roots();
    // Never run git inside the worktree: after a run its content, including the .git pointer file, is untrusted.
    await rm(join(work, jobId), { recursive: true, force: true });
    for (const owner of await readdir(repos))
      for (const name of await readdir(join(repos, owner)).catch(() => [] as string[])) {
        const mirror = await resolveInside(repos, join(repos, owner, name), "mirror").catch(() => undefined);
        if (mirror && existsSync(join(mirror, "worktrees", jobId)))
          await withMirrorLock(mirror, () => git(["-C", mirror, "worktree", "prune"]));
      }
  }

  /**
   * Removes worktrees whose directory was last modified more than `olderThanMs` ago. Pass a value well
   * above the longest allowed run: an active job that only touches nested files keeps an old mtime.
   */
  async function pruneStale(olderThanMs: number): Promise<string[]> {
    const { work } = await roots();
    const cutoff = Date.now() - olderThanMs;
    const removed: string[] = [];
    for (const name of await readdir(work)) {
      if (!JOB_ID.test(name) || (await lstat(join(work, name))).mtimeMs >= cutoff) continue;
      await removeWorktree(name);
      removed.push(name);
    }
    return removed;
  }

  return { mirrorPath, prepareWorktree, removeWorktree, pruneStale };
}
