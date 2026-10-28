import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AgentKey, PlanStatus, PlanStepAction, PlanStepStatus, StepArtifact } from "@nexus/contracts";
import { jobs, projects, user } from "../db/schema.ts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
// Postgres 18 uuidv7(): time-ordered ids double as the newest-first order.
const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`);
const scope = () => ({
  workspaceId: uuid("workspace_id").notNull(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
});

// EPIC AGT FR-AGT-01/09: a Chief of Staff plan. Row first (claims the Idempotency-Key), steps once drafted.
export const plans = pgTable(
  "plans",
  {
    id: id(),
    ...scope(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    goal: text("goal").notNull(),
    status: text("status").$type<PlanStatus>().notNull().default("DRAFT"),
    // null while the model is drafting: such a row is a claim, never shown or approvable.
    planHash: text("plan_hash"),
    profileVersionId: uuid("profile_version_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    decidedAt: ts("decided_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    uniqueIndex("plans_owner_idempotency_uq").on(t.ownerId, t.idempotencyKey),
    index("plans_scope_idx").on(t.workspaceId, t.projectId, t.id),
    index("plans_active_idx")
      .on(t.id)
      .where(sql`${t.status} in ('APPROVED', 'RUNNING')`),
  ],
);

export const planSteps = pgTable(
  "plan_steps",
  {
    id: id(),
    ...scope(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    title: text("title").notNull(),
    agent: text("agent").$type<AgentKey>().notNull(),
    action: jsonb("action").$type<PlanStepAction>().notNull(),
    dependsOn: jsonb("depends_on").$type<number[]>().notNull(),
    status: text("status").$type<PlanStepStatus>().notNull().default("PENDING"),
    blockedReason: text("blocked_reason"),
    // The source record a running step waits on; success is read from it, never from agent text.
    jobId: uuid("job_id").references(() => jobs.id),
    researchRunId: uuid("research_run_id"),
    artifact: jsonb("artifact").$type<StepArtifact>(),
    error: text("error"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    uniqueIndex("plan_steps_plan_index_uq").on(t.planId, t.index),
    index("plan_steps_running_idx")
      .on(t.planId)
      .where(sql`${t.status} = 'RUNNING'`),
    index("plan_steps_agent_idx").on(t.projectId, t.agent),
  ],
);
