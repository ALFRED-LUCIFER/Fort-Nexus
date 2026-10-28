import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateJobRequest,
  DIAGNOSTIC_TIMEOUT_MS,
  IssueToPrTask,
  RUNNER_LEASE_TTL_MS,
  type DiagnosticPreset,
  type JobOutcome,
  type RunEventType,
  type RunnerEventInput,
  type RunnerTransition,
} from "@nexus/contracts";
import type { z } from "zod";
import { ApiCallError, withRetry, type Lease, type RunnerApi } from "./api.ts";
import { ChangesetError, buildChangeset } from "./changeset.ts";
import { runClaudeTask, worktreeGitDir } from "./claude.ts";
import { issuePrompt } from "./issue-prompt.ts";
import { errorMessage, log as defaultLog, type Log } from "./log.ts";
import { OutputBuffer, redact, type Stream } from "./output.ts";
import { PRESET_ARGV } from "./presets.ts";
import {
  SANDBOX_BUILD_COMMAND,
  SANDBOX_IMAGE,
  containerName,
  detectRuntime,
  dockerEnv,
  dockerRunArgs,
  imageExists,
  removeContainer,
  type SandboxMode,
} from "./sandbox.ts";
import { runVerification } from "./verify.ts";
import { createWorkspaces, git, withMirrorLock } from "./workspace.ts";

export type JobOptions = {
  timeoutMs?: number;
  killGraceMs?: number;
  flushMs?: number;
  retryForMs?: number;
  log?: Log;
  /** "none" runs presets on the host without isolation: dev/test escape hatch only. */
  sandbox?: SandboxMode;
  image?: string;
  /** Value of the `nexus.runner` container label, used for crash cleanup. */
  runnerLabel?: string;
  /** Bare mirrors and worktrees for coding jobs (RUNNER_DATA_DIR). */
  dataDir?: string;
  /** Provider config for the Claude engine (default ~/.nexus/ai.json). */
  aiConfigFile?: string;
};

type IssueRequest = Extract<CreateJobRequest, { jobType: "DEV_ISSUE_TO_PR" }>;

export type JobHandle = {
  jobId: string;
  done: Promise<void>;
  /** Owner cancel: terminate the child (or the Claude container), confirm exit, report CANCELLED. */
  cancel(): void;
  /** Runner shutdown: terminate the child, report FAILED { reason: "runner_shutdown" }. */
  shutdown(): void;
  /** Lease is gone (stale or heartbeats lost): kill the child and never append again. */
  abandon(reason: string): void;
};

type ExitResult = { exitCode: number | null; signal: NodeJS.Signals | null; error?: string; stuck?: boolean };
type Terminal = "COMPLETED" | "FAILED" | "CANCELLED";

const MAX_EVENTS_PER_APPEND = 200;

const within = (p: Promise<unknown>, ms: number) =>
  new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    void p.then(() => {
      clearTimeout(t);
      resolve(true);
    });
  });

// One leased job: diagnostics run a preset argv, DEV_ISSUE_TO_PR runs the Claude engine and uploads a changeset.
// Both share the event batching, transitions and the cancel/shutdown/lost-lease handling below.
export function startJob(api: RunnerApi, lease: Lease, opts: JobOptions = {}): JobHandle {
  const {
    timeoutMs = DIAGNOSTIC_TIMEOUT_MS,
    killGraceMs = 5_000,
    flushMs = 250,
    retryForMs = RUNNER_LEASE_TTL_MS,
    log = defaultLog,
    sandbox = "docker",
    image = SANDBOX_IMAGE,
    runnerLabel = "local",
    dataDir = join(homedir(), ".nexus"),
    aiConfigFile,
  } = opts;
  const { jobId, fencingToken } = lease;
  const appendAbort = new AbortController();
  // Aborted on cancel, shutdown and a lost lease: stops the Claude container (claude.ts confirms it is gone).
  const stopAbort = new AbortController();
  const output = new OutputBuffer();
  const pending: RunnerEventInput[] = [];
  let phase: "preparing" | "running" | "finishing" = "preparing";
  let stop: "cancel" | "shutdown" | undefined;
  let lost = false;
  let chain = Promise.resolve();
  let flushTimer: NodeJS.Timeout | undefined;
  let child: ChildProcess | undefined;
  let container: string | undefined;
  let exited: Promise<void> = Promise.resolve();
  let terminating: Promise<boolean> | undefined;
  let settle: ((r: ExitResult) => void) | undefined;

  const push = (type: RunEventType, payload: Record<string, unknown>) =>
    pending.push({ occurredAt: new Date().toISOString(), type, stage: null, payload });

  // Buffered output always goes ahead of the next event, so the stream stays in order.
  const event = (type: RunEventType, payload: Record<string, unknown>) => {
    for (const chunk of output.drain(phase !== "running")) push("process.output", chunk);
    push(type, payload);
  };

  const abandon = (reason: string, err?: unknown) => {
    if (lost) return;
    lost = true;
    log("warn", "dropping job", { jobId, reason, ...(err ? { error: errorMessage(err) } : {}) });
    appendAbort.abort();
    stopAbort.abort();
    if (phase === "running") void terminate();
  };

  // Appends are serialised on one chain; any final failure means the lease is no longer ours.
  // One batchId per batch, reused across retries, so the API applies a batch at most once.
  const flush = (transition?: RunnerTransition): Promise<void> => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    for (const chunk of output.drain(phase !== "running")) push("process.output", chunk);
    const events = pending.splice(0);
    if (events.length === 0 && !transition) return chain;
    chain = chain.then(async () => {
      if (lost) return;
      try {
        do {
          const batch = events.splice(0, MAX_EVENTS_PER_APPEND);
          const last = events.length === 0;
          const batchId = randomUUID();
          await withRetry(
            () =>
              api.appendEvents(
                jobId,
                { batchId, fencingToken, events: batch, transition: last ? transition : undefined },
                appendAbort.signal,
              ),
            { forMs: retryForMs, signal: appendAbort.signal },
          );
        } while (events.length > 0);
      } catch (err) {
        abandon(
          err instanceof ApiCallError && err.code === "STALE_LEASE" ? "stale_lease" : "append_failed",
          err,
        );
      }
    });
    return chain;
  };

  // Agent events go out in batches as they arrive, like process output.
  const queue = (type: RunEventType, payload: Record<string, unknown>) => {
    event(type, payload);
    if (pending.length >= MAX_EVENTS_PER_APPEND) void flush();
    else flushTimer ??= setTimeout(() => void flush(), flushMs);
  };

  const finish = async (
    type: RunEventType,
    payload: Record<string, unknown>,
    to: Terminal,
    outcome?: JobOutcome,
  ) => {
    event(type, payload);
    await flush({ to, outcome });
  };

  // SIGTERM, SIGKILL after the grace period, and only report success once the exit is observed.
  // In Docker: stop/kill/remove the container and only succeed once Docker confirms it is gone.
  const terminate = (): Promise<boolean> =>
    (terminating ??= (async () => {
      const c = child;
      if (!c) return true;
      if (container) {
        // Twice: a stop racing `docker run` can find no container yet while the client is still creating it.
        for (let i = 0; i < 2; i++)
          if ((await removeContainer(container, killGraceMs)) && (await within(exited, 5_000))) return true;
        c.kill("SIGKILL"); // never leave the docker client behind
        log("error", "job container could not be confirmed gone", { jobId, container });
        settle?.({ exitCode: null, signal: null, stuck: true });
        return false;
      }
      c.kill("SIGTERM");
      if (await within(exited, killGraceMs)) return true;
      log("warn", "child ignored SIGTERM, sending SIGKILL", { jobId, pid: c.pid });
      c.kill("SIGKILL");
      if (await within(exited, killGraceMs)) return true;
      log("error", "child did not exit after SIGKILL", { jobId, pid: c.pid });
      settle?.({ exitCode: null, signal: null, stuck: true });
      return false;
    })());

  const onOutput = (stream: Stream, text: string) => {
    output.write(stream, text);
    if (output.shouldFlush) void flush();
    else flushTimer ??= setTimeout(() => void flush(), flushMs);
  };

  const execute = (argv: readonly [string, ...string[]], cwd: string) =>
    new Promise<ExitResult>((resolve) => {
      settle = resolve;
      const [cmd, ...args] = container
        ? ["docker", ...dockerRunArgs({ jobId, runnerLabel, workspace: cwd, argv, image })]
        : argv;
      const c = spawn(cmd, args, {
        cwd,
        env: container ? dockerEnv() : { PATH: process.env.PATH ?? "" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = c;
      phase = "running";
      exited = new Promise((res) => c.once("exit", () => res()));
      c.stdout.setEncoding("utf8").on("data", (t: string) => onOutput("stdout", t));
      c.stderr.setEncoding("utf8").on("data", (t: string) => onOutput("stderr", t));
      c.on("error", (err) => {
        if (c.pid !== undefined) return log("warn", "child process error", { jobId, error: err.message });
        phase = "finishing";
        resolve({ exitCode: null, signal: null, error: err.message });
      });
      c.once("close", (exitCode, signal) => {
        phase = "finishing";
        resolve({ exitCode, signal });
      });
    });

  const stopped = (terminated: boolean) =>
    stop === "cancel"
      ? finish("job.cancelled", { terminated }, "CANCELLED")
      : finish("job.failed", { reason: "runner_shutdown" }, "FAILED");

  // Paths and codes only: the task carries the read token, so input values never go into events.
  const invalid = (error: z.ZodError, field: "request" | "task") => {
    log("warn", `leased job has an invalid ${field}, not executing`, { jobId });
    const issues = error.issues.map((i) => ({
      path: [...(field === "task" ? ["task"] : []), ...i.path.map(String)].join("."),
      code: i.code,
    }));
    return finish("job.failed", { reason: "invalid_request", issues }, "FAILED");
  };

  const run = async (): Promise<void> => {
    const parsed = CreateJobRequest.safeParse(lease.request);
    if (!parsed.success) return invalid(parsed.error, "request");
    if (parsed.data.jobType === "RUNNER_DIAGNOSTIC") return runDiagnostic(parsed.data.preset);
    const task = IssueToPrTask.safeParse(lease.task);
    if (!task.success) return invalid(task.error, "task");
    return runIssueToPr(parsed.data, task.data);
  };

  const runDiagnostic = async (preset: DiagnosticPreset): Promise<void> => {
    const argv = PRESET_ARGV[preset];

    let sandboxInfo: Record<string, unknown> = { runtime: "none" };
    if (sandbox === "docker") {
      const runtime = await detectRuntime().catch((err: unknown) => {
        log("error", "docker is not reachable, not executing", { jobId, error: errorMessage(err) });
      });
      if (!runtime)
        return finish(
          "job.failed",
          { reason: "sandbox_unavailable", message: "Docker is not reachable on the runner host" },
          "FAILED",
        );
      // Never fall back to the host: no image, no run.
      if (!(await imageExists(image)))
        return finish(
          "job.failed",
          {
            reason: "sandbox_image_missing",
            image,
            message: `Sandbox image ${image} is missing on the runner host. Build it with: ${SANDBOX_BUILD_COMMAND}`,
          },
          "FAILED",
        );
      container = containerName(jobId);
      sandboxInfo = { runtime, image, container };
    } else {
      log("warn", "RUNNER_SANDBOX=none: running WITHOUT isolation on the host (dev/test only)", { jobId });
    }

    const cwd = await mkdtemp(join(tmpdir(), "nexus-job-"));
    // Diagnostics never write; worktree jobs run as writableUser() (claude.ts) so the container can write them.
    if (container) await chmod(cwd, 0o755);
    let timer: NodeJS.Timeout | undefined;
    try {
      event("workspace.created", { hostname: hostname(), pid: process.pid, cwd, sandbox: sandboxInfo });
      await flush({ to: "RUNNING" });
      if (lost) return;
      if (stop) return stopped(false);

      event("agent.started", { engine: "diagnostic", preset, argv });
      const started = Date.now();
      let timedOut = false;
      timer = setTimeout(() => {
        timedOut = true;
        void terminate();
      }, timeoutMs);
      const result = await execute(argv, cwd);
      // A stop in flight must be confirmed (process exited, container gone) before anything is reported.
      const stopConfirmed = await (terminating ?? true);
      if (lost) return;
      if (result.stuck || !stopConfirmed)
        return finish(
          "job.failed",
          { reason: "stop_failed", pid: child?.pid, ...(container ? { container } : {}) },
          "FAILED",
        );

      event("tool.completed", {
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: Date.now() - started,
        ...(result.error ? { error: result.error } : {}),
      });
      if (stop) return stopped(true);
      await flush({ to: "VERIFYING" });
      if (timedOut) return finish("job.failed", { reason: "timeout", timeoutMs }, "FAILED", "TIMED_OUT");
      if (result.exitCode === 0)
        return finish("job.completed", { exitCode: 0 }, "COMPLETED", "COMMAND_SUCCEEDED");
      // 125: `docker run` itself failed (daemon error, bad mount), not the command inside.
      const reason = result.error
        ? "spawn_failed"
        : container && result.exitCode === 125
          ? "sandbox_failed"
          : "command_failed";
      return finish("job.failed", { reason, exitCode: result.exitCode }, "FAILED", "COMMAND_FAILED");
    } finally {
      clearTimeout(timer);
      clearTimeout(flushTimer);
      // Safety net: --rm normally removed it already, this only confirms (one `docker inspect`).
      if (container && child && !(await removeContainer(container, killGraceMs)))
        log("error", "job container could not be confirmed gone", { jobId, container });
      await rm(cwd, { recursive: true, force: true });
    }
  };

  // ENG-07 spec step 3: fetch → worktree → Claude → changeset → verify (FR-DEV-05) → upload (the API then awaits
  // the owner's approval).
  const runIssueToPr = async (request: IssueRequest, task: IssueToPrTask): Promise<void> => {
    const { snapshot, workBranch } = task;
    const { baseBranch, baseSha } = snapshot;
    // The coding engine never runs on the host, whatever RUNNER_SANDBOX says.
    if (sandbox !== "docker")
      return finish(
        "job.failed",
        {
          reason: "sandbox_required",
          message: "Coding jobs only run in the Docker sandbox (RUNNER_SANDBOX=docker)",
        },
        "FAILED",
      );
    const workspaces = createWorkspaces(dataDir);
    let mirror: string | undefined;
    // A re-leased job id may find its worktree and branch from an earlier attempt: remove both, before and after.
    const cleanup = async () => {
      try {
        await workspaces.removeWorktree(jobId);
        const m = mirror;
        if (m) await withMirrorLock(m, () => git(["-C", m, "update-ref", "-d", `refs/heads/${workBranch}`]));
      } catch (err) {
        log("error", "worktree cleanup failed", { jobId, error: errorMessage(err) });
      }
    };
    try {
      try {
        const fetched = await workspaces.fetchMirror({
          fullName: snapshot.fullName,
          cloneUrl: task.git.cloneUrl,
          token: task.git.token,
          branch: baseBranch,
          sha: baseSha,
        });
        mirror = fetched.mirror;
        if (!fetched.hasSha)
          return finish("job.failed", { reason: "base_sha_missing", baseBranch, baseSha }, "FAILED");
      } catch (err) {
        // fetchMirror already masks the token; redact() is the generic second pass.
        return finish("job.failed", { reason: "fetch_failed", message: redact(errorMessage(err)) }, "FAILED");
      }
      // shortcut: a cancel waits for an in-flight fetch (≤ 10 min), pass an AbortSignal to git if that bites.
      if (stop) return stopped(false);
      let worktreePath: string;
      let gitDir: string;
      try {
        await cleanup();
        ({ path: worktreePath } = await workspaces.prepareWorktree({
          jobId,
          mirrorPath: mirror,
          baseRef: baseSha,
          branch: workBranch,
        }));
        // Resolved before the run: afterwards the worktree's .git file is agent-controlled.
        gitDir = await worktreeGitDir(worktreePath);
      } catch (err) {
        return finish(
          "job.failed",
          { reason: "workspace_failed", message: redact(errorMessage(err)) },
          "FAILED",
        );
      }

      event("workspace.created", {
        hostname: hostname(),
        pid: process.pid,
        cwd: worktreePath,
        repository: snapshot.fullName,
        issueNumber: snapshot.issueNumber,
        baseBranch,
        baseSha,
        workBranch,
      });
      await flush({ to: "RUNNING" });
      if (lost) return;
      if (stop) return stopped(false);

      phase = "running";
      let agentSummary = "";
      const result = await runClaudeTask({
        jobId,
        worktreePath,
        prompt: issuePrompt(snapshot),
        budget: {
          maxWallClockMs: request.budget.maxWallClockMinutes * 60_000,
          maxTurns: request.budget.maxTurns,
          maxCostUsd: request.budget.maxCostUsd,
        },
        onEvent: (type, payload) => {
          if (type === "agent.message" && payload.kind === "summary" && typeof payload.text === "string")
            agentSummary = payload.text;
          queue(type, payload);
        },
        signal: stopAbort.signal,
        runnerLabel,
        image,
        killGraceMs,
        log,
        ...(aiConfigFile ? { aiConfigFile } : {}),
      });
      phase = "finishing";
      if (lost) return;
      // Never report a stop (or anything else) while the container may still be writing to the worktree.
      if (result.reason === "stop_failed")
        return finish("job.failed", { reason: "stop_failed", ...result.details }, "FAILED");
      if (stop || result.status === "STOPPED") return stopped(true);
      if (result.status === "FAILED")
        return finish(
          "job.failed",
          { reason: result.reason, ...result.details },
          "FAILED",
          result.outcome ?? (result.reason === "budget_exceeded" ? "BUDGET_EXCEEDED" : undefined),
        );

      await flush({ to: "VERIFYING" });
      if (lost) return;
      let changeset;
      try {
        changeset = await buildChangeset(worktreePath, gitDir, baseSha);
      } catch (err) {
        return err instanceof ChangesetError
          ? finish("job.failed", { reason: err.reason, ...err.details }, "FAILED")
          : finish(
              "job.failed",
              { reason: "changeset_failed", message: redact(errorMessage(err)) },
              "FAILED",
            );
      }
      if (changeset.files.length === 0)
        return finish("job.completed", { changes: 0 }, "COMPLETED", "COMPLETED_NO_CHANGES");

      // FR-DEV-05: the repo's tests on exactly base + changeset, in a fresh sandbox. A failed result doesn't
      // block the upload (the owner decides), but a stop does.
      phase = "running";
      const verified = await runVerification({
        jobId,
        gitDir,
        baseSha,
        tree: changeset.tree,
        onEvent: queue,
        signal: stopAbort.signal,
        runnerLabel,
        image,
        killGraceMs,
        log,
      });
      phase = "finishing";
      if (lost) return;
      if (!verified.stopConfirmed)
        return finish("job.failed", { reason: "stop_failed", container: containerName(jobId) }, "FAILED");
      if (stop || verified.stopped) return stopped(true);
      const { verification } = verified;
      event("test.completed", verification);
      await flush();
      if (lost) return;

      const { files, stats } = changeset;
      try {
        await withRetry(
          () =>
            api.uploadChangeset(
              jobId,
              {
                fencingToken,
                baseSha,
                files,
                stats,
                agentSummary: agentSummary.slice(0, 4_000),
                verification,
              },
              appendAbort.signal,
            ),
          { forMs: retryForMs, signal: appendAbort.signal },
        );
      } catch (err) {
        if (err instanceof ApiCallError && err.code === "STALE_LEASE") return abandon("stale_lease", err);
        if (lost) return;
        log("error", "changeset upload failed", { jobId, error: errorMessage(err) });
        const code = err instanceof ApiCallError ? err.code : "ERROR";
        return finish("job.failed", { reason: "changeset_upload_failed", code }, "FAILED");
      }
      // The API moved the job to AWAITING_APPROVAL and released the lease: nothing more to append.
      log("info", "changeset uploaded, awaiting approval", {
        jobId,
        files: files.length,
        verification: verification.status,
      });
    } finally {
      clearTimeout(flushTimer);
      await cleanup();
    }
  };

  const done = run().catch(async (err: unknown) => {
    log("error", "job crashed", { jobId, error: errorMessage(err) });
    if (phase === "running") await terminate();
    await finish("job.failed", { reason: "runner_error" }, "FAILED");
  });

  const requestStop = (kind: "cancel" | "shutdown") => {
    if (stop || lost || phase === "finishing") return;
    stop = kind;
    stopAbort.abort();
    if (phase === "running") void terminate();
  };

  return {
    jobId,
    done,
    cancel: () => requestStop("cancel"),
    shutdown: () => requestStop("shutdown"),
    abandon: (reason) => abandon(reason),
  };
}
