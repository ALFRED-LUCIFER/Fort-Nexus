import { z } from "zod";
import { AgentKey, type AgentTool } from "./agents.ts";
import { SourceRef } from "./conversations.ts";
import { CreateJobRequest } from "./jobs.ts";

// EPIC AGT FR-AGT-01 (Chief of Staff planner) + FR-AGT-09 (handoff contracts), PRD §11.7. The model drafts a typed plan;
// the owner approves its exact hash; steps run only through existing typed paths, one at a time; a step succeeds only
// on its source event, never on agent prose.

export const PlanStepAction = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("jobs.create"), request: CreateJobRequest }),
  z.strictObject({ type: z.literal("research.run"), watchlistId: z.uuid() }),
  z.strictObject({
    type: z.literal("business.sales_summary"),
    connectorId: z.uuid(),
    day: z.union([z.enum(["today", "yesterday"]), z.iso.date()]),
  }),
]);
export type PlanStepAction = z.infer<typeof PlanStepAction>;

/** The registry tool a step needs; the step's agent must have it in its effective profile. */
export const toolForAction = (a: PlanStepAction): AgentTool =>
  a.type === "research.run"
    ? "research.run"
    : a.type === "business.sales_summary"
      ? "business.metrics"
      : a.request.jobType === "DEV_ISSUE_TO_PR"
        ? "jobs.create.issue_run"
        : "jobs.create.diagnostic";

export const MAX_PLAN_STEPS = 8;

export const PlanStepStatus = z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED"]);
export type PlanStepStatus = z.infer<typeof PlanStepStatus>;

// FR-AGT-09: what a finished step hands on. Built by the server from the source record only.
export const StepArtifact = z.object({
  kind: z.enum(["job", "research_run", "metric"]),
  id: z.string(),
  evidence: z.array(SourceRef).min(1),
  verifiedAt: z.iso.datetime({ offset: true }),
});
export type StepArtifact = z.infer<typeof StepArtifact>;

export const PlanStep = z.object({
  index: z.int().nonnegative(),
  title: z.string().max(200),
  agent: AgentKey,
  action: PlanStepAction,
  // Indices of earlier steps only (so no cycles); a failed dependency skips this step.
  dependsOn: z.array(z.int().nonnegative()),
  status: PlanStepStatus,
  // Why the step can't run as drafted (agent lacks the tool, autonomy SUGGEST/DRAFT, unknown target…); a plan with
  // any blocked step can't be approved.
  blockedReason: z.string().nullable(),
  artifact: StepArtifact.nullable(),
  error: z.string().nullable(),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const PlanStatus = z.enum([
  "DRAFT",
  "APPROVED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "DENIED",
  "CANCELLED",
]);
export type PlanStatus = z.infer<typeof PlanStatus>;

export const Plan = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  goal: z.string(),
  status: PlanStatus,
  steps: z.array(PlanStep).max(MAX_PLAN_STEPS),
  // sha256 of the canonical steps (index, title, agent, action, dependsOn), computed by the server only.
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  // The Chief of Staff profile version the plan was drafted under (FR-WKS-05).
  profileVersionId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Plan = z.infer<typeof Plan>;

export const PlanList = z.object({ items: z.array(Plan) });
export type PlanList = z.infer<typeof PlanList>;

// POST /v1/plans — Idempotency-Key required (drafting calls the model).
export const CreatePlanRequest = z.strictObject({
  projectId: z.uuid(),
  goal: z.string().trim().min(1).max(2000),
});
export type CreatePlanRequest = z.infer<typeof CreatePlanRequest>;

// POST /v1/plans/:id/decision
export const PlanDecisionRequest = z.strictObject({
  decision: z.enum(["approve", "deny"]),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PlanDecisionRequest = z.infer<typeof PlanDecisionRequest>;
