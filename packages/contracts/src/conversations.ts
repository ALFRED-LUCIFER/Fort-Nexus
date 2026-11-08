import { z } from "zod";
import { CreateJobRequest } from "./jobs.ts";
import { CreateDeepDiveRequest, DeepDiveDepth } from "./research-deep.ts";

// EPIC CWV/CXR, text only (FR-CWV-01/04/05/07, FR-CXR-01..07). The model only ever proposes; the server computes
// every hash and the owner's authenticated click is the only approval (PRD §12.7, §13.8).

export const Thread = z.object({
  id: z.uuid(),
  // Every turn, tool call and proposal of the thread is confined to this project (FR-CXR-01, FR-CSP-01).
  projectId: z.uuid(),
  title: z.string(),
  // The job the thread is currently about (FR-CWV-04 follow-ups); set only from a verified source, never by the model.
  subjectJobId: z.uuid().nullable(),
  // FR-WKS-05: the Chief of Staff profile version pinned at creation; null = built-in default.
  profileVersionId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Thread = z.infer<typeof Thread>;

export const ThreadList = z.object({ items: z.array(Thread), nextCursor: z.string().nullable() });
export type ThreadList = z.infer<typeof ThreadList>;

export const CreateThreadRequest = z.strictObject({
  projectId: z.uuid(),
  title: z.string().trim().min(1).max(120).optional(),
  subjectJobId: z.uuid().optional(),
});
export type CreateThreadRequest = z.infer<typeof CreateThreadRequest>;

// FR-CXR-04: every material claim points at a record NEXUS read itself, with its as-of time.
export const SourceRef = z.object({
  kind: z.enum([
    "JOB",
    "RUN_EVENT",
    "APPROVAL",
    "PULL_REQUEST",
    "METRIC",
    "FINDING",
    "RESEARCH_RUN",
    "DEEP_DIVE",
    "OPPORTUNITY",
    "WEB_PAGE",
    "PLAN",
    "JOB_DRAFT",
    "INCIDENT",
  ]),
  id: z.string().max(200),
  label: z.string().max(200),
  asOf: z.iso.datetime({ offset: true }),
  url: z.url().optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

// FR-CWV-07: observed (source event) vs inferred (labelled reasoning) vs pending (not happened yet).
export const Basis = z.enum(["OBSERVED", "INFERRED", "PENDING", "NONE"]);
export type Basis = z.infer<typeof Basis>;

// The typed router's output (FR-CXR-03). Unknown or shell-like requests become UNSUPPORTED, never an action.
export const Intent = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("RUN_STATUS"), jobId: z.uuid().optional() }),
  // status: only runs in progress (ACTIVE) or that failed in the last 7 days (FAILED); period TODAY: today's runs,
  // summarised by outcome.
  z.strictObject({
    kind: z.literal("LIST_RUNS"),
    status: z.enum(["ACTIVE", "FAILED"]).optional(),
    period: z.literal("TODAY").optional(),
  }),
  // What waits on the owner (the records behind Home's "Waiting on you"), plus the runs still in progress.
  z.strictObject({ kind: z.literal("WAITING_ON_YOU") }),
  z.strictObject({
    kind: z.literal("START_ISSUE_RUN"),
    repositoryFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    issueNumber: z.int().positive(),
  }),
  z.strictObject({
    kind: z.literal("BUSINESS_METRIC"),
    metric: z.enum(["SALES_SUMMARY", "PAYMENT_FAILURES", "REVENUE", "TOP_PRODUCTS"]),
    day: z.union([z.enum(["today", "yesterday"]), z.iso.date()]),
    compare: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("RESEARCH_SEARCH"), query: z.string().max(200) }),
  // Becomes a deep-dive proposal card (R1: it spends budget); never starts on its own.
  z.strictObject({
    kind: z.literal("RESEARCH_DEEP_DIVE"),
    question: z.string().max(2000),
    depth: DeepDiveDepth,
  }),
  // FR-CXR-07: ambiguous antecedent ("do it", "that one") → ask, never guess.
  z.strictObject({ kind: z.literal("CLARIFY"), question: z.string().max(500) }),
  z.strictObject({ kind: z.literal("UNSUPPORTED"), reason: z.string().max(500) }),
]);
export type Intent = z.infer<typeof Intent>;

export const Turn = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  role: z.enum(["USER", "ASSISTANT"]),
  text: z.string(),
  intent: Intent.nullable(), // assistant turns only
  basis: Basis, // USER turns: NONE
  sources: z.array(SourceRef),
  proposalId: z.uuid().nullable(),
  correlationId: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Turn = z.infer<typeof Turn>;

// PRD C-09.
export const ProposalStatus = z.enum([
  "PROPOSED",
  "AWAITING_APPROVAL",
  "APPROVED",
  "DENIED",
  "EXPIRED",
  "INVALIDATED",
  "EXECUTED",
  "FAILED",
  "UNKNOWN",
]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

// Executable actions are typed requests through existing paths (POST /v1/jobs, POST /v1/research/deep-dives).
// `preview` is what the owner sees before confirming, built by the server from the request (never model text).
export const ProposedAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("jobs.create"), request: CreateJobRequest, preview: z.string() }),
  z.object({ type: z.literal("research.deep_dive"), request: CreateDeepDiveRequest, preview: z.string() }),
]);
export type ProposedAction = z.infer<typeof ProposedAction>;

export const ActionProposal = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  turnId: z.uuid(),
  riskTier: z.enum(["R0", "R1", "R2", "R3"]),
  action: ProposedAction,
  // sha256 of the canonical action JSON, computed by the server only.
  actionHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: ProposalStatus,
  expiresAt: z.iso.datetime({ offset: true }),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  // Set only from the created job / deep dive (truth hierarchy).
  result: z.union([z.object({ jobId: z.uuid() }), z.object({ deepDiveId: z.uuid() })]).nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ActionProposal = z.infer<typeof ActionProposal>;

export const PROPOSAL_TTL_MS = 15 * 60 * 1000;

export const ThreadDetail = z.object({
  thread: Thread,
  turns: z.array(Turn),
  proposals: z.array(ActionProposal),
});
export type ThreadDetail = z.infer<typeof ThreadDetail>;

// POST /v1/conversations/:id/turns — Idempotency-Key required (a retried send must not call the model twice).
export const PostTurnRequest = z.strictObject({ text: z.string().trim().min(1).max(4000) });
export type PostTurnRequest = z.infer<typeof PostTurnRequest>;

export const PostTurnResponse = z.object({
  userTurn: Turn,
  assistantTurn: Turn,
  proposal: ActionProposal.nullable(),
});
export type PostTurnResponse = z.infer<typeof PostTurnResponse>;

export const ProposalDecisionRequest = z.strictObject({
  decision: z.enum(["approve", "deny"]),
  actionHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ProposalDecisionRequest = z.infer<typeof ProposalDecisionRequest>;
