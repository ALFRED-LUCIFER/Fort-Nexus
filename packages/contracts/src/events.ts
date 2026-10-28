import { z } from "zod";
import { JobOutcome, JobStatus } from "./jobs.ts";

// PRD §13.4 event types, plus process.output for redacted stdout/stderr excerpts (FR-RUN-05).
export const RunEventType = z.enum([
  "job.created",
  "job.state.changed",
  "worker.heartbeat",
  "workspace.created",
  "agent.started",
  "agent.message",
  "process.output",
  "tool.requested",
  "tool.denied",
  "tool.completed",
  "approval.requested",
  "approval.decided",
  "test.completed",
  "artifact.created",
  "external_action.completed",
  "job.completed",
  "job.failed",
  "job.cancelled",
  "job.recovery_required",
]);
export type RunEventType = z.infer<typeof RunEventType>;

// Matches the design's run stages: Qualify → Plan → Implement → Test → Review → Draft PR.
export const RunStage = z.enum(["qualify", "plan", "implement", "test", "review", "publish"]);
export type RunStage = z.infer<typeof RunStage>;

export const RunEvent = z.object({
  eventId: z.uuid(),
  jobId: z.uuid(),
  sequence: z.int().positive(),
  occurredAt: z.iso.datetime(),
  type: RunEventType,
  stage: RunStage.nullable(),
  actor: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()),
});
export type RunEvent = z.infer<typeof RunEvent>;

// What a runner submits; the API assigns eventId, sequence and actor.
export const RunnerEventInput = z.strictObject({
  occurredAt: z.iso.datetime(),
  type: RunEventType,
  stage: RunStage.nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type RunnerEventInput = z.infer<typeof RunnerEventInput>;

// Runners may only drive execution-phase transitions; the API validates with canTransition + fencing token.
export const RunnerTransition = z.strictObject({
  to: JobStatus.extract(["RUNNING", "VERIFYING", "COMPLETED", "FAILED", "CANCELLED", "BLOCKED"]),
  outcome: JobOutcome.optional(),
});
export type RunnerTransition = z.infer<typeof RunnerTransition>;

// Events are recorded in the order given, then the transition (and its job.state.changed) last.
// batchId makes retries safe: a batch the API already applied returns the current state without re-appending.
export const AppendEventsRequest = z.strictObject({
  batchId: z.uuid(),
  fencingToken: z.int().positive(),
  events: z.array(RunnerEventInput).max(200),
  transition: RunnerTransition.optional(),
});
export type AppendEventsRequest = z.infer<typeof AppendEventsRequest>;

export const AppendEventsResponse = z.object({ lastSequence: z.int().nonnegative(), status: JobStatus });
export type AppendEventsResponse = z.infer<typeof AppendEventsResponse>;

// SSE: `id:` = sequence, `event:` = "run-event", `data:` = RunEvent JSON. Clients resume with Last-Event-ID or ?afterSequence=.
export const SSE_RUN_EVENT = "run-event";
export const JobEventsQuery = z.object({ afterSequence: z.coerce.number().int().nonnegative().optional() });
