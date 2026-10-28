import { z } from "zod";
import { RiskTier } from "./jobs.ts";

// EPIC AGT (FR-AGT-06/07) + FR-WKS-04/05 + PRD C-04. An agent's profile can only narrow what the global safety ceiling
// allows; it is checked at every tool call, never baked into a running job (PRD §11.16).

export const AgentKey = z.enum([
  "CHIEF_OF_STAFF",
  "DEVELOPER",
  "QA",
  "DEVOPS",
  "PRODUCT",
  "AI_RESEARCHER",
  "FINANCIAL_ANALYST",
]);
export type AgentKey = z.infer<typeof AgentKey>;

// The only things an agent can be allowed to do: existing typed paths, nothing free-form.
export const AgentTool = z.enum([
  "jobs.read",
  "jobs.create.diagnostic",
  "jobs.create.issue_run",
  "github.read",
  "research.search",
  "research.run",
  "business.metrics",
  "monitoring.read",
]);
export type AgentTool = z.infer<typeof AgentTool>;

// Fixed by the server, not configurable. Writes to the outside world (push/PR) stay behind their own approval gate.
export const TOOL_RISK: Readonly<Record<AgentTool, RiskTier>> = {
  "jobs.read": "R0",
  "jobs.create.diagnostic": "R1",
  "jobs.create.issue_run": "R1",
  "github.read": "R0",
  "research.search": "R0",
  "research.run": "R0",
  "business.metrics": "R0",
  "monitoring.read": "R0",
};

// C-04: the design's dial. AUTONOMOUS may only act on R0/R1 tools; R2/R3 always need a fresh owner approval.
export const AutonomyLevel = z.enum(["SUGGEST", "DRAFT", "ACT_WITH_APPROVAL", "AUTONOMOUS"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

export const AgentEngine = z.enum(["MESSAGES_API", "CLAUDE_AGENT_SDK"]);
export type AgentEngine = z.infer<typeof AgentEngine>;

export const AgentProfileSettings = z.strictObject({
  // A model id the configured provider serves; omitted = the model in ai.json. Shape-checked only, never a URL.
  model: z
    .string()
    .regex(/^[\w.:@/-]{1,128}$/)
    .refine((m) => !m.includes("//"), "A model id, not a URL")
    .optional(),
  engine: AgentEngine,
  autonomy: AutonomyLevel,
  tools: z.array(AgentTool).max(AgentTool.options.length),
  maxCostUsdPerTask: z.number().positive().max(50),
  maxTurns: z.int().min(1).max(200),
  responseDetail: z.enum(["BRIEF", "STANDARD", "DETAILED"]),
});
export type AgentProfileSettings = z.infer<typeof AgentProfileSettings>;

// PUT /v1/agents/:agent/profile — appends a new immutable version at exactly one level.
export const SetAgentProfileRequest = z.strictObject({
  level: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("WORKSPACE"), workspaceId: z.uuid() }),
    z.strictObject({ kind: z.literal("PROJECT"), projectId: z.uuid() }),
  ]),
  settings: AgentProfileSettings,
});
export type SetAgentProfileRequest = z.infer<typeof SetAgentProfileRequest>;

export const ProfileLevel = z.enum(["DEFAULT", "WORKSPACE", "PROJECT"]);
export type ProfileLevel = z.infer<typeof ProfileLevel>;

// FR-WKS-05: what a conversation/task pins. Project version beats workspace version beats the built-in default
// (whole settings per level, no field merging), then the global ceiling narrows it.
export const EffectiveAgentProfile = z.object({
  agent: AgentKey,
  // null = built-in default (no stored version).
  versionId: z.uuid().nullable(),
  level: ProfileLevel,
  version: z.int().nonnegative(), // 0 for the built-in default
  settings: AgentProfileSettings,
  // Human-readable notes of what the ceiling removed or capped, e.g. "AUTONOMOUS capped to ACT_WITH_APPROVAL".
  ceilingApplied: z.array(z.string()),
});
export type EffectiveAgentProfile = z.infer<typeof EffectiveAgentProfile>;

export const AgentSummary = z.object({
  agent: AgentKey,
  label: z.string(),
  description: z.string(),
  effective: EffectiveAgentProfile,
  // From plan steps it owned (truth: step status from source events).
  record: z.object({
    stepsSucceeded: z.int().nonnegative(),
    stepsFailed: z.int().nonnegative(),
    lastActiveAt: z.iso.datetime({ offset: true }).nullable(),
  }),
});
export type AgentSummary = z.infer<typeof AgentSummary>;

// GET /v1/agents?projectId= (required: profiles resolve per project).
export const AgentList = z.object({ items: z.array(AgentSummary) });
export type AgentList = z.infer<typeof AgentList>;

export const AgentProfileVersion = z.object({
  id: z.uuid(),
  agent: AgentKey,
  level: ProfileLevel.exclude(["DEFAULT"]),
  workspaceId: z.uuid(),
  projectId: z.uuid().nullable(),
  version: z.int().positive(),
  settings: AgentProfileSettings,
  createdAt: z.iso.datetime({ offset: true }),
});
export type AgentProfileVersion = z.infer<typeof AgentProfileVersion>;

// GET /v1/agents/:agent/versions?projectId= — that project's and its workspace's history, newest first.
export const AgentProfileVersionList = z.object({ items: z.array(AgentProfileVersion) });
export type AgentProfileVersionList = z.infer<typeof AgentProfileVersionList>;
