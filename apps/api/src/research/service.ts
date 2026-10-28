import type { FastifyBaseLogger } from "fastify";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import type {
  CreateWatchlistRequest,
  Finding,
  FindingList,
  FindingSearchQuery,
  ResearchBrief,
  ResearchRun,
  ResearchSource,
  SourceTier,
  UpdateWatchlistRequest,
  Watchlist,
} from "@nexus/contracts";
import { audit, type AuditEntry } from "../audit.ts";
import type { Db, Tx } from "../db/index.ts";
import { notFound } from "../errors.ts";
import type { ProjectScope } from "../scope.ts";
import { fetchSession, hostLimiter } from "./fetch.ts";
import { parseFeed, type FeedItem } from "./feed.ts";
import {
  canonicalUrl,
  publisherOf,
  score,
  scoreBreakdown,
  similar,
  titleTokens,
  verificationLabel,
} from "./findings.ts";
import { dueWindow, nextRunAt } from "./schedule.ts";
import { researchFindingSources, researchFindings, researchRuns, researchWatchlists } from "./schema.ts";

type WatchlistRow = typeof researchWatchlists.$inferSelect;
type RunRow = typeof researchRuns.$inferSelect;
type FindingRow = typeof researchFindings.$inferSelect;

/** Who is asking and for which project; every query and audit record carries it. */
export type Ctx = { scope: ProjectScope; actor: string; correlationId: string };

const SCHEDULER = "system:research-scheduler";
const DEDUPE_WINDOW_MS = 14 * 86_400_000;
const RUN_LIST_LIMIT = 30;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const inScope = (
  s: ProjectScope,
  t: typeof researchWatchlists | typeof researchRuns | typeof researchFindings,
) => and(eq(t.workspaceId, s.workspaceId), eq(t.projectId, s.projectId));

const record = (tx: Db | Tx, ctx: Ctx, e: Omit<AuditEntry, "actor" | "correlationId">) =>
  audit(tx, {
    ...e,
    actor: ctx.actor,
    correlationId: ctx.correlationId,
    metadata: { ...ctx.scope, ...e.metadata },
  });

export const sourceLabel = (s: ResearchSource) => (s.kind === "FEED" ? s.url : `GitHub releases · ${s.repo}`);
const sourceUrl = (s: ResearchSource) =>
  new URL(s.kind === "FEED" ? s.url : `https://github.com/${s.repo}/releases.atom`);

const toWatchlistDto = (w: WatchlistRow): Watchlist => ({
  id: w.id,
  name: w.name,
  keywords: w.keywords,
  sources: w.sources,
  weights: w.weights,
  schedule: w.schedule,
  nextRunAt: iso(w.nextRunAt),
  lastRunAt: iso(w.lastRunAt),
  createdAt: w.createdAt.toISOString(),
  updatedAt: w.updatedAt.toISOString(),
});

const toRunDto = (r: RunRow): ResearchRun => ({
  id: r.id,
  watchlistId: r.watchlistId,
  trigger: r.trigger,
  windowDate: r.windowDate,
  status: r.status,
  startedAt: r.startedAt.toISOString(),
  finishedAt: iso(r.finishedAt),
  newFindings: r.newFindings,
  skippedSources: r.skippedSources,
});

/** Findings with their sources, scored with their watchlist's current weights. */
async function toFindingDtos(db: Db | Tx, rows: FindingRow[]): Promise<Finding[]> {
  if (rows.length === 0) return [];
  const [sources, lists] = await Promise.all([
    db
      .select()
      .from(researchFindingSources)
      .where(
        inArray(
          researchFindingSources.findingId,
          rows.map((f) => f.id),
        ),
      )
      .orderBy(researchFindingSources.id),
    db
      .select({ id: researchWatchlists.id, weights: researchWatchlists.weights })
      .from(researchWatchlists)
      .where(inArray(researchWatchlists.id, [...new Set(rows.map((f) => f.watchlistId))])),
  ]);
  const weights = new Map(lists.map((l) => [l.id, l.weights]));
  return rows.map((f) => ({
    id: f.id,
    watchlistId: f.watchlistId,
    title: f.title,
    excerpt: f.excerpt,
    canonicalUrl: f.canonicalUrl,
    label: f.label,
    score: score(f.scoreBreakdown, weights.get(f.watchlistId)!),
    scoreBreakdown: f.scoreBreakdown,
    sources: sources
      .filter((s) => s.findingId === f.id)
      .map((s) => ({
        url: s.url,
        publisher: s.publisher,
        tier: s.tier,
        title: s.title,
        publishedAt: iso(s.publishedAt),
        fetchedAt: s.fetchedAt.toISOString(),
      })),
    publishedAt: iso(f.publishedAt),
    firstSeenAt: f.firstSeenAt.toISOString(),
    firstRunId: f.firstRunId,
    readAt: iso(f.readAt),
  }));
}

// ── Watchlists ──

export async function listWatchlists(db: Db, scope: ProjectScope) {
  const rows = await db
    .select()
    .from(researchWatchlists)
    .where(and(inScope(scope, researchWatchlists), isNull(researchWatchlists.archivedAt)))
    .orderBy(researchWatchlists.id);
  return rows.map(toWatchlistDto);
}

export async function createWatchlist(db: Db, ctx: Ctx, body: CreateWatchlistRequest) {
  return db.transaction(async (tx) => {
    const [w] = await tx
      .insert(researchWatchlists)
      .values({
        ...ctx.scope,
        ...body,
        nextRunAt: nextRunAt(body.schedule, new Date()),
        createdBy: ctx.actor,
      })
      .returning();
    await record(tx, ctx, {
      action: "research.watchlist.create",
      resourceType: "research_watchlist",
      resourceId: w!.id,
      metadata: { sources: body.sources.length, paused: body.schedule.paused },
    });
    return toWatchlistDto(w!);
  });
}

async function lockWatchlist(tx: Tx, scope: ProjectScope, id: string) {
  const [w] = await tx
    .select()
    .from(researchWatchlists)
    .where(
      and(
        eq(researchWatchlists.id, id),
        inScope(scope, researchWatchlists),
        isNull(researchWatchlists.archivedAt),
      ),
    )
    .for("update");
  if (!w) throw notFound("Watchlist");
  return w;
}

export async function updateWatchlist(db: Db, ctx: Ctx, id: string, body: UpdateWatchlistRequest) {
  return db.transaction(async (tx) => {
    await lockWatchlist(tx, ctx.scope, id);
    const [w] = await tx
      .update(researchWatchlists)
      .set({
        ...body,
        ...(body.schedule ? { nextRunAt: nextRunAt(body.schedule, new Date()) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(researchWatchlists.id, id))
      .returning();
    await record(tx, ctx, {
      action: "research.watchlist.update",
      resourceType: "research_watchlist",
      resourceId: id,
      metadata: {
        fields: Object.keys(body).sort(),
        ...(body.schedule ? { paused: body.schedule.paused } : {}),
      },
    });
    return toWatchlistDto(w!);
  });
}

/** Archives: stops scheduling and hides it from the list; its runs and findings stay searchable. */
export async function archiveWatchlist(db: Db, ctx: Ctx, id: string) {
  await db.transaction(async (tx) => {
    await lockWatchlist(tx, ctx.scope, id);
    await tx
      .update(researchWatchlists)
      .set({ archivedAt: new Date(), nextRunAt: null, updatedAt: new Date() })
      .where(eq(researchWatchlists.id, id));
    await record(tx, ctx, {
      action: "research.watchlist.archive",
      resourceType: "research_watchlist",
      resourceId: id,
    });
  });
}

// ── Runs ──

/** A MANUAL run; replaying the same Idempotency-Key returns the same run (`created: false`). */
export async function createManualRun(db: Db, ctx: Ctx, watchlistId: string, idempotencyKey: string) {
  return db.transaction(async (tx) => {
    const w = await lockWatchlist(tx, ctx.scope, watchlistId);
    const now = new Date();
    const [run] = await tx
      .insert(researchRuns)
      .values({
        ...ctx.scope,
        watchlistId: w.id,
        trigger: "MANUAL",
        idempotencyKey,
        status: "RUNNING",
        startedAt: now,
      })
      .onConflictDoNothing({ target: [researchRuns.watchlistId, researchRuns.idempotencyKey] })
      .returning();
    if (!run) {
      const [existing] = await tx
        .select()
        .from(researchRuns)
        .where(and(eq(researchRuns.watchlistId, w.id), eq(researchRuns.idempotencyKey, idempotencyKey)));
      return { run: toRunDto(existing!), created: false };
    }
    await tx.update(researchWatchlists).set({ lastRunAt: now }).where(eq(researchWatchlists.id, w.id));
    await record(tx, ctx, {
      action: "research.run.start",
      resourceType: "research_run",
      resourceId: run.id,
      metadata: { watchlistId: w.id, trigger: "MANUAL" },
    });
    return { run: toRunDto(run), created: true };
  });
}

export async function listRuns(db: Db, scope: ProjectScope, watchlistId?: string) {
  const rows = await db
    .select()
    .from(researchRuns)
    .where(
      and(inScope(scope, researchRuns), watchlistId ? eq(researchRuns.watchlistId, watchlistId) : undefined),
    )
    .orderBy(desc(researchRuns.id))
    .limit(RUN_LIST_LIMIT); // shortcut: newest 30 runs only; add a cursor when someone needs older briefs here
  return rows.map(toRunDto);
}

/** FR-RES-08: one run and the findings it first saw, best score first. */
export async function getBrief(db: Db, scope: ProjectScope, runId: string): Promise<ResearchBrief> {
  const [run] = await db
    .select()
    .from(researchRuns)
    .where(and(eq(researchRuns.id, runId), inScope(scope, researchRuns)));
  if (!run) throw notFound("Research run");
  const rows = await db.select().from(researchFindings).where(eq(researchFindings.firstRunId, run.id));
  const findings = await toFindingDtos(db, rows);
  return { run: toRunDto(run), findings: findings.sort((a, b) => b.score - a.score) };
}

// ── Findings ──

const dayStart = (d: string) => new Date(`${d}T00:00:00Z`);

/** FR-RES-09: Postgres full-text over title + excerpt; newest first by uuidv7 id. */
export async function searchFindings(
  db: Db,
  scope: ProjectScope,
  q: Omit<FindingSearchQuery, "cursor"> & { cursor?: string },
): Promise<FindingList> {
  const f = researchFindings;
  const where: (SQL | undefined)[] = [
    inScope(scope, f),
    q.q
      ? sql`to_tsvector('english', ${f.title} || ' ' || ${f.excerpt}) @@ websearch_to_tsquery('english', ${q.q})`
      : undefined,
    q.watchlistId ? eq(f.watchlistId, q.watchlistId) : undefined,
    q.label ? eq(f.label, q.label) : undefined,
    // shortcut: from/to are UTC dates; use the owner's time zone once profiles carry one.
    q.from ? gte(f.firstSeenAt, dayStart(q.from)) : undefined,
    q.to ? lt(f.firstSeenAt, new Date(dayStart(q.to).getTime() + 86_400_000)) : undefined,
    q.unread === undefined ? undefined : q.unread ? isNull(f.readAt) : isNotNull(f.readAt),
    q.cursor ? lt(f.id, q.cursor) : undefined,
  ];
  const rows = await db
    .select()
    .from(f)
    .where(and(...where))
    .orderBy(desc(f.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return {
    items: await toFindingDtos(db, page),
    nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
  };
}

export async function markRead(db: Db, ctx: Ctx, id: string) {
  return db.transaction(async (tx) => {
    const [f] = await tx
      .select()
      .from(researchFindings)
      .where(and(eq(researchFindings.id, id), inScope(ctx.scope, researchFindings)))
      .for("update");
    if (!f) throw notFound("Finding");
    let row = f;
    if (!f.readAt) {
      [row] = (await tx
        .update(researchFindings)
        .set({ readAt: new Date() })
        .where(eq(researchFindings.id, id))
        .returning()) as [FindingRow];
      // Findings are part of their watchlist; the finding id goes in metadata.
      await record(tx, ctx, {
        action: "research.finding.read",
        resourceType: "research_watchlist",
        resourceId: f.watchlistId,
        metadata: { findingId: id },
      });
    }
    return (await toFindingDtos(tx, [row]))[0]!;
  });
}

// ── Pipeline ──

type Fetched = { tier: SourceTier; item: FeedItem; fetchedAt: Date };

/** Dedupe (RES-G02) and store one run's items. Caller holds the watchlist row lock. Returns new findings. */
async function ingest(tx: Tx, run: RunRow, w: WatchlistRow, fetched: Fetched[]) {
  const scope = { workspaceId: w.workspaceId, projectId: w.projectId };
  const items = fetched.map((f) => {
    const url = canonicalUrl(f.item.link);
    return { ...f, url, publisher: publisherOf(url), tokens: titleTokens(f.item.title) };
  });
  const known = new Set(
    items.length === 0
      ? []
      : (
          await tx
            .select({ url: researchFindingSources.url })
            .from(researchFindingSources)
            .where(
              and(
                eq(researchFindingSources.watchlistId, w.id),
                inArray(
                  researchFindingSources.url,
                  items.map((i) => i.url),
                ),
              ),
            )
        ).map((r) => r.url),
  );
  // shortcut: near-duplicate candidates (last 14 days) are compared in memory; fine for thousands of findings.
  const candidates = (
    await tx
      .select({ id: researchFindings.id, title: researchFindings.title })
      .from(researchFindings)
      .where(
        and(
          eq(researchFindings.watchlistId, w.id),
          gte(researchFindings.firstSeenAt, new Date(Date.now() - DEDUPE_WINDOW_MS)),
        ),
      )
  ).map((c) => ({ id: c.id, tokens: titleTokens(c.title) }));

  let created = 0;
  for (const i of items) {
    if (known.has(i.url)) continue;
    known.add(i.url);
    const source = {
      ...scope,
      watchlistId: w.id,
      url: i.url,
      publisher: i.publisher,
      tier: i.tier,
      title: i.item.title,
      publishedAt: i.item.publishedAt,
      fetchedAt: i.fetchedAt,
    };
    const match = candidates.find((c) => similar(c.tokens, i.tokens));
    if (match) {
      await tx.insert(researchFindingSources).values({ ...source, findingId: match.id });
      await rescore(tx, match.id, w.keywords);
      continue;
    }
    const firstSeenAt = new Date();
    const [f] = await tx
      .insert(researchFindings)
      .values({
        ...scope,
        watchlistId: w.id,
        firstRunId: run.id,
        title: i.item.title,
        excerpt: i.item.excerpt,
        canonicalUrl: i.url,
        label: verificationLabel([source]),
        scoreBreakdown: scoreBreakdown({ ...i.item, firstSeenAt, tiers: [i.tier], keywords: w.keywords }),
        publishedAt: i.item.publishedAt,
        firstSeenAt,
      })
      .returning({ id: researchFindings.id });
    await tx.insert(researchFindingSources).values({ ...source, findingId: f!.id });
    candidates.push({ id: f!.id, tokens: i.tokens });
    created++;
  }
  return created;
}

/** Recomputes label and criteria after a source joined a finding (RES-G03). */
async function rescore(tx: Tx, findingId: string, keywords: string[]) {
  const [f] = await tx.select().from(researchFindings).where(eq(researchFindings.id, findingId));
  const sources = await tx
    .select({ tier: researchFindingSources.tier, publisher: researchFindingSources.publisher })
    .from(researchFindingSources)
    .where(eq(researchFindingSources.findingId, findingId));
  await tx
    .update(researchFindings)
    .set({
      label: verificationLabel(sources),
      scoreBreakdown: scoreBreakdown({ ...f!, tiers: sources.map((s) => s.tier), keywords }),
    })
    .where(eq(researchFindings.id, findingId));
}

export type Research = ReturnType<typeof createResearch>;

/**
 * The scheduler tick and the run executor. Runs execute in this process; `shutdown` aborts their fetches and
 * `close()` waits for them to record the outcome.
 */
export function createResearch(db: Db, log: FastifyBaseLogger, shutdown: AbortSignal) {
  // shortcut: one API process. A RUNNING run older than this process can't be running anymore; with several API
  // processes, replace this with a heartbeat lease per run.
  const bootedAt = new Date();
  const limiter = hostLimiter();
  const inflight = new Set<Promise<void>>();
  const system = (correlationId: string, r: ProjectScope): Ctx => ({
    scope: { workspaceId: r.workspaceId, projectId: r.projectId },
    actor: SCHEDULER,
    correlationId,
  });

  async function fail(runId: string, error: string) {
    await db.transaction(async (tx) => {
      const [run] = await tx
        .update(researchRuns)
        .set({ status: "FAILED", finishedAt: new Date(), error })
        .where(and(eq(researchRuns.id, runId), eq(researchRuns.status, "RUNNING")))
        .returning();
      if (run)
        await record(tx, system(run.id, run), {
          action: "research.run.fail",
          resourceType: "research_run",
          resourceId: run.id,
          outcome: "FAILED",
          metadata: { watchlistId: run.watchlistId },
        });
    });
  }

  async function execute(runId: string) {
    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
    const [w] = await db.select().from(researchWatchlists).where(eq(researchWatchlists.id, run!.watchlistId));
    const session = fetchSession(limiter, shutdown);
    const skipped: ResearchRun["skippedSources"] = [];
    const fetched: Fetched[] = [];
    for (const source of w!.sources) {
      const res = await session.get(sourceUrl(source));
      const items = res.ok ? parseFeed(res.body, res.url) : null;
      if (!res.ok) skipped.push({ source: sourceLabel(source), reason: res.reason, detail: res.detail });
      else if (!items)
        skipped.push({
          source: sourceLabel(source),
          reason: "INVALID_FEED",
          detail: "Not an RSS 2.0 or Atom feed",
        });
      else fetched.push(...items.map((item) => ({ tier: source.tier, item, fetchedAt: new Date() })));
    }
    const status =
      skipped.length === 0 ? "COMPLETED" : skipped.length < w!.sources.length ? "PARTIAL" : "FAILED";
    await db.transaction(async (tx) => {
      // Serialises ingestion per watchlist, so concurrent runs can't both create the same finding.
      await tx
        .select({ id: researchWatchlists.id })
        .from(researchWatchlists)
        .where(eq(researchWatchlists.id, w!.id))
        .for("update");
      const [current] = await tx
        .select({ status: researchRuns.status })
        .from(researchRuns)
        .where(eq(researchRuns.id, runId))
        .for("update");
      if (current?.status !== "RUNNING") return; // already settled (e.g. failed as stale); never overwrite it
      const newFindings = await ingest(tx, run!, w!, fetched);
      await tx
        .update(researchRuns)
        .set({ status, finishedAt: new Date(), newFindings, skippedSources: skipped })
        .where(eq(researchRuns.id, runId));
      await record(tx, system(runId, w!), {
        action: "research.run.finish",
        resourceType: "research_run",
        resourceId: runId,
        outcome: status === "FAILED" ? "FAILED" : "SUCCEEDED",
        metadata: { watchlistId: w!.id, status, newFindings, skipped: skipped.map((s) => s.reason) },
      });
    });
  }

  /** Runs `runId` in the background; the outcome lands on the run row. */
  function start(runId: string) {
    const p = execute(runId)
      .catch(async (err: unknown) => {
        log.error({ err, runId }, "research run failed");
        await fail(
          runId,
          shutdown.aborted
            ? "The API shut down during this run; it was not retried."
            : "The run stopped on an internal error; see the API log.",
        );
      })
      .catch((err: unknown) => log.error({ err, runId }, "could not record research run failure"))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }

  /** RES-G01: claims each due window exactly once (unique per watchlist + local date) and starts only those runs. */
  async function tick(now = new Date()) {
    const stale = await db
      .select({ id: researchRuns.id })
      .from(researchRuns)
      .where(and(eq(researchRuns.status, "RUNNING"), lt(researchRuns.startedAt, bootedAt)));
    for (const r of stale) await fail(r.id, "The API restarted during this run; it was not retried.");

    const due = await db
      .select({ id: researchWatchlists.id })
      .from(researchWatchlists)
      .where(and(lte(researchWatchlists.nextRunAt, now), isNull(researchWatchlists.archivedAt)));
    for (const { id } of due) {
      const runId = await db.transaction(async (tx) => {
        const [w] = await tx
          .select()
          .from(researchWatchlists)
          .where(
            and(
              eq(researchWatchlists.id, id),
              lte(researchWatchlists.nextRunAt, now),
              isNull(researchWatchlists.archivedAt),
            ),
          )
          .for("update", { skipLocked: true });
        if (!w) return null; // another tick has it
        const { windowDate, next } = dueWindow(w.schedule, w.nextRunAt!, now);
        const [run] = await tx
          .insert(researchRuns)
          .values({
            workspaceId: w.workspaceId,
            projectId: w.projectId,
            watchlistId: w.id,
            trigger: "SCHEDULED",
            windowDate,
            status: "RUNNING",
            startedAt: now,
          })
          .onConflictDoNothing({ target: [researchRuns.watchlistId, researchRuns.windowDate] })
          .returning({ id: researchRuns.id });
        await tx
          .update(researchWatchlists)
          .set({ nextRunAt: next, ...(run ? { lastRunAt: now } : {}) })
          .where(eq(researchWatchlists.id, w.id));
        if (run)
          await record(tx, system(run.id, w), {
            action: "research.run.start",
            resourceType: "research_run",
            resourceId: run.id,
            metadata: { watchlistId: w.id, trigger: "SCHEDULED", windowDate },
          });
        return run?.id ?? null;
      });
      if (runId) start(runId);
    }
  }

  return {
    tick,
    start,
    close: async () => {
      await Promise.allSettled(inflight);
    },
  };
}
