import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  Approval,
  ApprovalStatus,
  ChangesetFile,
  CreateJobRequest,
  IssueSnapshot,
  JobOutcome,
  JobStatus,
  JobType,
  NotificationCategory,
  NotificationStatus,
  RiskTier,
  RunEventType,
  PushDraftPrAction,
  RunStage,
  UploadChangesetRequest,
  WorkspaceMode,
} from "@nexus/contracts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
// Postgres 18 uuidv7(): time-ordered ids double as the newest-first list cursor.
const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`);

// ── Better Auth core tables (keys must match Better Auth's field names for the drizzle adapter) ──
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ── NEXUS ──
export const runners = pgTable(
  "runners",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    name: text("name").notNull(),
    os: text("os").notNull(),
    version: text("version").notNull(),
    capacity: integer("capacity").notNull(),
    tokenHash: text("token_hash").notNull().unique(), // sha-256 hex; the token itself is never stored
    revokedAt: ts("revoked_at"),
    lastHeartbeatAt: ts("last_heartbeat_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("runners_owner_idx").on(t.ownerId)],
);

export const runnerPairingCodes = pgTable("runner_pairing_codes", {
  id: id(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id),
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  runnerId: uuid("runner_id").references(() => runners.id),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// FR-WKS-01..03: exactly one DEV and one BUSINESS workspace per owner; projects are the hard scope boundary.
export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    mode: text("mode").$type<WorkspaceMode>().notNull(),
    name: text("name").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspaces_owner_mode_uq").on(t.ownerId, t.mode),
    check("workspaces_mode_valid", sql`${t.mode} in ('DEV', 'BUSINESS')`),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    archivedAt: ts("archived_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("projects_workspace_slug_uq").on(t.workspaceId, t.slug)],
);

// Explicit repository bindings (GitHub repo id); a repo may be bound to several projects.
export const projectRepositories = pgTable(
  "project_repositories",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    repositoryId: text("repository_id").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.repositoryId] })],
);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    initiatorId: text("initiator_id")
      .notNull()
      .references(() => user.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    jobType: text("job_type").$type<JobType>().notNull(),
    status: text("status").$type<JobStatus>().notNull(),
    riskTier: text("risk_tier").$type<RiskTier>().notNull(),
    request: jsonb("request").$type<CreateJobRequest>().notNull(),
    requestHash: text("request_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    targetRunnerId: uuid("target_runner_id").references(() => runners.id),
    runnerId: uuid("runner_id").references(() => runners.id),
    fencingToken: integer("fencing_token").notNull().default(0),
    leaseExpiresAt: ts("lease_expires_at"),
    cancelRequestedAt: ts("cancel_requested_at"),
    outcome: text("outcome").$type<JobOutcome>(),
    // DEV_ISSUE_TO_PR: the issue and base commit pinned at creation (FR-GH-09).
    issueSnapshot: jsonb("issue_snapshot").$type<IssueSnapshot>(),
    // Sum of the runner's summary-event cost estimates (FR-OBS-03); null until one arrives.
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6, mode: "number" }),
    stateVersion: integer("state_version").notNull().default(0),
    lastEventSequence: integer("last_event_sequence").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jobs_initiator_idempotency_key_uq").on(t.initiatorId, t.idempotencyKey),
    index("jobs_status_created_idx").on(t.status, t.createdAt),
    index("jobs_initiator_id_idx").on(t.initiatorId, t.id),
    index("jobs_project_id_idx").on(t.projectId, t.id),
    index("jobs_lease_idx")
      .on(t.leaseExpiresAt)
      .where(sql`${t.leaseExpiresAt} is not null`),
  ],
);

// Append-only (enforced by trigger in the append_only migration).
export const runEvents = pgTable(
  "run_events",
  {
    id: id(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    sequence: integer("sequence").notNull(),
    occurredAt: ts("occurred_at").notNull(),
    type: text("type").$type<RunEventType>().notNull(),
    stage: text("stage").$type<RunStage>(),
    actor: text("actor").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    recordedAt: ts("recorded_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("run_events_job_sequence_uq").on(t.jobId, t.sequence)],
);

// Runner append batches already applied; the primary key makes retried batches no-ops.
export const runEventBatches = pgTable(
  "run_event_batches",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    batchId: uuid("batch_id").notNull(),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runners.id),
    appliedAt: ts("applied_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.batchId] })],
);

// Append-only (enforced by trigger in the append_only migration). metadata must already be redacted.
export const auditRecords = pgTable(
  "audit_records",
  {
    id: id(),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    outcome: text("outcome").notNull(),
    correlationId: text("correlation_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("audit_resource_idx").on(t.resourceType, t.resourceId)],
);

// ENG-07: what the runner proposed for an issue job, exactly as uploaded. Append-only (trigger in its migration).
export const changesets = pgTable("changesets", {
  jobId: uuid("job_id")
    .primaryKey()
    .references(() => jobs.id),
  runnerId: uuid("runner_id")
    .notNull()
    .references(() => runners.id),
  fencingToken: integer("fencing_token").notNull(),
  baseSha: text("base_sha").notNull(),
  sha256: text("sha256").notNull(),
  files: jsonb("files").$type<ChangesetFile[]>().notNull(),
  stats: jsonb("stats").$type<UploadChangesetRequest["stats"]>().notNull(),
  agentSummary: text("agent_summary").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// Owner approvals of exact actions (FR-INB-02). action/action_hash are immutable (trigger in its migration).
export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    // Always the job's project (frozen by trigger like the action).
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    riskTier: text("risk_tier").$type<Approval["riskTier"]>().notNull(),
    status: text("status").$type<ApprovalStatus>().notNull(),
    action: jsonb("action").$type<PushDraftPrAction>().notNull(),
    actionHash: text("action_hash").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    decidedAt: ts("decided_at"),
    decidedBy: text("decided_by"),
    result: jsonb("result").$type<NonNullable<Approval["result"]>>(),
    error: text("error"),
  },
  (t) => [
    index("approvals_job_idx").on(t.jobId),
    index("approvals_status_idx").on(t.status, t.expiresAt),
    index("approvals_project_idx").on(t.projectId, t.id),
  ],
);

// External write ledger (PRD §18.4): one row per idempotent action key, written before the provider is called.
export const externalActions = pgTable("external_actions", {
  id: id(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id),
  approvalId: uuid("approval_id")
    .notNull()
    .references(() => approvals.id),
  provider: text("provider").notNull(),
  operation: text("operation").notNull(),
  status: text("status").$type<"PENDING" | "SUCCEEDED" | "FAILED">().notNull(),
  // Recorded before the branch ref is created, so a retry can tell its own ref from someone else's.
  commitSha: text("commit_sha"),
  externalId: text("external_id"),
  result: jsonb("result").$type<NonNullable<Approval["result"]>>(),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// Owner-level safety controls: exactly one row (id = 1), seeded by its migration (FR-INB-04, FR-SEC-08).
export const systemControls = pgTable(
  "system_controls",
  {
    id: integer("id").primaryKey(),
    emergencyStopEngaged: boolean("emergency_stop_engaged").notNull().default(false),
    emergencyStopChangedAt: ts("emergency_stop_changed_at"),
    dailyBudgetUsd: numeric("daily_budget_usd", { precision: 12, scale: 6, mode: "number" })
      .notNull()
      .default(20),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("system_controls_singleton", sql`${t.id} = 1`),
    check("system_controls_budget_positive", sql`${t.dailyBudgetUsd} > 0`),
  ],
);

// FR-NTF-01/02: one row per verified event, written in the event's transaction; dedup_key makes replays no-ops.
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    // null only for owner-wide notices (emergency stop, runner revoked).
    projectId: uuid("project_id").references(() => projects.id),
    category: text("category").$type<NotificationCategory>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    jobId: uuid("job_id").references(() => jobs.id),
    approvalId: uuid("approval_id").references(() => approvals.id),
    dedupKey: text("dedup_key").notNull().unique(),
    status: text("status").$type<NotificationStatus>().notNull().default("UNREAD"),
    statusChangedAt: ts("status_changed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("notifications_owner_idx").on(t.ownerId, t.id),
    index("notifications_owner_unread_idx")
      .on(t.ownerId)
      .where(sql`${t.status} = 'UNREAD'`),
    check(
      "notifications_category_valid",
      sql`${t.category} in ('INFORMATIONAL', 'TASK_DONE', 'TASK_FAILED', 'APPROVAL_REQUIRED', 'BUSINESS_EXCEPTION', 'SECURITY_CRITICAL')`,
    ),
    check("notifications_status_valid", sql`${t.status} in ('UNREAD', 'READ', 'ACKNOWLEDGED')`),
  ],
);
