import { z } from "zod";
import { CreateJobRequest, IdempotencyKey, JobType } from "./jobs.ts";

// EPIC AUTO (FR-AUTO-02/03/05/07/08, AUTO-G01..G03). n8n is glue, never a source of truth: it can only send signed,
// typed triggers for the actions its client allows, inside one project. No shell text exists anywhere in this API.

export const AutomationAction = z.enum(["research.run", "jobs.create"]);
export type AutomationAction = z.infer<typeof AutomationAction>;

export const CreateAutomationClientRequest = z.strictObject({
  projectId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  allowedActions: z.array(AutomationAction).min(1),
  // Only used with "jobs.create"; empty = no job types.
  allowedJobTypes: z.array(JobType).default([]),
  rateLimitPerMinute: z.int().min(1).max(60).default(10),
});
export type CreateAutomationClientRequest = z.infer<typeof CreateAutomationClientRequest>;

export const UpdateAutomationClientRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    allowedActions: z.array(AutomationAction).min(1),
    allowedJobTypes: z.array(JobType),
    rateLimitPerMinute: z.int().min(1).max(60),
    disabled: z.boolean(),
  })
  .partial()
  .refine((u) => Object.keys(u).length > 0, "Nothing to update");
export type UpdateAutomationClientRequest = z.infer<typeof UpdateAutomationClientRequest>;

export const AutomationClient = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  allowedActions: z.array(AutomationAction),
  allowedJobTypes: z.array(JobType),
  rateLimitPerMinute: z.int(),
  disabled: z.boolean(),
  keyVersion: z.int().positive(),
  lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type AutomationClient = z.infer<typeof AutomationClient>;

export const AutomationClientList = z.object({ items: z.array(AutomationClient) });
export type AutomationClientList = z.infer<typeof AutomationClientList>;

// Returned once on create and on rotate; the server derives the key and never stores it.
export const AutomationClientSecret = z.object({
  client: AutomationClient,
  signingKey: z.string(), // base64url, 32 bytes
});
export type AutomationClientSecret = z.infer<typeof AutomationClientSecret>;

// POST /v1/automations/trigger — signature = "v1=" + hex(HMAC-SHA256(signingKey, `${timestamp}.${rawBody}`)).
export const AUTOMATION_CLIENT_HEADER = "x-nexus-client";
export const AUTOMATION_TIMESTAMP_HEADER = "x-nexus-timestamp"; // unix seconds
export const AUTOMATION_SIGNATURE_HEADER = "x-nexus-signature";
export const AUTOMATION_MAX_SKEW_SECONDS = 300;

export const TriggerRequest = z.strictObject({
  // Replays of the same key return the first result; nothing runs twice (FR-AUTO-07).
  idempotencyKey: IdempotencyKey,
  action: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("research.run"), watchlistId: z.uuid() }),
    // Must target the client's own project and an allowed job type; the normal job checks (budget, emergency stop,
    // project/repo binding, approvals) still apply (AUTO-G01).
    z.strictObject({ type: z.literal("jobs.create"), request: CreateJobRequest }),
  ]),
});
export type TriggerRequest = z.infer<typeof TriggerRequest>;

export const TriggerResponse = z.object({
  automationRunId: z.uuid(),
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("research_run"), id: z.uuid() }),
    z.object({ kind: z.literal("job"), id: z.uuid() }),
  ]),
});
export type TriggerResponse = z.infer<typeof TriggerResponse>;

// FR-AUTO-02/08: trigger history, including rejected attempts that passed authentication.
export const AutomationRun = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  // null when an authenticated request failed schema validation (AUTO-G03): its action is unknown.
  action: AutomationAction.nullable(),
  status: z.enum(["ACCEPTED", "REJECTED"]),
  reason: z.string().nullable(),
  result: TriggerResponse.shape.result.nullable(),
  receivedAt: z.iso.datetime({ offset: true }),
});
export type AutomationRun = z.infer<typeof AutomationRun>;

export const AutomationRunList = z.object({ items: z.array(AutomationRun) });
export type AutomationRunList = z.infer<typeof AutomationRunList>;
