import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { CHANGESET_MAX_BYTES, CHANGESET_MAX_FILES, ChangesetFile } from "@nexus/contracts";
import { GIT_ENV, git } from "./workspace.ts";

// ENG-07: the agent's work as an UploadChangesetRequest file list, built host-side from the worktree vs baseSha.

/** `tree`: the git tree of base + changes (exactly what would be pushed), for the verification checkout. */
export type Changeset = { files: ChangesetFile[]; stats: { added: number; removed: number }; tree: string };

export class ChangesetError extends Error {
  readonly reason: "changeset_too_large" | "changeset_invalid";
  readonly details: Record<string, unknown>;
  constructor(reason: ChangesetError["reason"], message: string, details: Record<string, unknown>) {
    super(message);
    this.reason = reason;
    this.details = details;
  }
}

const MODES = new Set(["100644", "100755", "120000"]);

/**
 * Stages the whole worktree into a throwaway index (tracked, untracked minus .gitignore'd, deletions;
 * never `.git`) and diffs it against `baseSha`. `gitDir` must be the one resolved *before* the run
 * (worktreeGitDir): the worktree's own `.git` file is agent-controlled. Renames come out as delete + add,
 * symlinks as 120000 (content = target), executables as 100755, everything base64.
 */
export async function buildChangeset(
  worktreePath: string,
  gitDir: string,
  baseSha: string,
): Promise<Changeset> {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error("invalid base sha");
  const tmp = await mkdtemp(join(tmpdir(), "nexus-index-"));
  const env = { GIT_INDEX_FILE: join(tmp, "index") };
  // Trusted git dir, no repo-controlled config or hooks; modes and symlinks recorded as on disk.
  const base = [
    `--git-dir=${gitDir}`,
    `--work-tree=${worktreePath}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${devNull}`,
    "-c",
    "core.fileMode=true",
    "-c",
    "core.symlinks=true",
  ];
  const g = (args: string[]) => git([...base, ...args], { env, timeoutMs: 300_000 });
  try {
    await g(["read-tree", baseSha]);
    await g(["add", "--all", "--", "."]);
    // `:<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0` per entry.
    const raw = (await g(["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", baseSha])).split(
      "\0",
    );
    const entries: { meta: string[]; path: string }[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2)
      entries.push({ meta: (raw[i] ?? "").slice(1).split(" "), path: raw[i + 1] ?? "" });
    if (entries.length > CHANGESET_MAX_FILES)
      throw new ChangesetError("changeset_too_large", `${entries.length} changed files`, {
        files: entries.length,
        maxFiles: CHANGESET_MAX_FILES,
      });

    const files: ChangesetFile[] = [];
    let bytes = 0;
    for (const { meta, path } of entries) {
      const [, mode = "", , sha = "", status = ""] = meta;
      let file: unknown;
      if (status === "D") file = { change: "deleted", path };
      else {
        // 160000: an embedded git repo (gitlink). Never part of a NEXUS changeset.
        if (!MODES.has(mode))
          throw new ChangesetError("changeset_invalid", "unsupported file mode", { path, mode });
        const content = await blob(gitDir, sha, CHANGESET_MAX_BYTES - bytes);
        bytes += content.length;
        file = {
          change: status === "A" ? "added" : "modified",
          path,
          mode,
          contentBase64: content.toString("base64"),
        };
      }
      const parsed = ChangesetFile.safeParse(file);
      if (!parsed.success) throw new ChangesetError("changeset_invalid", "unsafe path", { path });
      files.push(parsed.data);
    }

    let added = 0;
    let removed = 0;
    // `<added>\t<removed>\t<path>\0`; binary files report `-` and count as 0.
    for (const line of (await g(["diff", "--cached", "--numstat", "-z", "--no-renames", baseSha])).split(
      "\0",
    )) {
      const [a, r] = line.split("\t");
      added += Number(a) || 0;
      removed += Number(r) || 0;
    }
    return { files, stats: { added, removed }, tree: await g(["write-tree"]) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Exact bytes of one blob; more than `maxBytes` means the changeset is over its total size cap.
const blob = (gitDir: string, sha: string, maxBytes: number) =>
  new Promise<Buffer>((resolve, reject) =>
    execFile(
      "git",
      [`--git-dir=${gitDir}`, "cat-file", "blob", sha],
      { env: GIT_ENV, encoding: "buffer", maxBuffer: Math.max(maxBytes, 0), timeout: 60_000 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if ((err as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          return reject(
            new ChangesetError("changeset_too_large", "changeset exceeds the size cap", {
              maxBytes: CHANGESET_MAX_BYTES,
            }),
          );
        reject(new Error(`git cat-file blob ${sha}: ${stderr.toString().trim() || err.message}`));
      },
    ),
  );
