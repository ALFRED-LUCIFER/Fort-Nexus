import { setTimeout as sleep } from "node:timers/promises";
import {
  REMOTE_ACCESS_REPORT_INTERVAL_MS,
  RUNNER_HEARTBEAT_INTERVAL_MS,
  RUNNER_LEASE_TTL_MS,
  type RemoteAccessReport,
} from "@nexus/contracts";
import { isAuthError, type Lease, type RunnerApi } from "./api.ts";
import { errorMessage, log as defaultLog } from "./log.ts";
import { startJob, type JobHandle, type JobOptions } from "./run.ts";

export type RunnerOptions = JobOptions & {
  heartbeatMs?: number;
  leaseTtlMs?: number;
  /** Omitted: this runner reports nothing about remote access. */
  collectRemoteAccess?: (signal: AbortSignal) => Promise<RemoteAccessReport>;
  remoteAccessMs?: number;
};

const AUTH_REJECTED = "runner token rejected (revoked?); pair this runner again";

// Heartbeat loop + long-poll lease loop with capacity 1. `stop()` stops leasing, reports the
// active job as FAILED { reason: "runner_shutdown" } and resolves once everything has wound down.
export function startRunner(api: RunnerApi, opts: RunnerOptions = {}) {
  const {
    heartbeatMs = RUNNER_HEARTBEAT_INTERVAL_MS,
    leaseTtlMs = RUNNER_LEASE_TTL_MS,
    remoteAccessMs = REMOTE_ACCESS_REPORT_INTERVAL_MS,
    collectRemoteAccess,
    log = defaultLog,
  } = opts;
  const stopping = new AbortController(); // stops leasing
  const idle = new AbortController(); // stops heartbeats once the last job is reported
  let job: JobHandle | undefined;
  let lastBeat = Date.now();
  let fatal: Error | undefined;
  let remoteAccess: RemoteAccessReport | undefined; // collected, not yet sent

  const halt = (err?: Error) => {
    fatal ??= err;
    stopping.abort();
    job?.shutdown();
  };

  const beat = async () => {
    // Taken whether or not this beat lands: a report is never retried, so it can't keep failing the beats that hold
    // job leases. The next collection replaces a lost one, well inside REMOTE_ACCESS_STALE_AFTER_MS.
    const report = remoteAccess;
    remoteAccess = undefined;
    try {
      const { cancelJobIds } = await api.heartbeat(
        { activeJobIds: job ? [job.jobId] : [], ...(report ? { remoteAccess: report } : {}) },
        idle.signal,
      );
      lastBeat = Date.now();
      if (job && cancelJobIds.includes(job.jobId)) job.cancel();
    } catch (err) {
      if (idle.signal.aborted) return;
      if (isAuthError(err)) return halt(new Error(AUTH_REJECTED));
      log("warn", "heartbeat failed", { error: errorMessage(err) });
    }
  };

  // The server expires the lease after leaseTtlMs without heartbeats; the child must not outlive it.
  const watchdog = setInterval(
    () => {
      if (job && Date.now() - lastBeat > leaseTtlMs) job.abandon("heartbeat_lost");
    },
    Math.min(1_000, heartbeatMs),
  );

  const heartbeats = (async () => {
    while (!idle.signal.aborted) {
      await beat();
      await sleep(heartbeatMs, undefined, { signal: idle.signal }).catch(() => {});
    }
  })();

  // Its own loop, so a slow Tailscale can never hold up a heartbeat. The beat just picks up whatever is ready.
  const reporting = (async () => {
    while (collectRemoteAccess && !stopping.signal.aborted) {
      const report = await collectRemoteAccess(stopping.signal).catch(() => undefined);
      // A collection cut short by shutdown says nothing about Tailscale.
      if (report && !stopping.signal.aborted) remoteAccess = report;
      await sleep(remoteAccessMs, undefined, { signal: stopping.signal }).catch(() => {});
    }
  })();

  const leasing = (async () => {
    for (let failures = 0; !stopping.signal.aborted;) {
      let lease: Lease | null;
      try {
        lease = await api.lease(stopping.signal);
        failures = 0;
      } catch (err) {
        if (stopping.signal.aborted) break;
        if (isAuthError(err)) {
          halt(new Error(AUTH_REJECTED));
          break;
        }
        log("warn", "lease failed", { error: errorMessage(err) });
        await sleep(Math.min(500 * 2 ** failures++, 30_000), undefined, { signal: stopping.signal }).catch(
          () => {},
        );
        continue;
      }
      if (!lease) continue;
      lastBeat = Date.now(); // the lease call itself proves the API was reachable
      log("info", "leased job", { jobId: lease.jobId });
      job = startJob(api, lease, opts);
      if (stopping.signal.aborted) job.shutdown();
      await job.done;
      log("info", "job finished", { jobId: lease.jobId });
      job = undefined;
    }
  })();

  const done = (async () => {
    await leasing;
    idle.abort();
    await heartbeats;
    await reporting;
    clearInterval(watchdog);
    if (fatal) throw fatal;
  })();

  return {
    done,
    stop: (): Promise<void> => {
      halt();
      return done;
    },
  };
}
