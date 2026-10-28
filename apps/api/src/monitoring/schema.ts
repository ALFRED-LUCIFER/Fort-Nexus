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
import type {
  CheckError,
  ConnectorEnvironment,
  Incident,
  IncidentStatus,
  IncidentTriage,
} from "@nexus/contracts";
import { projects } from "../db/schema.ts";

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

export const monitoredApps = pgTable(
  "monitored_apps",
  {
    id: id(),
    ...scope(),
    name: text("name").notNull(),
    environment: text("environment").$type<ConnectorEnvironment>().notNull(),
    healthUrl: text("health_url").notNull(),
    repositoryId: text("repository_id"),
    intervalSeconds: integer("interval_seconds").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    failureThreshold: integer("failure_threshold").notNull(),
    disabled: boolean("disabled").notNull().default(false),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastCheckedAt: ts("last_checked_at"),
    // The scheduler claims an app by moving this forward, so racing ticks never check it twice.
    nextCheckAt: ts("next_check_at").notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("monitored_apps_scope_idx").on(t.workspaceId, t.projectId, t.id),
    index("monitored_apps_due_idx")
      .on(t.nextCheckAt)
      .where(sql`not ${t.disabled}`),
  ],
);

export const incidents = pgTable(
  "incidents",
  {
    id: id(),
    ...scope(),
    appId: uuid("app_id")
      .notNull()
      .references(() => monitoredApps.id),
    fingerprint: text("fingerprint").notNull(),
    severity: text("severity").$type<Incident["severity"]>().notNull(),
    status: text("status").$type<IncidentStatus>().notNull().default("OPEN"),
    title: text("title").notNull(),
    openedAt: ts("opened_at").notNull().defaultNow(),
    acknowledgedAt: ts("acknowledged_at"),
    recoveredAt: ts("recovered_at"),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [
    // MON-G01 / FR-MON-06: exactly one active incident per fingerprint, even when checkers race.
    uniqueIndex("incidents_active_fingerprint_uq")
      .on(t.fingerprint)
      .where(sql`${t.status} <> 'RESOLVED'`),
    index("incidents_scope_idx").on(t.workspaceId, t.projectId, t.id),
    index("incidents_app_idx").on(t.appId, t.id),
  ],
);

export const healthChecks = pgTable(
  "health_checks",
  {
    id: id(),
    ...scope(),
    appId: uuid("app_id")
      .notNull()
      .references(() => monitoredApps.id),
    // Set when the check is evidence of an incident.
    incidentId: uuid("incident_id").references(() => incidents.id),
    checkedAt: ts("checked_at").notNull().defaultNow(),
    ok: boolean("ok").notNull(),
    statusCode: integer("status_code"),
    latencyMs: integer("latency_ms"),
    error: text("error").$type<CheckError>(),
  },
  (t) => [
    index("health_checks_app_idx").on(t.appId, t.id),
    index("health_checks_incident_idx").on(t.incidentId, t.id),
  ],
);

// FR-MON-07: one AI triage per incident, written once. The row is the claim: it exists from the moment one request
// starts the model call, so a racing request never calls the model too.
export const incidentTriages = pgTable(
  "incident_triages",
  {
    id: id(),
    ...scope(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id),
    model: text("model").notNull(),
    profileVersionId: uuid("profile_version_id"),
    claimedAt: ts("claimed_at").notNull(),
    // null while the model call is in flight; the validated tool output once it succeeded.
    result: jsonb("result").$type<Pick<IncidentTriage, "hypotheses" | "suggestedNextStep">>(),
    createdAt: ts("created_at"),
  },
  (t) => [uniqueIndex("incident_triages_incident_uq").on(t.incidentId)],
);
