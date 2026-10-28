import { z } from "zod";
import { CreateJobRequest } from "./jobs.ts";

export const RUNNER_HEARTBEAT_INTERVAL_MS = 5_000;
export const RUNNER_STALE_AFTER_MS = 15_000;
export const RUNNER_OFFLINE_AFTER_MS = 60_000;
export const RUNNER_LEASE_TTL_MS = 30_000;
export const RUNNER_LEASE_POLL_MS = 25_000;

export const RunnerStatus = z.enum(["ONLINE", "STALE", "OFFLINE", "REVOKED"]);
export type RunnerStatus = z.infer<typeof RunnerStatus>;

export const runnerStatus = (
  lastHeartbeatAt: Date | null,
  revoked: boolean,
  now = new Date(),
): RunnerStatus => {
  if (revoked) return "REVOKED";
  if (!lastHeartbeatAt) return "OFFLINE";
  const age = now.getTime() - lastHeartbeatAt.getTime();
  return age <= RUNNER_STALE_AFTER_MS ? "ONLINE" : age <= RUNNER_OFFLINE_AFTER_MS ? "STALE" : "OFFLINE";
};

export const Runner = z.object({
  id: z.uuid(),
  name: z.string(),
  os: z.string(),
  version: z.string(),
  capacity: z.int().positive(),
  status: RunnerStatus,
  lastHeartbeatAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Runner = z.infer<typeof Runner>;

export const RunnerList = z.object({ items: z.array(Runner) });
export type RunnerList = z.infer<typeof RunnerList>;

export const PairingCodeResponse = z.object({ code: z.string(), expiresAt: z.iso.datetime() });
export type PairingCodeResponse = z.infer<typeof PairingCodeResponse>;

export const RunnerRegisterRequest = z.strictObject({
  code: z.string().min(6).max(64),
  name: z.string().min(1).max(64),
  os: z.string().min(1).max(64),
  version: z.string().min(1).max(32),
  capacity: z.int().min(1).max(8).default(1),
});
export type RunnerRegisterRequest = z.infer<typeof RunnerRegisterRequest>;

// token is shown once; the API stores only its hash.
export const RunnerRegisterResponse = z.object({ runnerId: z.uuid(), token: z.string() });
export type RunnerRegisterResponse = z.infer<typeof RunnerRegisterResponse>;

export const HeartbeatRequest = z.strictObject({ activeJobIds: z.array(z.uuid()).max(16) });
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({ cancelJobIds: z.array(z.uuid()) });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

// 200 with a lease, or 204 when nothing is queued within RUNNER_LEASE_POLL_MS.
export const LeaseResponse = z.object({
  jobId: z.uuid(),
  request: CreateJobRequest,
  fencingToken: z.int().positive(),
  leaseExpiresAt: z.iso.datetime(),
});
export type LeaseResponse = z.infer<typeof LeaseResponse>;
