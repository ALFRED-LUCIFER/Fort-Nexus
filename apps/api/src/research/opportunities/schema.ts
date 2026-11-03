import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  AgentKey,
  AiConfidence,
  Claim,
  Opportunity,
  OpportunityKind,
  OpportunityStatus,
} from "@nexus/contracts";

// FR-RES-10 / FR-CXR-09: the researcher's opportunities and the owner-approved GitHub issue for one of them.
// Everything here is scoped by workspace + project; the evidence is a copy of the dive's verified claims, so later
// changes to a dive never change what the owner decided on.

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
// Postgres 18 uuidv7(): time-ordered ids also order "newest" in the ranking.
const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`);
const scope = () => ({
  workspaceId: uuid("workspace_id").notNull(),
  projectId: uuid("project_id").notNull(),
});

export const researchOpportunities = pgTable(
  "research_opportunities",
  {
    id: id(),
    ...scope(),
    // The deep dive it came from (module B's research_deep_dives; one opportunity per dive at most).
    deepDiveId: uuid("deep_dive_id").notNull(),
    kind: text("kind").$type<OpportunityKind>().notNull(),
    title: text("title").notNull(),
    problem: text("problem").notNull(),
    targetUsers: text("target_users").notNull(),
    impactEstimate: text("impact_estimate").notNull(),
    confidence: text("confidence").$type<AiConfidence>().notNull(),
    // Immutable copy of the claims the opportunity rests on (labels and evidence as verified by the dive).
    evidence: jsonb("evidence").$type<Claim[]>().notNull(),
    // Claims with at least one server-verified quote: the second ranking key.
    verifiedClaims: integer("verified_claims").notNull(),
    validationSteps: jsonb("validation_steps").$type<string[]>().notNull(),
    agents: jsonb("agents").$type<AgentKey[]>().notNull(),
    status: text("status").$type<OpportunityStatus>().notNull().default("OPEN"),
    // Set only from GitHub's create-issue response.
    issue: jsonb("issue").$type<Opportunity["issue"]>(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("research_opportunities_deep_dive_uq").on(t.deepDiveId),
    index("research_opportunities_scope_idx").on(t.workspaceId, t.projectId, t.status),
  ],
);

/** What the owner was shown: the exact issue the approval binds to (by hash), valid until `expiresAt`. */
export const opportunityIssuePreviews = pgTable(
  "opportunity_issue_previews",
  {
    id: id(),
    ...scope(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => researchOpportunities.id),
    repositoryId: text("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    labels: jsonb("labels").$type<string[]>().notNull(),
    actionHash: text("action_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("opportunity_issue_previews_hash_uq").on(t.opportunityId, t.actionHash)],
);

/**
 * The claim on "create the issue" (PRD §18.4: one ledger row per idempotent external action), written before GitHub
 * is called. One per opportunity: a retry finishes this claim (adopting an issue GitHub already created) instead of
 * creating another issue.
 */
export const opportunityIssueRequests = pgTable(
  "opportunity_issue_requests",
  {
    id: id(),
    ...scope(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => researchOpportunities.id),
    repositoryId: text("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    labels: jsonb("labels").$type<string[]>().notNull(),
    actionHash: text("action_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").$type<"PENDING" | "CREATED">().notNull(),
    // GitHub attempts started; > 0 means an earlier attempt may have created the issue (look for it first).
    attempts: integer("attempts").notNull().default(0),
    // An attempt in progress holds this lease; a crashed attempt's lease lapses and the next approve retries.
    lockedUntil: ts("locked_until"),
    lastError: text("last_error"),
    issueNumber: integer("issue_number"),
    issueUrl: text("issue_url"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("opportunity_issue_requests_opportunity_uq").on(t.opportunityId)],
);
