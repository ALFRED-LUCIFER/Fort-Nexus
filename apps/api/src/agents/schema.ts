import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { AgentKey, AgentProfileSettings } from "@nexus/contracts";
import { projects, workspaces } from "../db/schema.ts";

// FR-WKS-05: every saved profile is an immutable version (append-only trigger in its migration), so a conversation
// or plan that pinned one keeps exactly what it started with.
export const agentProfileVersions = pgTable(
  "agent_profile_versions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    // null = the workspace-level profile.
    projectId: uuid("project_id").references(() => projects.id),
    agent: text("agent").$type<AgentKey>().notNull(),
    version: integer("version").notNull(),
    // What the owner asked for; the global ceiling is applied when it is resolved, never baked in here.
    settings: jsonb("settings").$type<AgentProfileSettings>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT: workspace-level rows (project_id null) are numbered uniquely too.
    unique("agent_profile_versions_uq").on(t.agent, t.workspaceId, t.projectId, t.version).nullsNotDistinct(),
  ],
);
