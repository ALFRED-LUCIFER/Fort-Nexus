import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  JobDraft,
  JobDraftBudget,
  JobDraftKind,
  JobDraftPreview,
  JobDraftStatus,
} from "@nexus/contracts";
import { jobs, user } from "../db/schema.ts";

// Jobs wave B (FR-CMD-02/04/05, FR-CXR-09, CMD-G01): a job described in plain words, drafted by the Developer agent,
// approved by its exact preview. `text` and the drafted issue are untrusted (owner text and model output).

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** DRAFTING: the row claims its Idempotency-Key while the model call runs; never shown, removed if it fails. */
export type JobDraftRowStatus = JobDraftStatus | "DRAFTING";

export const jobDrafts = pgTable(
  "job_drafts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").$type<JobDraftRowStatus>().notNull(),
    text: text("text").notNull(),
    kind: text("kind").$type<JobDraftKind>(),
    repositoryId: text("repository_id"),
    repositoryFullName: text("repository_full_name"),
    candidates: jsonb("candidates").$type<JobDraft["candidates"]>().notNull().default([]),
    issueTitle: text("issue_title"),
    issueBody: text("issue_body"),
    issueNumber: integer("issue_number"),
    budget: jsonb("budget").$type<JobDraftBudget>().notNull(),
    unsupportedReason: text("unsupported_reason"),
    // The latest preview: the only hash an approval can name, until it expires or the draft changes.
    previewHash: text("preview_hash"),
    preview: jsonb("preview").$type<JobDraftPreview>(),
    previewRunnerId: uuid("preview_runner_id"),
    previewExpiresAt: ts("preview_expires_at"),
    // The approval in flight holds this lease (claimed_at + lease); a crashed one's lease lapses.
    claimedAt: ts("claimed_at"),
    // GitHub create-issue attempts started; > 0 means an earlier one may have created it (look for its marker first).
    attempt: integer("attempt").notNull().default(0),
    approveIdempotencyKey: text("approve_idempotency_key"),
    approveHash: text("approve_hash"),
    // Set only from GitHub's response.
    createdIssueNumber: integer("created_issue_number"),
    createdIssueUrl: text("created_issue_url"),
    jobId: uuid("job_id").references(() => jobs.id),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("job_drafts_owner_key_uq").on(t.ownerId, t.idempotencyKey),
    index("job_drafts_project_idx").on(t.projectId, t.id),
  ],
);
