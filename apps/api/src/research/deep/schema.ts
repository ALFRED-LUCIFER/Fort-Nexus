import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  DeepDiveDepth,
  DeepDiveLimits,
  DeepDiveReport,
  DeepDiveStatus,
  DeepDiveStep,
  DeepDiveStop,
} from "@nexus/contracts";

// RESEARCH_DEEP_DIVE (PRD §10.1, FR-RES-03/05/06/10). Page text and the model's report are untrusted data.

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
// Postgres 18 uuidv7(): time-ordered ids double as the newest-first list cursor.
const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`);
const scope = () => ({
  workspaceId: uuid("workspace_id").notNull(),
  projectId: uuid("project_id").notNull(),
});

export const researchDeepDives = pgTable(
  "research_deep_dives",
  {
    id: id(),
    ...scope(),
    // The owner who asked (notifications go to them); the audit actor of create/cancel.
    ownerId: text("owner_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    correlationId: text("correlation_id").notNull(),
    question: text("question").notNull(),
    depth: text("depth").$type<DeepDiveDepth>().notNull(),
    findingIds: jsonb("finding_ids").$type<string[]>().notNull(),
    status: text("status").$type<DeepDiveStatus>().notNull(),
    stoppedBy: text("stopped_by").$type<DeepDiveStop>(),
    limits: jsonb("limits").$type<DeepDiveLimits>().notNull(),
    // false when ai.json is set up but search.json isn't and the dive starts from findings only.
    searchEnabled: boolean("search_enabled").notNull(),
    model: text("model").notNull(),
    profileVersionId: uuid("profile_version_id"),
    // The ai_spend reservation (set in the create transaction).
    spendId: uuid("spend_id"),
    // Measured from provider usage and NEXUS's own counters; written as the dive runs.
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    turns: integer("turns").notNull().default(0),
    searches: integer("searches").notNull().default(0),
    fetches: integer("fetches").notNull().default(0),
    report: jsonb("report").$type<DeepDiveReport>(),
    // The opportunity recordOpportunity created in the completing transaction; null when the report proposed none.
    opportunityId: uuid("opportunity_id"),
    error: text("error"),
    cancelRequestedAt: ts("cancel_requested_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    uniqueIndex("research_deep_dives_idempotency_uq").on(t.projectId, t.idempotencyKey),
    index("research_deep_dives_scope_idx").on(t.workspaceId, t.projectId, t.id),
    index("research_deep_dives_active_idx")
      .on(t.status, t.id)
      .where(sql`${t.status} in ('QUEUED', 'RUNNING')`),
    check(
      "research_deep_dives_status_valid",
      sql`${t.status} in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')`,
    ),
  ],
);

// The owner-visible activity log. Append-only (trigger in the migration).
export const researchDeepDiveSteps = pgTable(
  "research_deep_dive_steps",
  {
    id: id(),
    ...scope(),
    deepDiveId: uuid("deep_dive_id")
      .notNull()
      .references(() => researchDeepDives.id),
    index: integer("index").notNull(),
    kind: text("kind").$type<DeepDiveStep["kind"]>().notNull(),
    detail: text("detail").notNull(),
    outcome: text("outcome").$type<DeepDiveStep["outcome"]>().notNull(),
    note: text("note"),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("research_deep_dive_steps_uq").on(t.deepDiveId, t.index)],
);

// The readable text NEXUS fetched itself in a dive: the only ground a quote is verified against.
export const researchPageSnapshots = pgTable(
  "research_page_snapshots",
  {
    id: id(),
    ...scope(),
    deepDiveId: uuid("deep_dive_id")
      .notNull()
      .references(() => researchDeepDives.id),
    url: text("url").notNull(), // canonical, as requested
    finalUrl: text("final_url").notNull(), // after redirects
    title: text("title").notNull(),
    text: text("text").notNull(),
    sha256: text("sha256").notNull(),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("research_page_snapshots_url_uq").on(t.deepDiveId, t.url)],
);
