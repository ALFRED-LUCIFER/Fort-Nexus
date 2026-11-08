import { z } from "zod";
import { AgentKey } from "./agent-key.ts";
import { RepoId } from "./github.ts";
import { Job, type JobStatus } from "./jobs.ts";

// Jobs wave: every job with its evidence (FR-OBS-03/04), and per-agent results from source records only.
// Nothing here comes from model text: tests from NEXUS's own verification, PRs from GitHub's response.

// Status groups the Jobs page filters by; each status is in exactly one group.
export const JobStatusGroup = z.enum(["ACTIVE", "NEEDS_YOU", "SUCCEEDED", "FAILED", "CANCELLED"]);
export type JobStatusGroup = z.infer<typeof JobStatusGroup>;

export const JOB_STATUS_GROUPS: Readonly<Record<JobStatusGroup, readonly JobStatus[]>> = {
  ACTIVE: ["DRAFT", "VALIDATING", "QUEUED", "PREPARING", "RUNNING", "VERIFYING"],
  NEEDS_YOU: ["AWAITING_APPROVAL", "BLOCKED", "BLOCKED_NEEDS_INFO", "RECOVERY_REQUIRED"],
  SUCCEEDED: ["COMPLETED"],
  FAILED: ["FAILED", "REJECTED", "EXPIRED"],
  CANCELLED: ["CANCELLED"],
};

// The latest verification NEXUS ran for the job (Verification.status), or null when none ran.
export const JobTests = z.enum(["passed", "failed", "not_configured", "error"]);
export type JobTests = z.infer<typeof JobTests>;

export const JobHistoryItem = z.object({
  job: Job,
  // DEV_ISSUE_TO_PR: the pinned repository; null for diagnostics.
  repositoryId: RepoId.nullable(),
  repositoryFullName: z.string().nullable(),
  // finishedAt − startedAt; null until both exist.
  durationMs: z.int().nonnegative().nullable(),
  tests: JobTests.nullable(),
  // Only from an EXECUTED approval's GitHub result (truth hierarchy).
  pullRequest: z.object({ number: z.int().positive(), url: z.url() }).nullable(),
  // The latest push/PR approval of the job, if any.
  approval: z
    .object({
      id: z.uuid(),
      status: z.enum(["PENDING", "APPROVED", "DENIED", "EXPIRED", "EXECUTED", "FAILED"]),
    })
    .nullable(),
});
export type JobHistoryItem = z.infer<typeof JobHistoryItem>;

// GET /v1/jobs/history — newest first, keyset-paged by job id.
export const JobHistoryQuery = z.object({
  // Omitted = owner-wide aggregate (the read-only "All" view).
  projectId: z.uuid().optional(),
  repositoryId: RepoId.optional(),
  agent: AgentKey.optional(),
  status: JobStatusGroup.optional(),
  // Inclusive local dates (owner timezone) on createdAt.
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type JobHistoryQuery = z.infer<typeof JobHistoryQuery>;

export const JobHistoryList = z.object({
  items: z.array(JobHistoryItem),
  nextCursor: z.uuid().nullable(),
});
export type JobHistoryList = z.infer<typeof JobHistoryList>;

// GET /v1/agents/performance — the last `days` local days, ending today (owner timezone).
export const AgentPerformanceQuery = z.object({
  projectId: z.uuid().optional(),
  days: z.coerce
    .number()
    .int()
    .refine((d) => d === 7 || d === 30, "days must be 7 or 30")
    .default(7),
});
export type AgentPerformanceQuery = z.infer<typeof AgentPerformanceQuery>;

export const AgentPerformanceRow = z.object({
  agent: AgentKey,
  // Jobs created in the window.
  jobs: z.int().nonnegative(),
  // Of those, how many ended in each group so far (the rest are still active or waiting on the owner).
  succeeded: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  cancelled: z.int().nonnegative(),
  // succeeded / (succeeded + failed); null when neither happened. Cancelled jobs don't count either way.
  successRate: z.number().min(0).max(1).nullable(),
  // Draft PRs GitHub confirmed (EXECUTED approvals) for the window's jobs.
  pullRequests: z.int().nonnegative(),
  // Estimates, not invoices (FR-OBS-03): the jobs' estimatedCostUsd plus the agent's ai_spend in the window
  // (cost once settled, else the reservation, as the daily budget counts it); each ledger source belongs to one agent.
  costUsd: z.number().nonnegative(),
  costPerPullRequestUsd: z.number().nonnegative().nullable(),
  // Median of job created → its first push/PR approval created ("review-ready"); null without any.
  medianMinutesToReviewReady: z.number().nonnegative().nullable(),
  // Owner decisions on the window's approvals.
  approvals: z.object({
    approved: z.int().nonnegative(),
    denied: z.int().nonnegative(),
    expired: z.int().nonnegative(),
    pending: z.int().nonnegative(),
  }),
});
export type AgentPerformanceRow = z.infer<typeof AgentPerformanceRow>;

export const AgentPerformance = z.object({
  days: z.union([z.literal(7), z.literal(30)]),
  from: z.iso.date(),
  to: z.iso.date(),
  // Every AgentKey, in AgentKey order, zeros included, so the UI never guesses a missing row.
  items: z.array(AgentPerformanceRow),
  asOf: z.iso.datetime(),
});
export type AgentPerformance = z.infer<typeof AgentPerformance>;
