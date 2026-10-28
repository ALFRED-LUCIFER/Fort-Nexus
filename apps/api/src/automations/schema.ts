import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AutomationAction, AutomationRun, JobType } from "@nexus/contracts";
import { user } from "../db/schema.ts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// An n8n service identity, bound to one project. Its signing key is derived from BETTER_AUTH_SECRET + id + key_version
// on demand and never stored (EPIC AUTO).
export const automationClients = pgTable(
  "automation_clients",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    allowedActions: jsonb("allowed_actions").$type<AutomationAction[]>().notNull(),
    allowedJobTypes: jsonb("allowed_job_types").$type<JobType[]>().notNull(),
    rateLimitPerMinute: integer("rate_limit_per_minute").notNull(),
    disabled: boolean("disabled").notNull().default(false),
    keyVersion: integer("key_version").notNull().default(1),
    lastUsedAt: ts("last_used_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("automation_clients_scope_idx").on(t.workspaceId, t.projectId, t.id)],
);

// Every authenticated trigger: ACCEPTED (its key is bound to the result) or REJECTED with the reason.
export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => automationClients.id),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    // null when the body failed validation.
    action: text("action").$type<AutomationAction>(),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    status: text("status").$type<AutomationRun["status"]>().notNull(),
    reason: text("reason"),
    result: jsonb("result").$type<NonNullable<AutomationRun["result"]>>(),
    correlationId: text("correlation_id").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [
    // Only an accepted run binds its key: a rejected one (e.g. emergency stop) may be retried with the same key.
    uniqueIndex("automation_runs_accepted_key_uq")
      .on(t.clientId, t.idempotencyKey)
      .where(sql`${t.status} = 'ACCEPTED'`),
    index("automation_runs_client_idx").on(t.clientId, t.id),
    index("automation_runs_scope_idx").on(t.workspaceId, t.projectId, t.id),
  ],
);
