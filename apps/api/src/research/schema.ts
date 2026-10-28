import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  BriefSchedule,
  Finding,
  FindingExplanation,
  ResearchRun,
  ResearchRunStatus,
  ResearchSource,
  ScoringWeights,
  SourceTier,
  VerificationLabel,
} from "@nexus/contracts";

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

export const researchWatchlists = pgTable(
  "research_watchlists",
  {
    id: id(),
    ...scope(),
    name: text("name").notNull(),
    keywords: jsonb("keywords").$type<string[]>().notNull(),
    sources: jsonb("sources").$type<ResearchSource[]>().notNull(),
    weights: jsonb("weights").$type<ScoringWeights>().notNull(),
    schedule: jsonb("schedule").$type<BriefSchedule>().notNull(),
    // Next scheduled window; null while paused or archived.
    nextRunAt: ts("next_run_at"),
    lastRunAt: ts("last_run_at"),
    // DELETE archives: the watchlist stops running, its findings stay searchable.
    archivedAt: ts("archived_at"),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("research_watchlists_scope_idx").on(t.workspaceId, t.projectId, t.id),
    index("research_watchlists_due_idx")
      .on(t.nextRunAt)
      .where(sql`${t.nextRunAt} is not null and ${t.archivedAt} is null`),
  ],
);

export const researchRuns = pgTable(
  "research_runs",
  {
    id: id(),
    ...scope(),
    watchlistId: uuid("watchlist_id")
      .notNull()
      .references(() => researchWatchlists.id),
    trigger: text("trigger").$type<ResearchRun["trigger"]>().notNull(),
    // Local date of a SCHEDULED window; null for MANUAL runs (nulls never collide in the unique index).
    windowDate: date("window_date", { mode: "string" }),
    idempotencyKey: text("idempotency_key"),
    status: text("status").$type<ResearchRunStatus>().notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    newFindings: integer("new_findings").notNull().default(0),
    skippedSources: jsonb("skipped_sources").$type<ResearchRun["skippedSources"]>().notNull().default([]),
    // Why a run FAILED as a whole (e.g. the API restarted mid-run). Never contains fetched content.
    error: text("error"),
  },
  (t) => [
    // RES-G01: one scheduled run per watchlist and local date.
    uniqueIndex("research_runs_window_uq").on(t.watchlistId, t.windowDate),
    uniqueIndex("research_runs_idempotency_uq").on(t.watchlistId, t.idempotencyKey),
    index("research_runs_watchlist_idx").on(t.workspaceId, t.projectId, t.watchlistId, t.id),
    index("research_runs_running_idx")
      .on(t.startedAt)
      .where(sql`${t.status} = 'RUNNING'`),
  ],
);

export const researchFindings = pgTable(
  "research_findings",
  {
    id: id(),
    ...scope(),
    watchlistId: uuid("watchlist_id")
      .notNull()
      .references(() => researchWatchlists.id),
    firstRunId: uuid("first_run_id")
      .notNull()
      .references(() => researchRuns.id),
    title: text("title").notNull(),
    excerpt: text("excerpt").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    label: text("label").$type<VerificationLabel>().notNull(),
    // The score itself is derived from this and the watchlist's current weights, so weight edits apply at once.
    scoreBreakdown: jsonb("score_breakdown").$type<Finding["scoreBreakdown"]>().notNull(),
    publishedAt: ts("published_at"),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    readAt: ts("read_at"),
  },
  (t) => [
    index("research_findings_scope_idx").on(t.workspaceId, t.projectId, t.id),
    index("research_findings_watchlist_seen_idx").on(t.watchlistId, t.firstSeenAt),
    index("research_findings_run_idx").on(t.firstRunId),
    index("research_findings_fts_idx").using(
      "gin",
      sql`to_tsvector('english', ${t.title} || ' ' || ${t.excerpt})`,
    ),
  ],
);

export const researchFindingSources = pgTable(
  "research_finding_sources",
  {
    id: id(),
    ...scope(),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => researchFindings.id),
    watchlistId: uuid("watchlist_id")
      .notNull()
      .references(() => researchWatchlists.id),
    url: text("url").notNull(), // canonical
    publisher: text("publisher").notNull(),
    tier: text("tier").$type<SourceTier>().notNull(),
    title: text("title").notNull(),
    publishedAt: ts("published_at"),
    fetchedAt: ts("fetched_at").notNull(),
  },
  (t) => [
    // RES-G02: a canonical URL is known once per watchlist, whichever finding it belongs to.
    uniqueIndex("research_finding_sources_url_uq").on(t.watchlistId, t.url),
    index("research_finding_sources_finding_idx").on(t.findingId),
  ],
);

// FR-RES-08: one AI explanation per finding, written once. The row is the claim: it exists from the moment one
// request starts the model call, so a racing request never calls the model too.
export const researchFindingExplanations = pgTable(
  "research_finding_explanations",
  {
    id: id(),
    ...scope(),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => researchFindings.id),
    model: text("model").notNull(),
    profileVersionId: uuid("profile_version_id"),
    claimedAt: ts("claimed_at").notNull(),
    // null while the model call is in flight; the validated tool output once it succeeded.
    result:
      jsonb("result").$type<
        Pick<FindingExplanation, "whyItMatters" | "recommendedAction" | "confidence" | "citedUrls">
      >(),
    createdAt: ts("created_at"),
  },
  (t) => [uniqueIndex("research_finding_explanations_finding_uq").on(t.findingId)],
);
