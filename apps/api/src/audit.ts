import type { Db, Tx } from "./db/index.ts";
import { auditRecords } from "./db/schema.ts";

export type AuditEntry = {
  actor: string;
  action: string;
  resourceType: "job" | "runner" | "github_account" | "approval";
  resourceId: string;
  correlationId: string;
  outcome?: "SUCCEEDED" | "DENIED" | "FAILED";
  /** Must never contain secrets (tokens, codes, passwords); callers pass ids and enums only. */
  metadata?: Record<string, unknown>;
};

export const audit = (tx: Db | Tx, e: AuditEntry) =>
  tx.insert(auditRecords).values({ ...e, outcome: e.outcome ?? "SUCCEEDED", metadata: e.metadata ?? {} });
