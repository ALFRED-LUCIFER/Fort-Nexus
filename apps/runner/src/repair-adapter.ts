import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangesetFile, IssueSnapshot, QaReview } from "@nexus/contracts";
import { parsePhaseLine } from "./agent-result.ts";
import { buildChangeset } from "./changeset.ts";
import { runClaudeTask, type EmitEvent } from "./claude.ts";
import { errorMessage, type Log } from "./log.ts";
import { redact } from "./output.ts";
import { runQaReview } from "./qa.ts";
import { checkIntegrity } from "./repair/integrity.ts";
import { agentStatement } from "./repair-loop.ts";
import type { ClaimedFeedback, LoopDeps } from "./repair-loop-types.ts";
import { containerName } from "./sandbox.ts";
import { runVerification, treeWithTestsOnly } from "./verify.ts";
import { git } from "./workspace.ts";

// The repair loop's dependencies on the real runner: sandboxed agent, QA and test runs, and git through the trusted
// git dir (resolved before any agent ran), so nothing repo-controlled decides what these commands do.

const DIFF_MAX_BUFFER = 64 * 1024 * 1024; // a changeset is at most 10 MB of content; its diff a few times that
const QA_REASON_MAX = 500;

/** Runs `fn` with a git that has a throwaway index, on `gitDir` and (when given) with `worktreePath` as the work tree. */
async function withScratchIndex<T>(
  gitDir: string,
  worktreePath: string | null,
  fn: (g: (args: string[]) => Promise<string>, tmp: string) => Promise<T>,
): Promise<T> {
  const tmp = await mkdtemp(join(tmpdir(), "nexus-index-"));
  const g = (args: string[]) =>
    git(
      [
        `--git-dir=${gitDir}`,
        ...(worktreePath ? [`--work-tree=${worktreePath}`] : []),
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${devNull}`,
        "-c",
        "core.symlinks=true",
        ...args,
      ],
      { env: { GIT_INDEX_FILE: join(tmp, "index") }, timeoutMs: 300_000 },
    );
  try {
    return await fn(g, tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Makes the worktree hold exactly `tree`: every file written, everything else git would pick up removed. Ignored
 * files (the installed packages) stay. git replaces a symlink in the way rather than following it.
 */
export const restoreTree = (worktreePath: string, gitDir: string, tree: string): Promise<void> =>
  withScratchIndex(gitDir, worktreePath, async (g) => {
    await g(["read-tree", tree]);
    await g(["checkout-index", "--all", "--force"]);
    await g(["clean", "-ffdq", "--", "."]);
  });

/**
 * Applies a stored changeset onto the worktree at `baseSha`. The files become a git tree first, so no path is ever
 * opened by hand. Their paths passed the ChangesetFile schema with the lease, and git's own path check refuses the
 * rest (a nested `.git`, say) before the worktree changes.
 */
export async function applyStoredFiles(
  worktreePath: string,
  gitDir: string,
  baseSha: string,
  files: readonly ChangesetFile[],
): Promise<void> {
  if (files.length === 0) return;
  const tree = await withScratchIndex(gitDir, null, async (g, tmp) => {
    await g(["read-tree", baseSha]);
    const blob = join(tmp, "blob");
    // Deletions first: a file can replace a directory whose files sort after it.
    for (const f of files)
      if (f.change === "deleted") await g(["update-index", "--force-remove", "--", f.path]);
    for (const f of files) {
      if (f.change === "deleted") continue;
      await writeFile(blob, Buffer.from(f.contentBase64, "base64"));
      const sha = await g(["hash-object", "-w", "--no-filters", "--", blob]);
      await g(["update-index", "--add", "--cacheinfo", `${f.mode},${sha},${f.path}`]);
    }
    return g(["write-tree"]);
  });
  await restoreTree(worktreePath, gitDir, tree);
}

/** The change under review as a unified diff: `tree` against the base, whatever the worktree holds now. */
export const treeDiff = (gitDir: string, baseSha: string, tree: string): Promise<string> =>
  git(
    [
      `--git-dir=${gitDir}`,
      "-c",
      `core.hooksPath=${devNull}`,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      baseSha,
      tree,
    ],
    { timeoutMs: 120_000, maxBuffer: DIFF_MAX_BUFFER },
  );

/** A file's exact text at the base commit, null when the base has no such file. Git errors are not "no such file". */
async function baseFile(gitDir: string, baseSha: string, path: string): Promise<string | null> {
  const listed = await git([
    `--git-dir=${gitDir}`,
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    baseSha,
    "--",
    path,
  ]);
  const sha = /^(?:100644|100755|120000) blob ([0-9a-f]{40})\t/.exec(listed)?.[1];
  if (!sha) return null;
  return git([`--git-dir=${gitDir}`, "cat-file", "blob", sha], { raw: true, maxBuffer: DIFF_MAX_BUFFER });
}

export type RepairAdapterOptions = {
  jobId: string;
  worktreePath: string;
  gitDir: string;
  issue: IssueSnapshot;
  /** Epoch ms when the job's wall clock runs out. */
  deadline: number;
  depsCache: string;
  model?: string | undefined;
  signal: AbortSignal;
  /** Aborts everything still running in the job. */
  abort: () => void;
  event: EmitEvent;
  /** Reports the job's state, once, and waits until the API has it. */
  enter: (state: "RUNNING" | "VERIFYING") => Promise<void>;
  claimFeedback: (round: number) => Promise<ClaimedFeedback[]>;
  runnerLabel: string;
  image: string;
  killGraceMs: number;
  log: Log;
  aiConfigFile?: string | undefined;
};

export function createRepairAdapter(o: RepairAdapterOptions) {
  const { jobId, worktreePath, gitDir, issue, signal, event, enter } = o;
  const { baseSha } = issue;
  const sandbox = { runnerLabel: o.runnerLabel, image: o.image, killGraceMs: o.killGraceMs, log: o.log };
  const agentConfig = {
    ...sandbox,
    ...(o.model ? { model: o.model } : {}),
    ...(o.aiConfigFile ? { aiConfigFile: o.aiConfigFile } : {}),
  };

  let stopFailure: Record<string, unknown> | undefined;
  // A container that may still be running: nothing else may start, and the job ends stop_failed.
  const stopFailed = (details: Record<string, unknown>) => {
    stopFailure ??= details;
    o.abort();
  };

  let round = 0;
  const phasesSeen = new Set<string>();
  const emitPhase = (phase: { phase: string; text: string }, inRound: number) => {
    const key = JSON.stringify([inRound, phase.phase, phase.text]);
    if (phasesSeen.has(key)) return;
    phasesSeen.add(key);
    event("phase.completed", { ...phase, round: inRound });
  };

  // What the agent said about each tree, because the tree uploaded can be earlier than the last round.
  let lastSummary = "";
  const summaries = new Map<string, string>();

  const deps: LoopDeps = {
    async runAgent(prompt, budget) {
      await enter("RUNNING");
      lastSummary = "";
      const run = await runClaudeTask({
        ...agentConfig,
        jobId,
        worktreePath,
        gitDir,
        prompt,
        budget,
        depsCache: o.depsCache,
        signal,
        onEvent: (type, payload) => {
          event(type, payload);
          if (type !== "agent.message" || typeof payload.text !== "string") return;
          if (payload.kind === "summary") lastSummary = agentStatement(payload.text) ?? "";
          for (const line of payload.text.split("\n")) {
            const phase = parsePhaseLine(line);
            if (phase) emitPhase(phase, round);
          }
        },
      });
      if (run.reason === "stop_failed") stopFailed(run.details ?? {});
      return {
        status: run.status,
        reason: run.reason,
        details: run.details,
        outcome: run.outcome,
        finalText: run.finalText,
        costUsd: run.summary?.estimatedCostUsd ?? 0,
        turns: run.summary?.turns ?? 0,
      };
    },

    async buildChangeset() {
      const changeset = await buildChangeset(worktreePath, gitDir, baseSha);
      summaries.set(changeset.tree, lastSummary);
      return changeset;
    },

    async verify(tree, only) {
      await enter("VERIFYING");
      const { verification, stopped, stopConfirmed } = await runVerification({
        ...sandbox,
        jobId,
        gitDir,
        baseSha,
        tree,
        onEvent: event,
        signal,
        maxMs: o.deadline - Date.now(),
        ...(only ? { only } : {}),
      });
      if (!stopConfirmed) stopFailed({ container: containerName(jobId) });
      else if (!stopped) event("test.completed", { ...verification, ...(only ? { only } : {}) });
      return verification;
    },

    redTree: (tree, testPaths) => treeWithTestsOnly(gitDir, baseSha, tree, testPaths),

    checkIntegrity: (files) => checkIntegrity(files, (path) => baseFile(gitDir, baseSha, path)),

    async runQa(tree, budget) {
      await enter("VERIFYING");
      let diff: string;
      try {
        if ((await buildChangeset(worktreePath, gitDir, baseSha)).tree !== tree) {
          await restoreTree(worktreePath, gitDir, tree);
          if ((await buildChangeset(worktreePath, gitDir, baseSha)).tree !== tree)
            throw new Error("the worktree could not be restored to the tree under review");
        }
        diff = await treeDiff(gitDir, baseSha, tree);
      } catch (err) {
        const reason = redact(`The review could not start: ${errorMessage(err)}`).slice(0, QA_REASON_MAX);
        const review: QaReview = { status: "could_not_run", verdict: null, defects: [], reason };
        return { review, costUsd: 0, turns: 0 };
      }
      const run = await runQaReview({
        ...agentConfig,
        jobId,
        worktreePath,
        issue,
        diff,
        gitDir,
        baseSha,
        budget,
        signal,
        onEvent: event,
      });
      if (run.fatal?.reason === "stop_failed") stopFailed(run.fatal.details);
      return run;
    },

    claimFeedback: (r) => o.claimFeedback(r),

    event(type, payload) {
      if (type === "loop.round.started" && typeof payload.round === "number") round = payload.round;
      if (type === "phase.completed" && typeof payload.round === "number") {
        emitPhase({ phase: String(payload.phase), text: String(payload.text) }, payload.round);
        return;
      }
      event(type, payload);
    },

    signal,
    now: Date.now,
  };

  return {
    deps,
    /** Set when a container could not be confirmed gone: the job must end stop_failed, whatever the loop returned. */
    stopFailure: () => stopFailure,
    summaryOf: (tree: string) => summaries.get(tree) ?? "",
  };
}
