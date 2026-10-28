import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type {
  ConnectorEnvironment,
  ConnectorProvider,
  ConnectorStatus,
  MetricDictionary,
} from "@nexus/contracts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// Read-only business sources (FR-CON-01). The credential itself lives in a 0600 file named by credential_ref, never here.
export const businessConnectors = pgTable(
  "business_connectors",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    provider: text("provider").$type<ConnectorProvider>().notNull(),
    environment: text("environment").$type<ConnectorEnvironment>().notNull(),
    credentialRef: text("credential_ref").notNull(),
    schemaAllowlist: jsonb("schema_allowlist").$type<string[]>().notNull(),
    statementTimeoutMs: integer("statement_timeout_ms").notNull(),
    status: text("status").$type<ConnectorStatus>().notNull(),
    lastTestedAt: ts("last_tested_at"),
    lastError: text("last_error"),
    dictionary: jsonb("dictionary").$type<MetricDictionary>(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("business_connectors_scope_idx").on(t.workspaceId, t.projectId, t.id)],
);
export type BusinessConnectorRow = typeof businessConnectors.$inferSelect;
