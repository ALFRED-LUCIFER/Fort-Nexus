import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { buildChangeset } from "./changeset.ts";
import { errorMessage, log as defaultLog, type Log } from "./log.ts";
import { redact } from "./output.ts";
import {
  SANDBOX_IMAGE,
  containerName,
  detectRuntime,
  egressNames,
  imageExists,
  removeContainer,
  startEgress,
  stopEgress,
  writableUser,
} from "./sandbox.ts";
import { readVerifyPlan, runStep } from "./verify.ts";
import { git } from "./workspace.ts";

// Before the first round NEXUS installs the repo's packages in a separate container, with the same limited registry
// access verification has, using the install command from the BASE commit. The agent's container then finds them in
// the worktree and can run the tests; its own network stays limited to the model provider.

const REASON_MAX = 300;
const KEEP_CHARS = 2_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

export type PrepareDepsOptions = {
  jobId: string;
  /** The worktree's trusted git dir (resolved before the agent ran). */
  gitDir: string;
  baseSha: string;
  worktreePath: string;
  /** Package-manager caches, kept across jobs; mounted at /workspace/cache. */
  cacheDir: string;
  image?: string;
  runnerLabel?: string;
  signal?: AbortSignal;
  killGraceMs?: number;
  log?: Log;
  /** Test seam: where the egress proxy's own traffic leaves (default Docker's "bridge"). */
  egressNetwork?: string;
  /** Test seam: caps the plan's timeout. */
  maxTimeoutMs?: number;
};

/** `stopFailed`: Docker could not confirm the install container is gone, so nothing else may start. */
export type PrepareDepsResult = { ok: boolean; reason: string | null; stopFailed?: true };

/** Removes everything git would pick up from the worktree, through the trusted git dir and no repo-controlled config. */
async function restoreWorktree(worktreePath: string, gitDir: string, baseSha: string) {
  const g = (args: string[]) =>
    git(
      [
        `--git-dir=${gitDir}`,
        `--work-tree=${worktreePath}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${devNull}`,
        ...args,
      ],
      { timeoutMs: 300_000 },
    );
  await g(["restore", `--source=${baseSha}`, "--worktree", "--", "."]);
  await g(["clean", "-ffd", "--", "."]); // -ff: nested git repos too
}

/** Never throws. ok:true with no reason also covers "the plan has no install step". */
export async function prepareDeps(opts: PrepareDepsOptions): Promise<PrepareDepsResult> {
  const { jobId, gitDir, baseSha, worktreePath, cacheDir, signal } = opts;
  const { image = SANDBOX_IMAGE, runnerLabel = "local", killGraceMs = DEFAULT_KILL_GRACE_MS } = opts;
  const { log = defaultLog, egressNetwork, maxTimeoutMs = Infinity } = opts;
  const fail = (why: string): PrepareDepsResult => ({ ok: false, reason: redact(why).slice(0, REASON_MAX) });
  let dir: string | undefined;
  let egress = false;
  let stopConfirmed = true;
  const container = containerName(jobId);
  let result: PrepareDepsResult;
  try {
    const plan = await readVerifyPlan(gitDir, baseSha);
    if (!plan?.install) return { ok: true, reason: null };
    const runtime = await detectRuntime().catch(() => undefined);
    if (!runtime) return fail("Docker is not reachable on the runner host");
    if (!(await imageExists(image))) return fail(`sandbox image ${image} is missing`);
    // repo and cache are bind-mounted over these, so Docker never creates root-owned mountpoints in our directory.
    const workspace = (dir = await mkdtemp(join(tmpdir(), "nexus-deps-")));
    for (const sub of ["repo", "cache", "tmp"]) await mkdir(join(workspace, sub));
    if (signal?.aborted) result = fail("stopped");
    else {
      if (plan.egress.length) {
        egress = true;
        await startEgress({
          jobId,
          runnerLabel,
          allowHosts: plan.egress,
          image,
          ...(egressNetwork ? { egressNetwork } : {}),
        });
      }
      let output = "";
      const timeoutMs = Math.min(plan.timeoutMs, maxTimeoutMs);
      const s = await runStep(
        {
          jobId,
          runnerLabel,
          image,
          killGraceMs,
          deadline: Date.now() + timeoutMs,
          ...(signal ? { signal } : {}),
          ...(egress ? { network: egressNames(jobId).network } : {}),
          onOutput: (t) => {
            output = (output + t).slice(-KEEP_CHARS);
          },
        },
        plan.install,
        writableUser(runtime),
        workspace,
        [
          { source: worktreePath, target: "/workspace/repo" },
          { source: cacheDir, target: "/workspace/cache" },
        ],
      );
      const tail = redact(output).trim().slice(-200);
      if (s.stuck) {
        stopConfirmed = false;
        result = fail("the install container could not be stopped");
      } else if (s.aborted) result = fail("stopped");
      else if (s.timedOut) result = fail(`install timed out after ${Math.round(timeoutMs / 1000)} s`);
      else if (s.error) result = fail(`could not start docker: ${s.error}`);
      else if (s.exitCode !== 0)
        result = fail(`install failed with exit code ${s.exitCode ?? "none"}${tail ? `: ${tail}` : ""}`);
      else result = { ok: true, reason: null };
    }
  } catch (err) {
    log("warn", "dependency install could not run", { jobId, error: errorMessage(err) });
    result = fail(`dependency install could not run: ${errorMessage(err)}`);
  }
  if (!(await removeContainer(container, killGraceMs))) stopConfirmed = false;
  if (!stopConfirmed) {
    log("error", "install container could not be confirmed gone", { jobId, container });
    return { ...fail("the install container could not be stopped"), stopFailed: true };
  }
  if (egress) {
    const { removed } = await stopEgress(jobId);
    if (!removed) log("error", "install egress proxy or network could not be removed", { jobId });
  }
  if (dir)
    await rm(dir, { recursive: true, force: true }).catch((err: unknown) =>
      log("warn", "install dir cleanup failed", { jobId, error: errorMessage(err) }),
    );
  if (!result.ok) {
    await restoreWorktree(worktreePath, gitDir, baseSha).catch((err: unknown) =>
      log("warn", "worktree restore failed", { jobId, error: errorMessage(err) }),
    );
    return result;
  }
  // Nothing before the agent may change what git sees: an empty changeset is the only correct state.
  try {
    if ((await buildChangeset(worktreePath, gitDir, baseSha)).files.length === 0) return result;
    await restoreWorktree(worktreePath, gitDir, baseSha);
    const left = (await buildChangeset(worktreePath, gitDir, baseSha)).files.length;
    return fail(
      `the install created files git would pick up (add node_modules to .gitignore); removed them${left ? `, but ${left} remain` : ""}`,
    );
  } catch (err) {
    return fail(`could not check the worktree after install: ${errorMessage(err)}`);
  }
}
