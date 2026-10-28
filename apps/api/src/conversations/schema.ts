import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid, jsonb } from "drizzle-orm/pg-core";
import type { Basis, Intent, ProposalStatus, ProposedAction, SourceRef } from "@nexus/contracts";
import { jobs, user } from "../db/schema.ts";

// EPIC CWV/CXR text Talk. Every row carries workspace_id + project_id (Part B rule 5).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`);
const scope = () => ({
  workspaceId: uuid("workspace_id").notNull(),
  projectId: uuid("project_id").notNull(),
});

export const conversationThreads = pgTable(
  "conversation_threads",
  {
    id: id(),
    ...scope(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    title: text("title").notNull(),
    // Set only from a verified source (a job row read or created by NEXUS), never by the model.
    subjectJobId: uuid("subject_job_id").references(() => jobs.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("conversation_threads_scope_idx").on(t.workspaceId, t.projectId, t.ownerId, t.id)],
);

// Append-only (trigger in its migration).
export const conversationTurns = pgTable(
  "conversation_turns",
  {
    id: id(),
    ...scope(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => conversationThreads.id),
    role: text("role").$type<"USER" | "ASSISTANT">().notNull(),
    text: text("text").notNull(),
    intent: jsonb("intent").$type<Intent>(),
    basis: text("basis").$type<Basis>().notNull(),
    sources: jsonb("sources").$type<SourceRef[]>().notNull(),
    proposalId: uuid("proposal_id"),
    // USER turns: the client's Idempotency-Key and the hash of its body. ASSISTANT turns: the turn answered.
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    replyTo: uuid("reply_to"),
    correlationId: text("correlation_id").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("conversation_turns_thread_idx").on(t.threadId, t.id),
    uniqueIndex("conversation_turns_idempotency_uq")
      .on(t.threadId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    uniqueIndex("conversation_turns_reply_uq")
      .on(t.replyTo)
      .where(sql`${t.replyTo} is not null`),
  ],
);

// PRD C-09 proposals. action/action_hash are immutable (trigger in its migration).
export const actionProposals = pgTable(
  "action_proposals",
  {
    id: id(),
    ...scope(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => conversationThreads.id),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => conversationTurns.id),
    riskTier: text("risk_tier").$type<"R0" | "R1" | "R2" | "R3">().notNull(),
    action: jsonb("action").$type<ProposedAction>().notNull(),
    actionHash: text("action_hash").notNull(),
    status: text("status").$type<ProposalStatus>().notNull(),
    expiresAt: ts("expires_at").notNull(),
    decidedAt: ts("decided_at"),
    decidedBy: text("decided_by"),
    resultJobId: uuid("result_job_id").references(() => jobs.id),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("action_proposals_thread_idx").on(t.threadId)],
);
