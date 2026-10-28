import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateJobRequest,
  DIAGNOSTIC_TIMEOUT_MS,
  RUNNER_LEASE_TTL_MS,
  type JobOutcome,
  type RunEventType,
  type RunnerEventInput,
  type RunnerTransition,
} from "@nexus/contracts";
import { ApiCallError, withRetry, type Lease, type RunnerApi } from "./api.ts";
import { errorMessage, log as defaultLog, type Log } from "./log.ts";
import { OutputBuffer, type Stream } from "./output.ts";
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
};

export type JobHandle = {
  jobId: string;
  done: Promise<void>;
  /** Owner cancel: terminate the child, confirm exit, report CANCELLED. */
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

// shortcut: no ExecutionAdapter interface yet: the Claude engine (claude.ts) is not dispatched by job type until ENG-07, add it then.
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
  } = opts;
  const { jobId, fencingToken } = lease;
  const appendAbort = new AbortController();
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

  const run = async (): Promise<void> => {
    const parsed = CreateJobRequest.safeParse(lease.request);
    if (!parsed.success) {
      log("warn", "leased job has an invalid request, not executing", { jobId });
      const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), code: i.code }));
      return finish("job.failed", { reason: "invalid_request", issues }, "FAILED");
    }
    const { preset } = parsed.data;
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

  const done = run().catch(async (err: unknown) => {
    log("error", "job crashed", { jobId, error: errorMessage(err) });
    if (phase === "running") await terminate();
    await finish("job.failed", { reason: "runner_error" }, "FAILED");
  });

  const requestStop = (kind: "cancel" | "shutdown") => {
    if (stop || lost || phase === "finishing") return;
    stop = kind;
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
