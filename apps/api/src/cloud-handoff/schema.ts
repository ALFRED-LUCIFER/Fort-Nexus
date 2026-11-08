import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid, boolean } from "drizzle-orm/pg-core";
import type { CloudHandoffStatus } from "@nexus/contracts";

// Issue → Claude Code routine in Anthropic's cloud (docs/specs/cloud-handoff.md). Scoped by workspace + project.
// The routine token never enters the database: it stays in ~/.nexus/claude-cloud.json (mode 0600).

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`);

/** What the owner was shown: the exact text the approval binds to (by hash), valid until `expiresAt`. */
export const cloudHandoffPreviews = pgTable(
  "cloud_handoff_previews",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    issueNumber: integer("issue_number").notNull(),
    routineId: text("routine_id").notNull(),
    text: text("text").notNull(),
    actionHash: text("action_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cloud_handoff_previews_hash_uq").on(
      t.projectId,
      t.repositoryId,
      t.issueNumber,
      t.actionHash,
    ),
  ],
);

/**
 * One row per approved fire (PRD §18.4 ledger), written before Anthropic is called. The fire endpoint has no
 * idempotency key, so this row is the only guard against a second session: a repeat of the same Idempotency-Key
 * returns it, and a STARTING row with a live lease blocks another fire for the issue.
 */
export const cloudHandoffs = pgTable(
  "cloud_handoffs",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    issueNumber: integer("issue_number").notNull(),
    routineId: text("routine_id").notNull(),
    // Exactly what was sent as `text`, and the hash the owner approved.
    text: text("text").notNull(),
    actionHash: text("action_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    confirmResend: boolean("confirm_resend").notNull().default(false),
    status: text("status").$type<CloudHandoffStatus>().notNull(),
    // The fire call in progress holds this lease; a crashed one lapses and the row reads as UNKNOWN.
    lockedUntil: ts("locked_until"),
    // Only from Anthropic's 200 response.
    sessionId: text("session_id"),
    sessionUrl: text("session_url"),
    error: text("error"),
    retryAfterSeconds: integer("retry_after_seconds"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cloud_handoffs_idempotency_uq").on(t.idempotencyKey),
    index("cloud_handoffs_issue_idx").on(t.projectId, t.repositoryId, t.issueNumber, t.id),
  ],
);
export type CloudHandoffRow = typeof cloudHandoffs.$inferSelect;
