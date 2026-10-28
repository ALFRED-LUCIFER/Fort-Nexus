import { z } from "zod";

// PRD §10.2 — early exits (REJECTED, BLOCKED_NEEDS_INFO, EXPIRED) are states; PR_CREATED etc. are outcomes.
export const JobStatus = z.enum([
  "DRAFT",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "QUEUED",
  "PREPARING",
  "RUNNING",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "BLOCKED",
  "BLOCKED_NEEDS_INFO",
  "RECOVERY_REQUIRED",
  "REJECTED",
  "EXPIRED",
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
];

// PRD §11.4 run state machine. Server is the only writer; every transition goes through canTransition.
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  DRAFT: ["VALIDATING"],
  VALIDATING: ["REJECTED", "AWAITING_APPROVAL", "QUEUED", "BLOCKED_NEEDS_INFO"],
  AWAITING_APPROVAL: ["QUEUED", "REJECTED", "EXPIRED", "RUNNING", "CANCELLED"],
  QUEUED: ["PREPARING", "CANCELLED"],
  PREPARING: ["RUNNING", "BLOCKED", "CANCELLED", "RECOVERY_REQUIRED", "FAILED"],
  RUNNING: ["VERIFYING", "AWAITING_APPROVAL", "RECOVERY_REQUIRED", "CANCELLED", "FAILED"],
  VERIFYING: ["COMPLETED", "FAILED", "RECOVERY_REQUIRED", "CANCELLED"],
  BLOCKED: ["QUEUED", "CANCELLED"],
  BLOCKED_NEEDS_INFO: ["VALIDATING", "CANCELLED"],
  RECOVERY_REQUIRED: ["QUEUED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  REJECTED: [],
  EXPIRED: [],
};

export const canTransition = (from: JobStatus, to: JobStatus): boolean => JOB_TRANSITIONS[from].includes(to);
export const isTerminal = (s: JobStatus): boolean => TERMINAL_JOB_STATUSES.includes(s);

// Typed job types only — never shell text (PRD §13 "Never implement").
// shortcut: P0 spike ships RUNNER_DIAGNOSTIC only; DEV_ISSUE_TO_PR etc. arrive with their adapters (ENG-05..07).
export const JobType = z.enum(["RUNNER_DIAGNOSTIC"]);
export type JobType = z.infer<typeof JobType>;

export const RiskTier = z.enum(["R0", "R1", "R2", "R3"]);
export type RiskTier = z.infer<typeof RiskTier>;

// Runner-side allowlist keys; the runner maps each to a fixed argv, never to a shell string.
export const DIAGNOSTIC_TIMEOUT_MS = 60_000;

export const DiagnosticPreset = z.enum(["host-info", "node-version", "git-version"]);
export type DiagnosticPreset = z.infer<typeof DiagnosticPreset>;

export const CreateJobRequest = z.discriminatedUnion("jobType", [
  z.strictObject({
    jobType: z.literal("RUNNER_DIAGNOSTIC"),
    preset: DiagnosticPreset,
    runnerId: z.uuid().optional(),
  }),
]);
export type CreateJobRequest = z.infer<typeof CreateJobRequest>;

export const JobOutcome = z.enum([
  "COMMAND_SUCCEEDED",
  "COMMAND_FAILED",
  "TIMED_OUT",
  "PR_CREATED",
  "FAILED_TESTS",
  "COMPLETED_NO_CHANGES",
]);
export type JobOutcome = z.infer<typeof JobOutcome>;

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IdempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const Job = z.object({
  id: z.uuid(),
  jobType: JobType,
  status: JobStatus,
  riskTier: RiskTier,
  request: CreateJobRequest,
  runnerId: z.uuid().nullable(),
  outcome: JobOutcome.nullable(),
  stateVersion: z.int().nonnegative(),
  lastEventSequence: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Job = z.infer<typeof Job>;

export const CreateJobResponse = z.object({
  jobId: z.uuid(),
  status: JobStatus,
  streamUrl: z.string(),
});
export type CreateJobResponse = z.infer<typeof CreateJobResponse>;

export const ListJobsQuery = z.object({
  status: JobStatus.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListJobsQuery = z.infer<typeof ListJobsQuery>;

export const JobList = z.object({ items: z.array(Job), nextCursor: z.string().nullable() });
export type JobList = z.infer<typeof JobList>;
