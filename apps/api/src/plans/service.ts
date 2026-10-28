import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  AgentKey,
  IssueListQuery,
  toolForAction,
  type CreatePlanRequest,
  type EffectiveAgentProfile,
  type Plan,
  type PlanDecisionRequest,
  type PlanStep,
  type PlanStepAction,
} from "@nexus/contracts";
import { loadAi } from "../ai.ts";
import type { Deps } from "../app.ts";
import { audit } from "../audit.ts";
import type { Db, Tx } from "../db/index.ts";
import { HttpError, notFound } from "../errors.ts";
import { listConnectors } from "../business/connectors.ts";
import { canonical, cancelJob, ownerActor, sha256 } from "../jobs.ts";
import { listWatchlists } from "../research/service.ts";
import { boundRepositoryIds, ownerWorkspaceIds, resolveProject, type ProjectScope } from "../workspaces.ts";
import { resolveAgentProfile } from "../agents/service.ts";
import { draftPlan, type DraftPlan } from "./draft.ts";
import { planSteps, plans } from "./schema.ts";

// EPIC AGT FR-AGT-01/09, PRD §11.7: draft (model) → block + hash (server) → approve the exact hash (owner).

export type PlanRow = typeof plans.$inferSelect;
export type StepRow = typeof planSteps.$inferSelect;

const LIST_LIMIT = 50;
const CATALOG_ISSUES = 20;
const iso = (d: Date | null) => d?.toISOString() ?? null;

export const AGENT_LABEL: Record<AgentKey, string> = {
  CHIEF_OF_STAFF: "Chief of Staff",
  DEVELOPER: "Developer",
  QA: "QA",
  DEVOPS: "DevOps",
  PRODUCT: "Product",
  AI_RESEARCHER: "AI researcher",
  FINANCIAL_ANALYST: "Financial analyst",
};

const toStepDto = (s: StepRow): PlanStep => ({
  index: s.index,
  title: s.title,
  agent: s.agent,
  action: s.action,
  dependsOn: s.dependsOn,
  status: s.status,
  blockedReason: s.blockedReason,
  artifact: s.artifact,
  error: s.error,
});

const toPlanDto = (p: PlanRow, steps: StepRow[]): Plan => ({
  id: p.id,
  projectId: p.projectId,
  goal: p.goal,
  status: p.status,
  steps: steps.filter((s) => s.planId === p.id).map(toStepDto),
  planHash: p.planHash!,
  profileVersionId: p.profileVersionId,
  createdAt: p.createdAt.toISOString(),
  decidedAt: iso(p.decidedAt),
  finishedAt: iso(p.finishedAt),
});

/** sha256 of the canonical steps (index, title, agent, action, dependsOn): what the owner approves. */
export const planHash = (steps: DraftPlan["steps"]) =>
  sha256(
    canonical(
      steps.map((s, index) => ({
        index,
        title: s.title,
        agent: s.agent,
        action: s.action,
        dependsOn: s.dependsOn,
      })),
    ),
  );

/** Why a profile can't run this action now (missing tool, autonomy that only suggests or drafts, budget above its caps). */
export function profileBlock(p: EffectiveAgentProfile, action: PlanStepAction): string | null {
  const tool = toolForAction(action);
  const who = AGENT_LABEL[p.agent];
  if (!p.settings.tools.includes(tool)) return `${who}'s profile doesn't allow ${tool}`;
  if (p.settings.autonomy === "SUGGEST" || p.settings.autonomy === "DRAFT")
    return `${who}'s autonomy is ${p.settings.autonomy}: it can't act, only ${p.settings.autonomy === "DRAFT" ? "draft" : "suggest"}`;
  const budget =
    action.type === "jobs.create" && action.request.jobType === "DEV_ISSUE_TO_PR" && action.request.budget;
  if (budget && (budget.maxCostUsd > p.settings.maxCostUsdPerTask || budget.maxTurns > p.settings.maxTurns))
    return `${who}'s profile caps a task at $${p.settings.maxCostUsdPerTask} and ${p.settings.maxTurns} turns`;
  return null;
}

/** Narrows an issue run's budget to the agent's caps before hashing, so the owner approves the budget that will run. */
export function fitBudget(p: EffectiveAgentProfile, action: PlanStepAction): PlanStepAction {
  if (action.type !== "jobs.create" || action.request.jobType !== "DEV_ISSUE_TO_PR") return action;
  const b = action.request.budget;
  return {
    ...action,
    request: {
      ...action.request,
      budget: {
        ...b,
        maxCostUsd: Math.min(b.maxCostUsd, p.settings.maxCostUsdPerTask),
        maxTurns: Math.min(b.maxTurns, p.settings.maxTurns),
      },
    },
  };
}

type Targets = {
  scope: ProjectScope;
  bound: Set<string>;
  /** Open issue numbers NEXUS listed per bound repository; null when GitHub couldn't list them. */
  issues: Map<string, Set<number> | null>;
  watchlists: Set<string>;
  connectors: Set<string>;
};

function targetBlock(t: Targets, a: PlanStepAction): string | null {
  if (a.type === "research.run")
    return t.watchlists.has(a.watchlistId) ? null : "unknown watchlist: it isn't in this project";
  if (a.type === "business.sales_summary")
    return t.connectors.has(a.connectorId) ? null : "unknown business connector: it isn't in this project";
  const r = a.request;
  if (r.projectId !== t.scope.projectId) return "the job targets another project";
  if (r.runnerId) return "plans don't pin a runner";
  if (r.jobType === "RUNNER_DIAGNOSTIC") return null;
  if (t.scope.mode !== "DEV") return "issue runs need a Dev project";
  if (!t.bound.has(r.repositoryId)) return `repository ${r.repositoryId} isn't bound to this project`;
  const open = t.issues.get(r.repositoryId);
  if (!open) return "NEXUS couldn't list this repository's open issues";
  return open.has(r.issueNumber) ? null : `issue #${r.issueNumber} isn't an open issue NEXUS listed`;
}

/** What the planner may target in the project: a deterministic read of the existing modules. */
async function catalog(deps: Pick<Deps, "db" | "github" | "config">, ownerId: string, scope: ProjectScope) {
  const { db } = deps;
  const bound = await boundRepositoryIds(db, ownerId, scope.projectId);
  // GitHub being down only loses names and issues: the repositories stay listed and their issue runs get blocked.
  const repos =
    bound.size && deps.github
      ? await deps.github.repositories().then(
          (l) => l.items,
          () => [],
        )
      : [];
  const issues = new Map<string, Set<number> | null>();
  const repositories = [];
  for (const id of bound) {
    const repo = repos.find((r) => r.id === id);
    const list = deps.github
      ? await deps.github
          .issues(id, IssueListQuery.parse({}))
          .then((l) => l.items.slice(0, CATALOG_ISSUES))
          .catch(() => null) // unlisted issues are blocked as unknown targets, never guessed
      : null;
    issues.set(id, list && new Set(list.map((i) => i.number)));
    repositories.push({
      repositoryId: id,
      fullName: repo?.fullName ?? null,
      openIssues: list?.map((i) => ({ number: i.number, title: i.title })) ?? "unavailable",
    });
  }
  const watchlists = await listWatchlists(db, ownerId, scope.projectId);
  const connectors = (
    await listConnectors({
      db,
      connectorsDir: deps.config.connectorsDir,
      actor: ownerActor(ownerId),
      correlationId: "plan-catalog",
      ownerId,
      projectId: scope.projectId,
    })
  ).filter((c) => c.hasDictionary);
  const targets: Targets = {
    scope,
    bound,
    issues,
    watchlists: new Set(watchlists.map((w) => w.id)),
    connectors: new Set(connectors.map((c) => c.id)),
  };
  const data = {
    projectId: scope.projectId,
    workspaceMode: scope.mode,
    diagnosticPresets: ["host-info", "node-version", "git-version"],
    repositories,
    watchlists: watchlists.map((w) => ({ id: w.id, name: w.name, keywords: w.keywords })),
    connectors: connectors.map((c) => ({ id: c.id, name: c.name, environment: c.environment })),
    toolForAction: {
      "jobs.create RUNNER_DIAGNOSTIC": "jobs.create.diagnostic",
      "jobs.create DEV_ISSUE_TO_PR": "jobs.create.issue_run",
      "research.run": "research.run",
      "business.sales_summary": "business.metrics",
    },
  };
  return { targets, data };
}

const byOwner = (ownerId: string, id: string) =>
  and(eq(plans.id, id), eq(plans.ownerId, ownerId), isNotNull(plans.planHash));

async function stepsOf(db: Db | Tx, ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(planSteps).where(inArray(planSteps.planId, ids)).orderBy(asc(planSteps.index));
}

// ── Owner operations ──

export async function createPlan(
  deps: Pick<Deps, "db" | "github" | "config">,
  input: { ownerId: string; idempotencyKey: string; body: CreatePlanRequest; correlationId: string },
): Promise<Plan> {
  const { db } = deps;
  const { ownerId, body } = input;
  const scope = await resolveProject(db, ownerId, body.projectId, { write: true });
  const requestHash = sha256(canonical(body));
  const byKey = and(eq(plans.ownerId, ownerId), eq(plans.idempotencyKey, input.idempotencyKey));
  const replay = async (p: PlanRow) => {
    if (p.requestHash !== requestHash)
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key was already used with a different goal",
      );
    if (!p.planHash)
      throw new HttpError(
        409,
        "CONFLICT",
        "This plan is still being drafted. If nothing appears, try again shortly.",
      );
    return toPlanDto(p, await stepsOf(db, [p.id]));
  };
  const [existing] = await db.select().from(plans).where(byKey);
  if (existing) return replay(existing);

  const ai = await loadAi(deps.config.aiFile); // 409 with the runbook path until ai.json exists
  const profiles = new Map<AgentKey, EffectiveAgentProfile>();
  for (const agent of AgentKey.options)
    profiles.set(agent, await resolveAgentProfile(db, ownerId, scope.projectId, agent));
  const chief = profiles.get("CHIEF_OF_STAFF")!;
  const model = chief.settings.model ?? ai.model;

  // The row claims the key before the paid call, so a concurrent retry never pays twice.
  // shortcut: a process crash during the model call leaves this claim, so that one key answers 409 for good (a new key
  // works); expire claims older than a few minutes if it ever happens.
  const [claim] = await db
    .insert(plans)
    .values({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ownerId,
      goal: body.goal,
      profileVersionId: chief.versionId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
    })
    .onConflictDoNothing({ target: [plans.ownerId, plans.idempotencyKey] })
    .returning();
  if (!claim) {
    const [raced] = await db.select().from(plans).where(byKey);
    return replay(raced!);
  }

  const record = (tx: Db | Tx, outcome: "SUCCEEDED" | "FAILED", extra: Record<string, unknown> = {}) =>
    audit(tx, {
      actor: ownerActor(ownerId),
      action: "plan.draft",
      resourceType: "plan",
      resourceId: claim.id,
      correlationId: input.correlationId,
      outcome,
      // Never the goal, prompt or model output.
      metadata: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        agent: "CHIEF_OF_STAFF",
        profileVersionId: chief.versionId,
        model,
        ...extra,
      },
    });
  try {
    const { targets, data } = await catalog(deps, ownerId, scope);
    const drafted = await draftPlan(ai, model, {
      goal: body.goal,
      catalog: {
        ...data,
        agents: AgentKey.options.map((a) => ({
          agent: a,
          tools: profiles.get(a)!.settings.tools,
          autonomy: profiles.get(a)!.settings.autonomy,
        })),
      },
    });
    if ("failure" in drafted) {
      await db.transaction(async (tx) => {
        await tx.delete(plans).where(eq(plans.id, claim.id)); // nothing was produced: the key may be retried
        await record(tx, "FAILED", { reason: drafted.provider ? "provider_error" : "invalid_output" });
      });
      throw new HttpError(
        drafted.provider ? 502 : 422,
        drafted.provider ? "INTERNAL" : "VALIDATION_FAILED",
        drafted.failure,
      );
    }
    const fitted = drafted.plan.steps.map((s) => ({
      ...s,
      action: fitBudget(profiles.get(s.agent)!, s.action),
    }));
    const steps = fitted.map((s, index) => {
      const reasons = [targetBlock(targets, s.action), profileBlock(profiles.get(s.agent)!, s.action)].filter(
        Boolean,
      );
      return { ...s, index, blockedReason: reasons.length ? reasons.join("; ") : null };
    });
    const hash = planHash(fitted);
    return await db.transaction(async (tx) => {
      const rows = await tx
        .insert(planSteps)
        .values(
          steps.map((s) => ({
            ...s,
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            planId: claim.id,
          })),
        )
        .returning();
      const [plan] = await tx.update(plans).set({ planHash: hash }).where(eq(plans.id, claim.id)).returning();
      await record(tx, "SUCCEEDED", {
        steps: steps.length,
        blocked: steps.filter((s) => s.blockedReason).length,
        planHash: hash,
      });
      return toPlanDto(plan!, rows);
    });
  } catch (err) {
    // Anything but a stored plan leaves no claim behind (the failure branch above already removed it).
    await db
      .delete(plans)
      .where(and(eq(plans.id, claim.id), isNull(plans.planHash)))
      .catch(() => undefined);
    throw err;
  }
}

/** One project's plans, or the read-only "All" view; newest first. */
export async function listPlans(db: Db, ownerId: string, projectId?: string) {
  const where = projectId
    ? eq(plans.projectId, (await resolveProject(db, ownerId, projectId)).projectId)
    : inArray(plans.workspaceId, await ownerWorkspaceIds(db, ownerId));
  const rows = await db
    .select()
    .from(plans)
    .where(and(where, eq(plans.ownerId, ownerId), isNotNull(plans.planHash)))
    .orderBy(desc(plans.id))
    .limit(LIST_LIMIT); // shortcut: newest 50 only; add a cursor when someone needs older plans
  const steps = await stepsOf(
    db,
    rows.map((r) => r.id),
  );
  return { items: rows.map((r) => toPlanDto(r, steps)) };
}

export async function getPlan(db: Db, ownerId: string, id: string): Promise<Plan> {
  const [p] = await db.select().from(plans).where(byOwner(ownerId, id));
  if (!p) throw notFound("Plan");
  return toPlanDto(p, await stepsOf(db, [p.id]));
}

/** Loads and locks the owner's plan, then re-checks its project is writable (archived = read-only). */
async function lockPlan(tx: Tx, ownerId: string, id: string) {
  const [p] = await tx.select().from(plans).where(byOwner(ownerId, id)).for("update");
  if (!p) throw notFound("Plan");
  await resolveProject(tx, ownerId, p.projectId, { write: true });
  return p;
}

/** The owner's approval of the exact hash is the only authorization a plan ever gets. */
export async function decidePlan(
  db: Db,
  input: { ownerId: string; id: string; body: PlanDecisionRequest; correlationId: string },
): Promise<Plan> {
  return db.transaction(async (tx) => {
    const p = await lockPlan(tx, input.ownerId, input.id);
    if (p.status !== "DRAFT")
      throw new HttpError(409, "CONFLICT", `This plan is already ${p.status.toLowerCase()}`);
    if (input.body.planHash !== p.planHash)
      throw new HttpError(
        409,
        "CONFLICT",
        "This plan isn't the one you reviewed: open it again and decide on the current version",
      );
    const steps = await stepsOf(tx, [p.id]);
    const approve = input.body.decision === "approve";
    if (approve && steps.some((s) => s.blockedReason))
      throw new HttpError(
        409,
        "CONFLICT",
        "You can't approve a plan with blocked steps: deny it and draft a new one",
      );
    const now = new Date();
    const [updated] = await tx
      .update(plans)
      .set(
        approve
          ? { status: "APPROVED", decidedAt: now }
          : { status: "DENIED", decidedAt: now, finishedAt: now },
      )
      .where(eq(plans.id, p.id))
      .returning();
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: approve ? "plan.approve" : "plan.deny",
      resourceType: "plan",
      resourceId: p.id,
      correlationId: input.correlationId,
      outcome: approve ? "SUCCEEDED" : "DENIED",
      metadata: {
        workspaceId: p.workspaceId,
        projectId: p.projectId,
        planHash: p.planHash,
        steps: steps.length,
      },
    });
    return toPlanDto(updated!, steps);
  });
}

/** Pending steps stop; running jobs are cancelled through the jobs cancel path and settle from their own state. */
export async function cancelPlan(
  db: Db,
  input: { ownerId: string; id: string; correlationId: string },
): Promise<Plan> {
  const running = await db.transaction(async (tx) => {
    const p = await lockPlan(tx, input.ownerId, input.id);
    if (!["DRAFT", "APPROVED", "RUNNING"].includes(p.status))
      throw new HttpError(409, "CONFLICT", `This plan is already ${p.status.toLowerCase()}`);
    const now = new Date();
    await tx.update(plans).set({ status: "CANCELLED", finishedAt: now }).where(eq(plans.id, p.id));
    await tx
      .update(planSteps)
      .set({ status: "CANCELLED", finishedAt: now })
      .where(and(eq(planSteps.planId, p.id), eq(planSteps.status, "PENDING")));
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: "plan.cancel",
      resourceType: "plan",
      resourceId: p.id,
      correlationId: input.correlationId,
      metadata: { workspaceId: p.workspaceId, projectId: p.projectId, from: p.status },
    });
    return tx
      .select()
      .from(planSteps)
      .where(and(eq(planSteps.planId, p.id), eq(planSteps.status, "RUNNING")));
  });
  for (const s of running)
    if (s.jobId)
      // A run that can't be cancelled any more (finished, or its approved push is executing) settles on its own.
      await cancelJob(db, {
        ownerId: input.ownerId,
        jobId: s.jobId,
        correlationId: input.correlationId,
      }).catch((err: unknown) => {
        if (!(err instanceof HttpError)) throw err;
      });
  return getPlan(db, input.ownerId, input.id);
}
