import type { Db, Tx } from "./db/index.ts";
import { auditRecords } from "./db/schema.ts";

export type AuditEntry = {
  actor: string;
  action: string;
  resourceType:
    | "job"
    | "runner"
    | "github_account"
    | "approval"
    | "session"
    | "system"
    | "project"
    | "notification"
    | "research_watchlist"
    | "research_run"
    | "connector"
    | "conversation"
    | "action_proposal"
    | "monitored_app"
    | "incident"
    | "automation_client"
    | "automation_run"
    | "agent_profile"
    | "plan";
  resourceId: string;
  correlationId: string;
  outcome?: "SUCCEEDED" | "DENIED" | "FAILED";
  /** Must never contain secrets (tokens, codes, passwords); callers pass ids and enums only. */
  metadata?: Record<string, unknown>;
};

export const audit = (tx: Db | Tx, e: AuditEntry) =>
  tx.insert(auditRecords).values({ ...e, outcome: e.outcome ?? "SUCCEEDED", metadata: e.metadata ?? {} });
