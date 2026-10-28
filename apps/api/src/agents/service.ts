import { and, desc, eq, isNull, or } from "drizzle-orm";
import {
  AgentKey,
  AgentTool,
  TOOL_RISK,
  type AgentList,
  type AgentProfileSettings,
  type AgentProfileVersion,
  type AgentSummary,
  type EffectiveAgentProfile,
  type RiskTier,
  type SetAgentProfileRequest,
} from "@nexus/contracts";
import { audit } from "../audit.ts";
import type { Db } from "../db/index.ts";
import { workspaces } from "../db/schema.ts";
import { HttpError, notFound } from "../errors.ts";
import { canonical, ownerActor } from "../jobs.ts";
import { resolveProject, type ProjectScope } from "../workspaces.ts";
import { agentProfileVersions as versions } from "./schema.ts";

// EPIC AGT (FR-AGT-06/07), FR-WKS-04/05, PRD C-04 and §11.16: project version > workspace version > built-in default
// (whole settings per level), then the global ceiling narrows it. Settings never widen what the ceiling allows.

type VersionRow = typeof versions.$inferSelect;

const STANDARD = {
  engine: "MESSAGES_API",
  autonomy: "ACT_WITH_APPROVAL",
  maxCostUsdPerTask: 1,
  maxTurns: 10,
  responseDetail: "STANDARD",
} as const satisfies Partial<AgentProfileSettings>;

/** Built-in defaults: conservative tools per role; Product drafts only. */
export const DEFAULT_AGENT_SETTINGS: Record<AgentKey, AgentProfileSettings> = {
  CHIEF_OF_STAFF: { ...STANDARD, tools: [...AgentTool.options] },
  DEVELOPER: { ...STANDARD, tools: ["jobs.read", "jobs.create.issue_run", "github.read"] },
  QA: { ...STANDARD, tools: ["jobs.read", "github.read", "jobs.create.diagnostic"] },
  DEVOPS: { ...STANDARD, tools: ["monitoring.read", "jobs.read", "jobs.create.diagnostic"] },
  PRODUCT: { ...STANDARD, autonomy: "DRAFT", tools: ["github.read", "research.search"] },
  AI_RESEARCHER: { ...STANDARD, tools: ["research.search", "research.run"] },
  FINANCIAL_ANALYST: { ...STANDARD, tools: ["business.metrics"] },
};

export const AGENT_ROSTER: Record<AgentKey, { label: string; description: string }> = {
  CHIEF_OF_STAFF: {
    label: "Chief of Staff",
    description: "Turns a goal into a reviewable plan and hands its steps to the other agents.",
  },
  DEVELOPER: {
    label: "Developer",
    description: "Works on a scoped GitHub issue in a sandbox and returns branch, diff and test evidence.",
  },
  QA: {
    label: "QA",
    description: "Runs diagnostics and reads pull requests to report defects with evidence.",
  },
  DEVOPS: {
    label: "DevOps",
    description: "Reads app health and incidents and proposes recovery; changes nothing on its own.",
  },
  PRODUCT: {
    label: "Product",
    description: "Reads issues and research to draft requirements for your review.",
  },
  AI_RESEARCHER: {
    label: "AI researcher",
    description: "Searches and runs research watchlists and summarises sourced findings.",
  },
  FINANCIAL_ANALYST: {
    label: "Financial analyst",
    description: "Reads business metrics through read-only connectors.",
  },
};

// The global safety ceiling: server constants, not configurable.
export const CEILING = { maxCostUsdPerTask: 50, maxTurns: 200 } as const;
const CODING_ENGINE_AGENTS: readonly AgentKey[] = ["DEVELOPER", "QA"];
const LOW_RISK: readonly RiskTier[] = ["R0", "R1"];

/** Narrows stored settings to the global ceiling; `ceilingApplied` says what changed. */
export function applyCeiling(
  agent: AgentKey,
  stored: AgentProfileSettings,
  risk: Readonly<Record<AgentTool, RiskTier>> = TOOL_RISK,
): Pick<EffectiveAgentProfile, "settings" | "ceilingApplied"> {
  const settings = { ...stored };
  const ceilingApplied: string[] = [];
  const risky = settings.tools.filter((t) => !LOW_RISK.includes(risk[t]));
  if (settings.autonomy === "AUTONOMOUS" && risky.length > 0) {
    settings.autonomy = "ACT_WITH_APPROVAL";
    ceilingApplied.push(
      `AUTONOMOUS capped to ACT_WITH_APPROVAL: ${risky.join(", ")} always need your approval`,
    );
  }
  if (settings.engine === "CLAUDE_AGENT_SDK" && !CODING_ENGINE_AGENTS.includes(agent)) {
    settings.engine = "MESSAGES_API";
    ceilingApplied.push(
      "CLAUDE_AGENT_SDK capped to MESSAGES_API: only Developer and QA use the coding engine",
    );
  }
  if (settings.maxCostUsdPerTask > CEILING.maxCostUsdPerTask) {
    settings.maxCostUsdPerTask = CEILING.maxCostUsdPerTask;
    ceilingApplied.push(`maxCostUsdPerTask capped to ${CEILING.maxCostUsdPerTask}`);
  }
  if (settings.maxTurns > CEILING.maxTurns) {
    settings.maxTurns = CEILING.maxTurns;
    ceilingApplied.push(`maxTurns capped to ${CEILING.maxTurns}`);
  }
  return { settings, ceilingApplied };
}

const toEffective = (agent: AgentKey, row?: VersionRow): EffectiveAgentProfile => ({
  agent,
  versionId: row?.id ?? null,
  level: !row ? "DEFAULT" : row.projectId ? "PROJECT" : "WORKSPACE",
  version: row?.version ?? 0,
  ...applyCeiling(agent, row?.settings ?? DEFAULT_AGENT_SETTINGS[agent]),
});

const toVersionDto = (r: VersionRow): AgentProfileVersion => ({
  id: r.id,
  agent: r.agent,
  level: r.projectId ? "PROJECT" : "WORKSPACE",
  workspaceId: r.workspaceId,
  projectId: r.projectId,
  version: r.version,
  settings: r.settings,
  createdAt: r.createdAt.toISOString(),
});

/** A project's versions plus its workspace's (project_id null); never another project's. */
const inScope = (s: ProjectScope) =>
  and(
    eq(versions.workspaceId, s.workspaceId),
    or(eq(versions.projectId, s.projectId), isNull(versions.projectId)),
  );

/** Newest version per (agent, level) in the project's scope: at most two rows per agent. */
async function latestVersions(db: Db, s: ProjectScope, agent?: AgentKey) {
  const rows = await db
    .selectDistinctOn([versions.agent, versions.projectId])
    .from(versions)
    .where(and(inScope(s), agent ? eq(versions.agent, agent) : undefined))
    .orderBy(versions.agent, versions.projectId, desc(versions.version));
  return (a: AgentKey) =>
    toEffective(a, rows.find((r) => r.agent === a && r.projectId) ?? rows.find((r) => r.agent === a));
}

/** The agent's effective profile in a project (resolved read-only: 404 outside the owner's projects). */
export async function resolveAgentProfile(
  db: Db,
  ownerId: string,
  projectId: string,
  agent: AgentKey,
): Promise<EffectiveAgentProfile> {
  const scope = await resolveProject(db, ownerId, projectId);
  return (await latestVersions(db, scope, agent))(agent);
}

/** Exactly the pinned version (FR-WKS-05), even when newer ones exist; null = the built-in default. */
export async function pinnedAgentProfile(
  db: Db,
  agent: AgentKey,
  versionId: string | null,
): Promise<EffectiveAgentProfile> {
  if (!versionId) return toEffective(agent);
  const [row] = await db
    .select()
    .from(versions)
    .where(and(eq(versions.id, versionId), eq(versions.agent, agent)));
  if (!row) throw new Error(`pinned ${agent} profile version ${versionId} is missing`); // append-only: can't happen
  return toEffective(agent, row);
}

// Plan steps arrive with the Chief of Staff plans (wave 3 B); this is the one place that counts them.
async function agentRecords(_db: Db, _scope: ProjectScope): Promise<Map<AgentKey, AgentSummary["record"]>> {
  return new Map();
}

export async function listAgents(db: Db, ownerId: string, projectId: string): Promise<AgentList> {
  const scope = await resolveProject(db, ownerId, projectId);
  const [effective, records] = await Promise.all([latestVersions(db, scope), agentRecords(db, scope)]);
  return {
    items: AgentKey.options.map((agent) => ({
      agent,
      ...AGENT_ROSTER[agent],
      effective: effective(agent),
      record: records.get(agent) ?? { stepsSucceeded: 0, stepsFailed: 0, lastActiveAt: null },
    })),
  };
}

// shortcut: history shows the newest 100 versions of the scope; add paging if profiles change that often.
const HISTORY = 100;

export async function listVersions(
  db: Db,
  ownerId: string,
  projectId: string,
  agent: AgentKey,
): Promise<AgentProfileVersion[]> {
  const scope = await resolveProject(db, ownerId, projectId);
  const rows = await db
    .select()
    .from(versions)
    .where(and(inScope(scope), eq(versions.agent, agent)))
    .orderBy(desc(versions.id))
    .limit(HISTORY);
  return rows.map(toVersionDto);
}

/**
 * Appends version n+1 at exactly one level. The settings are stored as asked (the ceiling applies on resolution);
 * a PUT repeating the latest settings at that level appends nothing and returns that version.
 */
export async function setAgentProfile(
  db: Db,
  input: { ownerId: string; agent: AgentKey; body: SetAgentProfileRequest; correlationId: string },
): Promise<AgentProfileVersion> {
  const { level } = input.body;
  // One canonical tool order, so equal settings compare equal.
  const settings = {
    ...input.body.settings,
    tools: AgentTool.options.filter((t) => input.body.settings.tools.includes(t)),
  };
  return db.transaction(async (tx) => {
    let workspaceId: string;
    let projectId: string | null = null;
    if (level.kind === "PROJECT") {
      ({ workspaceId, projectId } = await resolveProject(tx, input.ownerId, level.projectId, {
        write: true,
      }));
    } else {
      const [ws] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.id, level.workspaceId), eq(workspaces.ownerId, input.ownerId)));
      if (!ws) throw notFound("Workspace");
      workspaceId = ws.id;
    }
    const [latest] = await tx
      .select()
      .from(versions)
      .where(
        and(
          eq(versions.agent, input.agent),
          eq(versions.workspaceId, workspaceId),
          projectId ? eq(versions.projectId, projectId) : isNull(versions.projectId),
        ),
      )
      .orderBy(desc(versions.version))
      .limit(1);
    if (latest && canonical(latest.settings) === canonical(settings)) return toVersionDto(latest);
    const [row] = await tx
      .insert(versions)
      .values({
        workspaceId,
        projectId,
        agent: input.agent,
        version: (latest?.version ?? 0) + 1,
        settings,
        createdBy: ownerActor(input.ownerId),
      })
      .onConflictDoNothing()
      .returning();
    if (!row)
      throw new HttpError(
        409,
        "CONFLICT",
        "This profile was saved elsewhere at the same time. Reload and save again.",
      );
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: "agent_profile.set",
      resourceType: "agent_profile",
      resourceId: row.id,
      correlationId: input.correlationId,
      metadata: {
        workspaceId,
        projectId,
        agent: row.agent,
        level: level.kind,
        version: row.version,
        autonomy: settings.autonomy,
        engine: settings.engine,
        tools: settings.tools,
      },
    });
    return toVersionDto(row);
  });
}
