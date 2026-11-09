import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { devNull } from "node:os";
import { join, sep } from "node:path";
import { redact } from "./output.ts";

// Git worktree manager (FR-RUN-03, DEC-08): one bare mirror per repo, one worktree per job.
// Layout under the data dir: repos/<owner>/<name>.git (bare mirrors), work/<jobId> (worktrees).

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO_PART = /^(?!\.{1,2}$)[\w.-]{1,100}$/; // GitHub owner/repo charset; never "." or ".."
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PROTECTED = new Set(["main", "master", "trunk", "develop", "production", "gh-pages", "head"]);

export type Worktree = { path: string; branch: string; baseSha: string };

// Host-side git on mirrors we own: no user/system config (hooks, filters, credential helpers), no prompts.
export const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: "0",
};

export type GitOptions = {
  /** Extra env on top of GIT_ENV (e.g. GIT_CONFIG_* or GIT_INDEX_FILE). */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** Exact values masked in the error message. */
  secrets?: readonly string[];
  /** Largest stdout accepted, in bytes (default Node's 1 MiB). */
  maxBuffer?: number;
  /** Return stdout exactly as git wrote it (default: trimmed). */
  raw?: boolean;
};

export const git = (args: string[], opts: GitOptions = {}) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      "git",
      args,
      {
        env: { ...GIT_ENV, ...opts.env },
        timeout: opts.timeoutMs ?? 120_000,
        ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}),
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(opts.raw ? stdout : stdout.trim());
        const msg = `git ${args.join(" ")}: ${stderr.trim() || err.message}`;
        reject(new Error(redact((opts.secrets ?? []).reduce((t, s) => t.replaceAll(s, "[REDACTED]"), msg))));
      },
    ),
  );

const TREE_LIST_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Removes any `.git` at a path `baseRef` records as a gitlink. For such a path git starts a child `git status` inside
 * the directory, and that child obeys the nested repo's own config, so a repo planted there runs its commands on the
 * host. Run before any host git reads the worktree, and only once no container can still write to it.
 */
export async function removePlantedRepos(
  worktreePath: string,
  gitDir: string,
  baseRef: string,
): Promise<void> {
  const listed = await git(
    [`--git-dir=${gitDir}`, "-c", `core.hooksPath=${devNull}`, "ls-tree", "-r", "-z", baseRef],
    { timeoutMs: 300_000, maxBuffer: TREE_LIST_MAX_BUFFER },
  );
  for (const entry of listed.split("\0")) {
    const path = /^160000 commit [0-9a-f]+\t(.+)$/s.exec(entry)?.[1];
    if (!path) continue;
    const parts = path.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) continue;
    let dir: string | undefined = worktreePath;
    for (const part of parts) {
      dir = join(dir, part);
      // lstat: a symlink is not a directory, so the walk ends there rather than following it.
      if (!(await lstat(dir).catch(() => undefined))?.isDirectory()) {
        dir = undefined;
        break;
      }
    }
    if (dir) await rm(join(dir, ".git"), { recursive: true, force: true });
  }
}

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
    await mkdir(join(dataDir, "deps-cache"), { recursive: true, mode: 0o700 });
    const root = await realpath(dataDir);
    return {
      repos: await resolveInside(root, join(root, "repos"), "repos dir"),
      work: await resolveInside(root, join(root, "work"), "work dir"),
      depsCache: await resolveInside(root, join(root, "deps-cache"), "deps cache dir"),
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

  /**
   * Fetches `branch` from `cloneUrl` into the bare mirror repos/<owner>/<name>.git (created on first use) and
   * reports whether `sha` is now present. The token goes in as an env-only http.extraHeader: never in argv,
   * never in the mirror's config, masked in errors.
   */
  async function fetchMirror(opts: {
    fullName: string;
    cloneUrl: string;
    token: string;
    branch: string;
    sha: string;
  }): Promise<{ mirror: string; hasSha: boolean }> {
    const { token, branch, sha } = opts;
    const [owner = "", name = "", ...rest] = opts.fullName.split("/");
    if (rest.length) throw new Error("invalid repository owner/name");
    const url = new URL(opts.cloneUrl);
    // Plain http would send the token in clear text: loopback only (tests).
    const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
    if (!secure || url.username || url.password)
      throw new Error("cloneUrl must be https without credentials");
    if (branch.startsWith("-")) throw new Error("invalid base branch");
    await git(["check-ref-format", `refs/heads/${branch}`]);
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("invalid base sha");
    const { repos } = await roots();
    const path = mirrorPath(owner, name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const mirror = await resolveInside(repos, path, "mirror");

    return withMirrorLock(mirror, async () => {
      if (!existsSync(join(mirror, "HEAD"))) await git(["init", "--quiet", "--bare", mirror]);
      const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
      await git(
        [
          "-C",
          mirror,
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          "--end-of-options",
          url.href,
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ],
        {
          env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: header },
          // shortcut: one 10 min cap for first clones too, make it configurable if large repos hit it.
          timeoutMs: 600_000,
          secrets: [token, header.slice("Authorization: Basic ".length)],
        },
      );
      const hasSha = await git(["-C", mirror, "cat-file", "-e", `${sha}^{commit}`]).then(
        () => true,
        () => false,
      );
      return { mirror, hasSha };
    });
  }

  /** An empty package-manager cache for this job, deleted with its worktree. */
  async function prepareDepsCache(jobId: string): Promise<string> {
    assertJobId(jobId);
    const path = join((await roots()).depsCache, jobId);
    await rm(path, { recursive: true, force: true });
    await mkdir(path);
    return path;
  }

  /** Deletes work/<jobId>, its dependency cache and its registration in the owning mirror. The branch stays in the mirror. */
  async function removeWorktree(jobId: string): Promise<void> {
    assertJobId(jobId);
    const { repos, work, depsCache } = await roots();
    // Never run git inside the worktree: after a run its content, including the .git pointer file, is untrusted.
    await rm(join(work, jobId), { recursive: true, force: true });
    for (const owner of await readdir(repos))
      for (const name of await readdir(join(repos, owner)).catch(() => [] as string[])) {
        const mirror = await resolveInside(repos, join(repos, owner, name), "mirror").catch(() => undefined);
        if (mirror && existsSync(join(mirror, "worktrees", jobId)))
          await withMirrorLock(mirror, () => git(["-C", mirror, "worktree", "prune"]));
      }
    await rm(join(depsCache, jobId), { recursive: true, force: true });
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

  return { mirrorPath, fetchMirror, prepareWorktree, prepareDepsCache, removeWorktree, pruneStale };
}
