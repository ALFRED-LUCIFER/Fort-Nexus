import type { FastifyBaseLogger } from "fastify";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import {
  DEEP_DIVE_DEPTH_LIMITS,
  type CreateDeepDiveRequest,
  type DeepDive,
  type DeepDiveDetail,
  type DeepDiveList,
  type DeepDiveListQuery,
  type DeepDiveReport,
  type DeepDiveStop,
} from "@nexus/contracts";
import { resolveAgentProfile } from "../../agents/service.ts";
import { audit } from "../../audit.ts";
import type { Config } from "../../config.ts";
import type { Db, Tx } from "../../db/index.ts";
import { aiSpend } from "../../db/schema.ts";
import { HttpError, notFound } from "../../errors.ts";
import { canonical, sha256 } from "../../jobs.ts";
import { notifyDeepDive } from "../../notifications.ts";
import { reserveAiSpend, settleAiSpend } from "../../system.ts";
import { ownerWorkspaceIds, resolveProject } from "../../workspaces.ts";
import { researchFindings } from "../schema.ts";
import type { Ctx } from "../service.ts";
import { Halt, runDive, type DiveRow, type DiveUsage, type EngineDeps } from "./loop.ts";
import { researchDeepDives as dives, researchDeepDiveSteps as steps } from "./schema.ts";

// RESEARCH_DEEP_DIVE lifecycle: QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED. The cap is reserved against
// today's budget at create (before any model call) and settled to the measured cost when the dive ends.

const AGENT = "AI_RESEARCHER";
const DIVER = "system:research-deep-diver";
const MAX_RUNNING = 2;
const RESTARTED = "NEXUS restarted during this dive; nothing was published.";
const SHUT_DOWN = "NEXUS shut down during this dive; nothing was published.";
const INTERNAL = "The deep dive stopped on an internal error; nothing was published. See the API log.";
const CANCELLED = "Cancelled by you; nothing was published.";

export type DeepDiver = {
  /** Runs queued dives (at most two at a time); `id` was just queued. */
  start(id: string): void;
  /** At boot: fails dives a previous process left RUNNING (their reservation stays spent), then runs the queue. */
  reconcile(): Promise<void>;
  /** Create-time checks: ai.json usable (409 otherwise) and whether web search is (see `createDeepDive`). */
  preflight(fromFindings: boolean): Promise<{ model: string; searchEnabled: boolean }>;
  /** Waits for running dives to record their outcome (API shutdown). */
  close(): Promise<void>;
};
export type DeepDeps = { db: Db; config: Config; diver: DeepDiver };

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const toDeepDiveDto = (r: DiveRow): DeepDive => ({
  id: r.id,
  projectId: r.projectId,
  question: r.question,
  depth: r.depth,
  findingIds: r.findingIds,
  status: r.status,
  stoppedBy: r.stoppedBy,
  limits: r.limits,
  usage: { costUsd: r.costUsd, turns: r.turns, searches: r.searches, fetches: r.fetches },
  model: r.model,
  profileVersionId: r.profileVersionId,
  report: r.report,
  error: r.error,
  createdAt: r.createdAt.toISOString(),
  startedAt: iso(r.startedAt),
  finishedAt: iso(r.finishedAt),
});

const scopeOf = (r: DiveRow) => ({ workspaceId: r.workspaceId, projectId: r.projectId });
const record = (
  tx: Db | Tx,
  r: DiveRow,
  e: { actor: string; action: string; outcome?: "SUCCEEDED" | "FAILED"; metadata: Record<string, unknown> },
) =>
  audit(tx, {
    actor: e.actor,
    action: e.action,
    resourceType: "research_deep_dive",
    resourceId: r.id,
    correlationId: r.correlationId,
    ...(e.outcome ? { outcome: e.outcome } : {}),
    metadata: { ...scopeOf(r), ...e.metadata },
  });

/**
 * POST /v1/research/deep-dives. Replaying a key returns the same dive (also under a race: the unique key makes
 * the loser wait for the winner's transaction); a key reused with another body is 409. Checks, in order: the
 * owner's writable project, the AI researcher's profile (tool and autonomy), the findings, ai.json, search.json
 * (a dive starting from findings runs without search when search.json doesn't exist), then the reservation
 * (emergency stop and BUDGET_EXHAUSTED 409s) in the create transaction.
 */
export async function createDeepDive(
  deps: DeepDeps,
  ctx: Ctx,
  body: CreateDeepDiveRequest,
  idempotencyKey: string,
): Promise<{ created: boolean; deepDive: DeepDive }> {
  const { db, config, diver } = deps;
  const s = await resolveProject(db, ctx.ownerId, body.projectId, { write: true });
  const requestHash = sha256(canonical(body));
  const byKey = async () => {
    const [r] = await db
      .select()
      .from(dives)
      .where(and(eq(dives.projectId, s.projectId), eq(dives.idempotencyKey, idempotencyKey)));
    if (r && r.requestHash !== requestHash)
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key was already used with a different body",
      );
    return r ?? null;
  };
  const replay = await byKey();
  if (replay) return { created: false, deepDive: toDeepDiveDto(replay) };

  const profile = await resolveAgentProfile(db, ctx.ownerId, s.projectId, AGENT);
  const settings = profile.settings;
  if (!settings.tools.includes("research.deep_dive"))
    throw new HttpError(
      409,
      "CONFLICT",
      "The AI researcher's profile in this project doesn't allow research.deep_dive. Add it under Agents → AI researcher → Tools.",
      { reason: "tool_not_allowed", agent: AGENT, setting: "tools", tool: "research.deep_dive" },
    );
  if (settings.autonomy === "SUGGEST" || settings.autonomy === "DRAFT")
    throw new HttpError(
      409,
      "CONFLICT",
      `The AI researcher's autonomy in this project is ${settings.autonomy}, so it can't run deep dives. Set it to ACT_WITH_APPROVAL or higher under Agents → AI researcher → Autonomy.`,
      { reason: "autonomy_too_low", agent: AGENT, setting: "autonomy", autonomy: settings.autonomy },
    );
  const findingIds = [...new Set(body.findingIds)];
  if (findingIds.length > 0) {
    const own = await db
      .select({ id: researchFindings.id })
      .from(researchFindings)
      .where(
        and(
          inArray(researchFindings.id, findingIds),
          eq(researchFindings.workspaceId, s.workspaceId),
          eq(researchFindings.projectId, s.projectId),
        ),
      );
    if (own.length !== findingIds.length) throw notFound("Finding");
  }
  const { model: aiModel, searchEnabled } = await diver.preflight(findingIds.length > 0);
  const depth = DEEP_DIVE_DEPTH_LIMITS[body.depth];
  const limits = {
    maxCostUsd: Math.min(body.maxCostUsd, settings.maxCostUsdPerTask),
    maxTurns: settings.maxTurns,
    maxSearches: searchEnabled ? depth.maxSearches : 0,
    maxFetches: depth.maxFetches,
  };

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(dives)
      .values({
        ...s,
        ownerId: ctx.ownerId,
        idempotencyKey,
        requestHash,
        correlationId: ctx.correlationId,
        question: body.question,
        depth: body.depth,
        findingIds,
        status: "QUEUED",
        limits,
        searchEnabled,
        model: settings.model ?? aiModel,
        profileVersionId: profile.versionId,
      })
      .onConflictDoNothing({ target: [dives.projectId, dives.idempotencyKey] })
      .returning();
    if (!row) return null; // a concurrent request with this key won
    const { spendId } = await reserveAiSpend(tx, {
      workspaceId: s.workspaceId,
      projectId: s.projectId,
      source: "DEEP_DIVE",
      sourceId: row.id,
      maxUsd: limits.maxCostUsd,
      timezone: config.ownerTimezone,
    });
    const [dive] = await tx.update(dives).set({ spendId }).where(eq(dives.id, row.id)).returning();
    await record(tx, dive!, {
      actor: ctx.actor,
      action: "research.deep_dive.create",
      metadata: {
        agent: AGENT,
        profileVersionId: profile.versionId,
        model: dive!.model,
        depth: body.depth,
        findings: findingIds.length,
        searchEnabled,
        maxCostUsd: limits.maxCostUsd,
        spendId,
      },
    });
    return dive!;
  });
  if (!created) return { created: false, deepDive: toDeepDiveDto((await byKey())!) };
  diver.start(created.id);
  return { created: true, deepDive: toDeepDiveDto(created) };
}

/** The owner's dive with its step log, or 404. */
export async function getDeepDive(db: Db, ownerId: string, id: string): Promise<DeepDiveDetail> {
  const [r] = await db
    .select()
    .from(dives)
    .where(and(eq(dives.id, id), inArray(dives.workspaceId, await ownerWorkspaceIds(db, ownerId))));
  if (!r) throw notFound("Deep dive");
  const log = await db.select().from(steps).where(eq(steps.deepDiveId, id)).orderBy(asc(steps.index));
  return {
    ...toDeepDiveDto(r),
    steps: log.map((x) => ({
      index: x.index,
      kind: x.kind,
      detail: x.detail,
      outcome: x.outcome,
      note: x.note,
      at: x.at.toISOString(),
    })),
  };
}

/** One project's dives (404 unless the owner's), or the read-only "All" view; newest first. */
export async function listDeepDives(db: Db, ownerId: string, q: DeepDiveListQuery): Promise<DeepDiveList> {
  if (q.cursor && !z.uuid().safeParse(q.cursor).success)
    throw new HttpError(400, "VALIDATION_FAILED", "cursor must be a value from nextCursor");
  let where;
  if (q.projectId) {
    const s = await resolveProject(db, ownerId, q.projectId);
    where = and(eq(dives.workspaceId, s.workspaceId), eq(dives.projectId, s.projectId));
  } else where = inArray(dives.workspaceId, await ownerWorkspaceIds(db, ownerId));
  const rows = await db
    .select()
    .from(dives)
    .where(and(where, q.cursor ? lt(dives.id, q.cursor) : undefined))
    .orderBy(desc(dives.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return { items: page.map(toDeepDiveDto), nextCursor: rows.length > q.limit ? page.at(-1)!.id : null };
}

/**
 * Owner cancel. A queued dive is cancelled now and its reservation released; a running one is asked to stop and
 * ends CANCELLED at its next step (before the next model call, search or fetch), settled to what it spent.
 * A finished dive is returned unchanged.
 */
export async function cancelDeepDive(db: Db, ctx: Ctx, id: string): Promise<DeepDive> {
  return db.transaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(dives)
      .where(and(eq(dives.id, id), inArray(dives.workspaceId, await ownerWorkspaceIds(tx, ctx.ownerId))))
      .for("update");
    if (!r) throw notFound("Deep dive");
    if (r.status !== "QUEUED" && (r.status !== "RUNNING" || r.cancelRequestedAt)) return toDeepDiveDto(r);
    const now = new Date();
    const [updated] = await tx
      .update(dives)
      .set(
        r.status === "QUEUED"
          ? { status: "CANCELLED", error: CANCELLED, finishedAt: now, cancelRequestedAt: now }
          : { cancelRequestedAt: now },
      )
      .where(eq(dives.id, id))
      .returning();
    if (r.status === "QUEUED" && r.spendId) await settleAiSpend(tx, r.spendId, 0);
    await audit(tx, {
      actor: ctx.actor,
      action: "research.deep_dive.cancel",
      resourceType: "research_deep_dive",
      resourceId: id,
      correlationId: ctx.correlationId,
      metadata: { ...scopeOf(r), from: r.status },
    });
    return toDeepDiveDto(updated!);
  });
}

type Ending =
  | { status: "COMPLETED"; report: DeepDiveReport; stoppedBy: DeepDiveStop | null }
  | { status: "FAILED" | "CANCELLED"; error: string; stoppedBy: DeepDiveStop | null; reason: string };

/**
 * Executes dives in this process: at most two at a time, the rest wait QUEUED. `shutdown` aborts their model calls,
 * searches and fetches; `close()` waits for them to record the outcome.
 */
export function createDeepDiver(
  db: Db,
  deps: EngineDeps,
  log: FastifyBaseLogger,
  shutdown: AbortSignal,
): DeepDiver {
  // shortcut: one API process. A RUNNING dive older than this process can't be running anymore; with several API
  // processes, replace this with a heartbeat lease per dive and count running dives in the database.
  const bootedAt = new Date();
  const inflight = new Map<string, Promise<void>>();
  let queue: Promise<void> = Promise.resolve();

  /** The one transaction that ends a dive: report, settle, opportunity, notification, audit. */
  async function end(id: string, e: Ending, usage: DiveUsage | null) {
    await db.transaction(async (tx) => {
      const [r] = await tx.select().from(dives).where(eq(dives.id, id)).for("update");
      if (!r || r.status !== "RUNNING") return; // already ended; never overwrite
      const counters = usage ?? {
        costUsd: r.costUsd,
        turns: r.turns,
        searches: r.searches,
        fetches: r.fetches,
      };
      const [done] = await tx
        .update(dives)
        .set({
          ...counters,
          status: e.status,
          stoppedBy: e.stoppedBy,
          report: e.status === "COMPLETED" ? e.report : null,
          error: e.status === "COMPLETED" ? null : e.error,
          finishedAt: new Date(),
        })
        .where(eq(dives.id, id))
        .returning();
      if (r.spendId) {
        // Unknown outcome (a restart): the whole reservation stays spent, the conservative choice.
        let cost = counters.costUsd;
        if (!usage) {
          const [spend] = await tx.select().from(aiSpend).where(eq(aiSpend.id, r.spendId));
          cost = spend?.reservedUsd ?? cost;
        }
        await settleAiSpend(tx, r.spendId, cost);
      }
      const opportunityId =
        e.status === "COMPLETED"
          ? await deps.recordOpportunity(
              tx,
              { id, workspaceId: r.workspaceId, projectId: r.projectId },
              e.report,
            )
          : null;
      await notifyDeepDive(tx, {
        ownerId: r.ownerId,
        projectId: r.projectId,
        deepDiveId: id,
        status: e.status,
        question: r.question,
        opportunityId,
      });
      const claims = e.status === "COMPLETED" ? e.report.claims : [];
      await record(tx, done!, {
        actor: DIVER,
        action: "research.deep_dive.finish",
        outcome: e.status === "COMPLETED" ? "SUCCEEDED" : "FAILED",
        metadata: {
          status: e.status,
          stoppedBy: e.stoppedBy,
          ...(e.status === "COMPLETED" ? {} : { reason: e.reason }),
          costUsd: counters.costUsd,
          turns: counters.turns,
          searches: counters.searches,
          fetches: counters.fetches,
          claims: claims.length,
          verifiedClaims: claims.filter((c) => c.evidence.some((x) => x.verified)).length,
          opportunityId,
        },
      });
    });
  }

  async function execute(dive: DiveRow) {
    const usage: DiveUsage = {
      costUsd: dive.costUsd,
      turns: dive.turns,
      searches: dive.searches,
      fetches: dive.fetches,
    };
    let ending: Ending;
    try {
      const out = await runDive(db, deps, dive, shutdown, usage);
      ending = out.status === "COMPLETED" ? out : { ...out, reason: "OUTCOME" };
    } catch (err) {
      if (err instanceof Halt)
        ending = {
          status: err.status,
          error: err.message,
          stoppedBy: null,
          reason: err.status === "CANCELLED" ? "CANCELLED" : "SHUTDOWN",
        };
      else if (shutdown.aborted)
        ending = { status: "FAILED", error: SHUT_DOWN, stoppedBy: null, reason: "SHUTDOWN" };
      else if (err instanceof HttpError && err.statusCode === 409)
        // ai.json or search.json became unusable after create: the message names the file and runbook.
        ending = {
          status: "FAILED",
          error: `${err.message} Nothing was published.`,
          stoppedBy: null,
          reason: "CONFIG",
        };
      else {
        log.error({ err, deepDiveId: dive.id }, "deep dive failed");
        ending = { status: "FAILED", error: INTERNAL, stoppedBy: null, reason: "INTERNAL" };
      }
    }
    await end(dive.id, ending, usage);
  }

  /** Claims the oldest queued dive, or null. */
  async function claim(): Promise<DiveRow | null> {
    return db.transaction(async (tx) => {
      const [next] = await tx
        .select({ id: dives.id })
        .from(dives)
        .where(eq(dives.status, "QUEUED"))
        .orderBy(asc(dives.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!next) return null;
      const [row] = await tx
        .update(dives)
        .set({ status: "RUNNING", startedAt: new Date() })
        .where(eq(dives.id, next.id))
        .returning();
      return row!;
    });
  }

  function pump() {
    queue = queue
      .then(async () => {
        while (inflight.size < MAX_RUNNING && !shutdown.aborted) {
          const dive = await claim();
          if (!dive) return;
          const p = execute(dive)
            .catch((err: unknown) =>
              log.error({ err, deepDiveId: dive.id }, "could not record deep dive outcome"),
            )
            .finally(() => {
              inflight.delete(dive.id);
              pump();
            });
          inflight.set(dive.id, p);
        }
      })
      .catch((err: unknown) => log.error({ err }, "deep dive queue failed"));
  }

  return {
    start: () => pump(),
    async reconcile() {
      const stale = await db
        .select({ id: dives.id })
        .from(dives)
        .where(and(eq(dives.status, "RUNNING"), lt(dives.startedAt, bootedAt)));
      for (const { id } of stale)
        await end(id, { status: "FAILED", error: RESTARTED, stoppedBy: null, reason: "RESTART" }, null);
      pump();
    },
    async preflight(fromFindings) {
      const ai = await deps.loadAi(deps.config.aiFile); // 409 with the runbook until ai.json exists
      try {
        await deps.loadSearch(deps.config.searchFile);
        return { model: ai.model, searchEnabled: true };
      } catch (err) {
        const reason =
          err instanceof HttpError ? (err.details as { reason?: string } | undefined)?.reason : null;
        if (fromFindings && reason === "search_provider_not_configured")
          return { model: ai.model, searchEnabled: false };
        throw err;
      }
    },
    async close() {
      await queue;
      await Promise.allSettled(inflight.values());
    },
  };
}
