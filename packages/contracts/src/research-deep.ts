import { z } from "zod";
import { AgentKey } from "./agents.ts";
import { RepoId } from "./github.ts";
import { AiConfidence, SourceTier } from "./research.ts";

// P1 wave 5 (docs/specs/p1-wave-5-researcher.md): the AI researcher's deep dives (PRD §10.1 RESEARCH_DEEP_DIVE,
// FR-RES-03/05/06/09/10/12), the owner's source registry (PRD §9 RES "source allowlist") and opportunities with an
// approved issue proposal (FR-RES-10, FR-CXR-09). Everything the model writes is a proposal with server-checked
// evidence; web text is untrusted data (FR-CSP-07).

// ── Source registry ────────────────────────────────────────────────────────────────────────────────────────────

// A registrable host name (lower case, no scheme/port/path). A rule covers the domain and its subdomains.
export const DomainName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "A domain name like example.com",
  );
export type DomainName = z.infer<typeof DomainName>;

// Owner credibility of a web domain, per workspace. Unknown domains are COMMUNITY; blocked ones are never searched
// into the model's view nor fetched.
export const ResearchDomain = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  domain: DomainName,
  tier: SourceTier,
  blocked: z.boolean(),
  note: z.string().max(200).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type ResearchDomain = z.infer<typeof ResearchDomain>;

// PUT /v1/research/domains — upsert by (workspaceId, domain).
export const PutResearchDomainRequest = z.strictObject({
  workspaceId: z.uuid(),
  domain: DomainName,
  tier: SourceTier,
  blocked: z.boolean().default(false),
  note: z.string().trim().max(200).optional(),
});
export type PutResearchDomainRequest = z.infer<typeof PutResearchDomainRequest>;

// GET /v1/research/domains?workspaceId=
export const ResearchDomainList = z.object({ items: z.array(ResearchDomain) });
export type ResearchDomainList = z.infer<typeof ResearchDomainList>;

// GET /v1/research/search-provider — whether ~/.nexus/search.json is usable; never returns the key.
export const SearchProviderStatus = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(true), provider: z.literal("brave") }),
  z.object({ configured: z.literal(false), reason: z.string(), runbook: z.string() }),
]);
export type SearchProviderStatus = z.infer<typeof SearchProviderStatus>;

// ── Deep dives ─────────────────────────────────────────────────────────────────────────────────────────────────

export const DeepDiveDepth = z.enum(["QUICK", "STANDARD", "THOROUGH"]);
export type DeepDiveDepth = z.infer<typeof DeepDiveDepth>;

// Server constants: how many searches and page fetches one dive may make at each depth. Turns and cost come from
// the AI researcher's effective profile (and the owner's cap below), whichever is lower.
export const DEEP_DIVE_DEPTH_LIMITS: Readonly<
  Record<DeepDiveDepth, { maxSearches: number; maxFetches: number }>
> = {
  QUICK: { maxSearches: 4, maxFetches: 8 },
  STANDARD: { maxSearches: 10, maxFetches: 16 },
  THOROUGH: { maxSearches: 20, maxFetches: 30 },
};
export const DEEP_DIVE_MAX_WALL_CLOCK_MS = 15 * 60_000;

// POST /v1/research/deep-dives — Idempotency-Key required (a retry must never pay twice).
export const CreateDeepDiveRequest = z.strictObject({
  projectId: z.uuid(),
  question: z.string().trim().min(10).max(2000),
  // Owner's findings to start from: their sources are fetched first (FR-RES-10 "investigate this cluster").
  findingIds: z.array(z.uuid()).max(10).default([]),
  depth: DeepDiveDepth.default("STANDARD"),
  // The owner's cap for this dive; the effective cap is min(this, the profile's maxCostUsdPerTask) and is reserved
  // against today's budget before the first model call.
  maxCostUsd: z.number().positive().max(50),
});
export type CreateDeepDiveRequest = z.infer<typeof CreateDeepDiveRequest>;

export const DeepDiveStatus = z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]);
export type DeepDiveStatus = z.infer<typeof DeepDiveStatus>;

// Which limit ended the research loop early (the report was still written from what was gathered); null = the model
// finished on its own.
export const DeepDiveStop = z.enum(["COST", "TURNS", "SEARCHES", "FETCHES", "TIME"]);
export type DeepDiveStop = z.infer<typeof DeepDiveStop>;

// One owner-visible activity line. `detail` is the search query or URL (untrusted, shown as text, never linked
// unless it is an https URL NEXUS fetched).
export const DeepDiveStep = z.object({
  index: z.int().nonnegative(),
  kind: z.enum(["SEARCH", "FETCH", "MODEL"]),
  detail: z.string().max(500),
  outcome: z.enum(["OK", "SKIPPED", "BLOCKED", "ERROR"]),
  note: z.string().max(300).nullable(),
  at: z.iso.datetime({ offset: true }),
});
export type DeepDiveStep = z.infer<typeof DeepDiveStep>;

// FR-RES-06 per claim: PRIMARY = a verified quote from a PRIMARY-tier domain; CORROBORATED = verified quotes from ≥2
// publishers; CONTESTED = a verified contradiction names it; else UNVERIFIED (incl. any quote NEXUS couldn't find).
export const ClaimLabel = z.enum(["PRIMARY", "CORROBORATED", "UNVERIFIED", "CONTESTED"]);
export type ClaimLabel = z.infer<typeof ClaimLabel>;

export const ClaimEvidence = z.object({
  url: z.url(),
  publisher: z.string(),
  tier: SourceTier,
  // The exact span the model quoted (≤ 500 chars). Untrusted text.
  quote: z.string().max(500),
  // true only when the server found the quote (whitespace/case-normalised) in the page snapshot it fetched itself.
  verified: z.boolean(),
  snapshotId: z.uuid().nullable(),
});
export type ClaimEvidence = z.infer<typeof ClaimEvidence>;

export const Claim = z.object({
  id: z.int().nonnegative(),
  text: z.string().max(600),
  // OBSERVED = stated by its sources; INFERRED = the researcher's reasoning over them (always labelled in the UI).
  basis: z.enum(["OBSERVED", "INFERRED"]),
  evidence: z.array(ClaimEvidence).max(5),
  label: ClaimLabel,
});
export type Claim = z.infer<typeof Claim>;

export const OpportunityKind = z.enum(["OPPORTUNITY", "RISK", "OPTIMIZE"]);
export type OpportunityKind = z.infer<typeof OpportunityKind>;

// What the researcher proposes as a decision for the owner. Impact is an estimate in words, always shown "est.".
export const OpportunityDraft = z.object({
  kind: OpportunityKind,
  title: z.string().max(140),
  problem: z.string().max(800),
  targetUsers: z.string().max(300),
  impactEstimate: z.string().max(200),
  confidence: AiConfidence,
  claimIds: z.array(z.int().nonnegative()).min(1).max(20),
  validationSteps: z.array(z.string().max(300)).max(5),
});
export type OpportunityDraft = z.infer<typeof OpportunityDraft>;

export const DeepDiveReport = z.object({
  // AI inference; may only reference claims as [n] and URLs NEXUS fetched in this dive (server-checked).
  summary: z.string().max(3000),
  claims: z.array(Claim).max(40),
  contradictions: z
    .array(z.object({ claimIds: z.array(z.int().nonnegative()).min(2).max(5), note: z.string().max(500) }))
    .max(10),
  openQuestions: z.array(z.string().max(300)).max(8),
  confidence: AiConfidence,
  opportunity: OpportunityDraft.nullable(),
});
export type DeepDiveReport = z.infer<typeof DeepDiveReport>;

export const DeepDiveLimits = z.object({
  maxCostUsd: z.number().positive(),
  maxTurns: z.int().positive(),
  maxSearches: z.int().nonnegative(),
  maxFetches: z.int().nonnegative(),
});
export type DeepDiveLimits = z.infer<typeof DeepDiveLimits>;

export const DeepDive = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  question: z.string(),
  depth: DeepDiveDepth,
  findingIds: z.array(z.uuid()),
  status: DeepDiveStatus,
  stoppedBy: DeepDiveStop.nullable(),
  limits: DeepDiveLimits,
  // Measured from provider usage and NEXUS's own search/fetch counters, never from model text.
  usage: z.object({
    costUsd: z.number().nonnegative(),
    turns: z.int().nonnegative(),
    searches: z.int().nonnegative(),
    fetches: z.int().nonnegative(),
  }),
  model: z.string(),
  profileVersionId: z.uuid().nullable(),
  report: DeepDiveReport.nullable(),
  // Fixed server text when FAILED/CANCELLED; never provider or exception detail.
  error: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type DeepDive = z.infer<typeof DeepDive>;

// GET /v1/research/deep-dives/:id
export const DeepDiveDetail = DeepDive.extend({ steps: z.array(DeepDiveStep) });
export type DeepDiveDetail = z.infer<typeof DeepDiveDetail>;

// GET /v1/research/deep-dives?projectId=&cursor=&limit= (projectId omitted = read-only "All" view)
export const DeepDiveListQuery = z.object({
  projectId: z.uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type DeepDiveListQuery = z.infer<typeof DeepDiveListQuery>;

export const DeepDiveList = z.object({ items: z.array(DeepDive), nextCursor: z.string().nullable() });
export type DeepDiveList = z.infer<typeof DeepDiveList>;

// ── Opportunities (the Cofounder "noticed" cards) ──────────────────────────────────────────────────────────────

export const OpportunityStatus = z.enum(["OPEN", "DISMISSED", "ISSUE_CREATED"]);
export type OpportunityStatus = z.infer<typeof OpportunityStatus>;

export const Opportunity = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  deepDiveId: z.uuid(),
  kind: OpportunityKind,
  title: z.string(),
  problem: z.string(),
  targetUsers: z.string(),
  impactEstimate: z.string(),
  confidence: AiConfidence,
  // The report's claims it rests on, with their labels and evidence (copied at creation; immutable).
  evidence: z.array(Claim).min(1),
  validationSteps: z.array(z.string()),
  // Agents involved: AI_RESEARCHER always, plus who would act on an approved issue.
  agents: z.array(AgentKey).min(1),
  status: OpportunityStatus,
  // Set only from GitHub's create-issue response (truth hierarchy).
  issue: z.object({ repositoryFullName: z.string(), number: z.int().positive(), url: z.url() }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Opportunity = z.infer<typeof Opportunity>;

// GET /v1/research/opportunities?projectId=&status= — ranked by confidence, then verified evidence, then newest.
export const OpportunityListQuery = z.object({
  projectId: z.uuid().optional(),
  status: OpportunityStatus.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type OpportunityListQuery = z.infer<typeof OpportunityListQuery>;

export const OpportunityList = z.object({ items: z.array(Opportunity) });
export type OpportunityList = z.infer<typeof OpportunityList>;

// POST /v1/research/opportunities/:id/issue-preview — "exactly what will happen", built by the server only.
export const IssuePreviewRequest = z.strictObject({ repositoryId: RepoId });
export type IssuePreviewRequest = z.infer<typeof IssuePreviewRequest>;

export const IssuePreview = z.object({
  opportunityId: z.uuid(),
  repositoryId: RepoId,
  repositoryFullName: z.string(),
  title: z.string().max(256),
  body: z.string().max(20_000),
  labels: z.array(z.string().max(50)).max(5),
  // Human rows for the preview card: does / where / won't do / next.
  rows: z.array(z.object({ k: z.string(), v: z.string() })),
  // sha256 of the canonical {opportunityId, repositoryId, title, body, labels}; the approval binds to it.
  actionHash: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type IssuePreview = z.infer<typeof IssuePreview>;

// POST /v1/research/opportunities/:id/issue — Idempotency-Key required; R2: the owner's click on this exact hash.
export const CreateOpportunityIssueRequest = z.strictObject({
  repositoryId: RepoId,
  actionHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type CreateOpportunityIssueRequest = z.infer<typeof CreateOpportunityIssueRequest>;
