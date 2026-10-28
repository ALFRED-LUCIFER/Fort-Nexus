import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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

export type JobOptions = {
  timeoutMs?: number;
  killGraceMs?: number;
  flushMs?: number;
  retryForMs?: number;
  log?: Log;
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

// shortcut: no container/worktree isolation yet (presets touch no repository), ENG-04 adds it before any repo code runs.
// shortcut: no ExecutionAdapter interface yet, it arrives with the Claude Agent SDK adapter (ENG-05).
export function startJob(api: RunnerApi, lease: Lease, opts: JobOptions = {}): JobHandle {
  const {
    timeoutMs = DIAGNOSTIC_TIMEOUT_MS,
    killGraceMs = 5_000,
    flushMs = 250,
    retryForMs = RUNNER_LEASE_TTL_MS,
    log = defaultLog,
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
  const terminate = (): Promise<boolean> =>
    (terminating ??= (async () => {
      const c = child;
      if (!c) return true;
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
      const [cmd, ...args] = argv;
      const c = spawn(cmd, args, {
        cwd,
        env: { PATH: process.env.PATH ?? "" },
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
    const cwd = await mkdtemp(join(tmpdir(), "nexus-job-"));
    let timer: NodeJS.Timeout | undefined;
    try {
      event("workspace.created", { hostname: hostname(), pid: process.pid, cwd });
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
      if (lost) return;
      if (result.stuck) return finish("job.failed", { reason: "stop_failed", pid: child?.pid }, "FAILED");

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
      const reason = result.error ? "spawn_failed" : "command_failed";
      return finish("job.failed", { reason, exitCode: result.exitCode }, "FAILED", "COMMAND_FAILED");
    } finally {
      clearTimeout(timer);
      clearTimeout(flushTimer);
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
