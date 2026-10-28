import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { and, desc, eq, getTableColumns, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import type {
  AppHealth,
  CreateMonitoredAppRequest,
  HealthCheck,
  Incident,
  IncidentStatus,
  ListIncidentsQuery,
  MonitoredApp,
  UpdateMonitoredAppRequest,
} from "@nexus/contracts";
import { audit, type AuditEntry } from "../audit.ts";
import type { Db, Tx } from "../db/index.ts";
import { notifications, projectRepositories, projects, workspaces } from "../db/schema.ts";
import { HttpError, notFound } from "../errors.ts";
import { ownerWorkspaceIds, resolveProject } from "../workspaces.ts";
import { probe, type ProbeOptions, type ProbeResult } from "./probe.ts";
import { healthChecks, incidents, monitoredApps } from "./schema.ts";

// EPIC MON (FR-MON-01/02/06/09, MON-G01/G02). Checks run on the home host: a stale or missing check is UNKNOWN,
// never healthy. One active incident per fingerprint; repeats add evidence, never notifications (throttle policy).

type AppRow = typeof monitoredApps.$inferSelect;
type IncidentRow = typeof incidents.$inferSelect;
type CheckRow = typeof healthChecks.$inferSelect;

/** Who is asking; every audit record carries it. */
export type Ctx = { ownerId: string; actor: string; correlationId: string };

export const MONITOR = "system:monitor";
const CONCURRENCY = 4;
const BATCH = 50;
const EVIDENCE_LIMIT = 50;
const CHECK_LIST_LIMIT = 50;
const INCIDENT_LIST_LIMIT = 100;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const fingerprint = (a: AppRow) => `app:${a.id}:${a.environment}:http`;
const activeIncident = (fp: string) => and(eq(incidents.fingerprint, fp), ne(incidents.status, "RESOLVED"));

const record = (
  tx: Db | Tx,
  ctx: Pick<Ctx, "actor" | "correlationId">,
  row: AppRow | IncidentRow,
  e: Omit<AuditEntry, "actor" | "correlationId">,
) =>
  audit(tx, {
    ...e,
    actor: ctx.actor,
    correlationId: ctx.correlationId,
    metadata: { workspaceId: row.workspaceId, projectId: row.projectId, ...e.metadata },
  });

/** MON-G02: UNKNOWN when never checked, disabled, or the last check is older than 2 × interval. */
export function health(a: AppRow, now: Date): AppHealth {
  if (
    a.disabled ||
    !a.lastCheckedAt ||
    now.getTime() - a.lastCheckedAt.getTime() > 2 * a.intervalSeconds * 1000
  )
    return "UNKNOWN";
  if (a.consecutiveFailures === 0) return "HEALTHY";
  return a.consecutiveFailures >= a.failureThreshold ? "DOWN" : "DEGRADED";
}

const toCheckDto = (c: CheckRow): HealthCheck => ({
  id: c.id,
  appId: c.appId,
  checkedAt: c.checkedAt.toISOString(),
  ok: c.ok,
  statusCode: c.statusCode,
  latencyMs: c.latencyMs,
  error: c.error,
});

async function toAppDtos(tx: Db | Tx, rows: AppRow[]): Promise<MonitoredApp[]> {
  const open = rows.length
    ? await tx
        .select({ appId: incidents.appId, id: incidents.id })
        .from(incidents)
        .where(
          and(
            inArray(
              incidents.appId,
              rows.map((a) => a.id),
            ),
            ne(incidents.status, "RESOLVED"),
          ),
        )
    : [];
  const now = new Date();
  return rows.map((a) => ({
    id: a.id,
    projectId: a.projectId,
    name: a.name,
    environment: a.environment,
    healthUrl: a.healthUrl,
    repositoryId: a.repositoryId,
    intervalSeconds: a.intervalSeconds,
    timeoutMs: a.timeoutMs,
    failureThreshold: a.failureThreshold,
    disabled: a.disabled,
    health: health(a, now),
    consecutiveFailures: a.consecutiveFailures,
    lastCheckedAt: iso(a.lastCheckedAt),
    openIncidentId: open.find((i) => i.appId === a.id)?.id ?? null,
    createdAt: a.createdAt.toISOString(),
  }));
}

/** Incidents with their newest 50 evidence checks and the total count, in one query. */
async function toIncidentDtos(tx: Db | Tx, rows: IncidentRow[]): Promise<Incident[]> {
  if (rows.length === 0) return [];
  const ranked = tx
    .select({
      ...getTableColumns(healthChecks),
      rank: sql<number>`row_number() over (partition by ${healthChecks.incidentId} order by ${healthChecks.id} desc)`.as(
        "rank",
      ),
      total: sql<number>`count(*) over (partition by ${healthChecks.incidentId})`.as("total"),
    })
    .from(healthChecks)
    .where(
      inArray(
        healthChecks.incidentId,
        rows.map((i) => i.id),
      ),
    )
    .as("ranked");
  const evidence = await tx
    .select()
    .from(ranked)
    .where(lte(ranked.rank, EVIDENCE_LIMIT))
    .orderBy(desc(ranked.id));
  return rows.map((i) => {
    const mine = evidence.filter((e) => e.incidentId === i.id);
    return {
      id: i.id,
      projectId: i.projectId,
      appId: i.appId,
      fingerprint: i.fingerprint,
      severity: i.severity,
      status: i.status,
      title: i.title,
      openedAt: i.openedAt.toISOString(),
      acknowledgedAt: iso(i.acknowledgedAt),
      recoveredAt: iso(i.recoveredAt),
      resolvedAt: iso(i.resolvedAt),
      evidenceCount: Number(mine[0]?.total ?? 0),
      evidence: mine.map(toCheckDto),
    };
  });
}

/** Rows of `projectId` (resolved, 404 if not the owner's), or of all the owner's workspaces ("All" view). */
async function scopeOf(
  db: Db,
  ownerId: string,
  projectId: string | undefined,
  t: typeof monitoredApps | typeof incidents,
) {
  if (!projectId) return inArray(t.workspaceId, await ownerWorkspaceIds(db, ownerId));
  const s = await resolveProject(db, ownerId, projectId);
  return and(eq(t.workspaceId, s.workspaceId), eq(t.projectId, s.projectId));
}

async function ownedApp(tx: Db | Tx, ownerId: string, id: string, lock = false) {
  const q = tx
    .select()
    .from(monitoredApps)
    .where(
      and(eq(monitoredApps.id, id), inArray(monitoredApps.workspaceId, await ownerWorkspaceIds(tx, ownerId))),
    );
  const [a] = lock ? await q.for("update") : await q;
  if (!a) throw notFound("App");
  return a;
}

async function ownedIncident(tx: Db | Tx, ownerId: string, id: string, lock = false) {
  const q = tx
    .select()
    .from(incidents)
    .where(and(eq(incidents.id, id), inArray(incidents.workspaceId, await ownerWorkspaceIds(tx, ownerId))));
  const [i] = lock ? await q.for("update") : await q;
  if (!i) throw notFound("Incident");
  return i;
}

// ── Apps ──

export async function listApps(db: Db, ownerId: string, projectId?: string) {
  const rows = await db
    .select()
    .from(monitoredApps)
    .where(await scopeOf(db, ownerId, projectId, monitoredApps))
    .orderBy(monitoredApps.id);
  return toAppDtos(db, rows);
}

export async function createApp(db: Db, ctx: Ctx, body: CreateMonitoredAppRequest) {
  return db.transaction(async (tx) => {
    const { workspaceId, projectId } = await resolveProject(tx, ctx.ownerId, body.projectId, { write: true });
    if (body.repositoryId) {
      const [bound] = await tx
        .select()
        .from(projectRepositories)
        .where(
          and(
            eq(projectRepositories.projectId, projectId),
            eq(projectRepositories.repositoryId, body.repositoryId),
          ),
        );
      if (!bound)
        throw new HttpError(403, "FORBIDDEN", "This repository isn't bound to this project", {
          field: "repositoryId",
        });
    }
    const [a] = await tx
      .insert(monitoredApps)
      .values({ ...body, workspaceId, projectId, createdBy: ctx.actor })
      .returning();
    await record(tx, ctx, a!, {
      action: "monitoring.app.create",
      resourceType: "monitored_app",
      resourceId: a!.id,
      metadata: { environment: a!.environment, host: new URL(a!.healthUrl).host },
    });
    return (await toAppDtos(tx, [a!]))[0]!;
  });
}

export async function updateApp(db: Db, ctx: Ctx, id: string, body: UpdateMonitoredAppRequest) {
  return db.transaction(async (tx) => {
    const a = await ownedApp(tx, ctx.ownerId, id, true);
    await resolveProject(tx, ctx.ownerId, a.projectId, { write: true });
    const newUrl = body.healthUrl !== undefined && body.healthUrl !== a.healthUrl;
    const [u] = await tx
      .update(monitoredApps)
      .set({
        ...body,
        // A new URL starts a fresh record: the old one's failures say nothing about it.
        ...(newUrl ? { consecutiveFailures: 0, lastCheckedAt: null } : {}),
        nextCheckAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(monitoredApps.id, a.id))
      .returning();
    await record(tx, ctx, a, {
      action: "monitoring.app.update",
      resourceType: "monitored_app",
      resourceId: a.id,
      metadata: {
        fields: Object.keys(body).sort(),
        ...(body.disabled === undefined ? {} : { disabled: body.disabled }),
      },
    });
    return (await toAppDtos(tx, [u!]))[0]!;
  });
}

export async function listChecks(db: Db, ownerId: string, appId: string) {
  const a = await ownedApp(db, ownerId, appId);
  const rows = await db
    .select()
    .from(healthChecks)
    .where(eq(healthChecks.appId, a.id))
    .orderBy(desc(healthChecks.id))
    .limit(CHECK_LIST_LIMIT);
  return rows.map(toCheckDto);
}

// ── Checks and incidents ──

const ERROR_TEXT: Record<NonNullable<ProbeResult["error"]>, string> = {
  TIMEOUT: "timed out",
  DNS: "the name didn't resolve",
  CONNECT: "connection failed",
  TLS: "TLS failed",
  HTTP_STATUS: "HTTP error",
  REDIRECT: "redirect, not followed",
  BLOCKED_TARGET: "refused: a private or reserved address",
};

/**
 * Stores one check and applies the incident rules (MON-G01) under the app's row lock, so concurrent checks of one
 * app serialise; the partial unique index backs that up across processes.
 */
export async function recordCheck(
  db: Db,
  appId: string,
  r: ProbeResult,
  ctx: Pick<Ctx, "actor" | "correlationId">,
): Promise<HealthCheck> {
  return db.transaction(async (tx) => {
    const [app] = await tx.select().from(monitoredApps).where(eq(monitoredApps.id, appId)).for("update");
    if (!app) throw notFound("App");
    const failures = r.ok ? 0 : app.consecutiveFailures + 1;
    const scope = { workspaceId: app.workspaceId, projectId: app.projectId, appId: app.id };
    const fp = fingerprint(app);
    let [incident] = await tx.select().from(incidents).where(activeIncident(fp));
    let opened = false;
    if (!r.ok && !incident && failures >= app.failureThreshold) {
      const severity = app.environment === "PROD" ? "SEV2" : "SEV3";
      [incident] = await tx
        .insert(incidents)
        .values({
          ...scope,
          fingerprint: fp,
          severity,
          title: `${app.name} (${app.environment}) health check failing`,
        })
        .onConflictDoNothing()
        .returning();
      opened = incident !== undefined;
      incident ??= (await tx.select().from(incidents).where(activeIncident(fp)))[0];
    }
    const [check] = await tx
      .insert(healthChecks)
      .values({
        ...scope,
        incidentId: r.ok ? null : (incident?.id ?? null),
        ok: r.ok,
        statusCode: r.statusCode,
        latencyMs: r.latencyMs,
        error: r.error,
      })
      .returning();

    if (opened && incident) {
      // The failure streak that reached the threshold is the incident's first evidence.
      const streak = tx
        .select({ id: healthChecks.id })
        .from(healthChecks)
        .where(eq(healthChecks.appId, app.id))
        .orderBy(desc(healthChecks.id))
        .limit(failures);
      await tx
        .update(healthChecks)
        .set({ incidentId: incident.id })
        .where(and(inArray(healthChecks.id, streak), isNull(healthChecks.incidentId)));
      const [ws] = await tx
        .select({ ownerId: workspaces.ownerId, mode: workspaces.mode })
        .from(workspaces)
        .where(eq(workspaces.id, app.workspaceId));
      const last = r.statusCode ? `HTTP ${r.statusCode}, ${ERROR_TEXT[r.error!]}` : ERROR_TEXT[r.error!];
      await tx
        .insert(notifications)
        .values({
          ownerId: ws!.ownerId,
          projectId: app.projectId,
          category: ws!.mode === "BUSINESS" ? "BUSINESS_EXCEPTION" : "TASK_FAILED",
          title: `${incident.severity} · ${incident.title}`,
          // Host only: a health URL's path or query may carry a token.
          body: `${failures} consecutive failed ${failures === 1 ? "check" : "checks"} of ${new URL(app.healthUrl).host} (last: ${last}). Checked from the home host. Acknowledge or resolve it in Systems.`,
          incidentId: incident.id,
          dedupKey: `incident:${incident.id}:opened`,
        })
        .onConflictDoNothing({ target: notifications.dedupKey });
      await record(tx, ctx, incident, {
        action: "incident.open",
        resourceType: "incident",
        resourceId: incident.id,
        metadata: { appId: app.id, fingerprint: fp, severity: incident.severity, failures },
      });
    } else if (incident) {
      // A pass marks recovery (the owner still resolves); a new failure clears it again.
      const recoveredAt = r.ok ? (incident.recoveredAt ?? check!.checkedAt) : null;
      if (recoveredAt?.getTime() !== incident.recoveredAt?.getTime())
        await tx.update(incidents).set({ recoveredAt }).where(eq(incidents.id, incident.id));
    }

    await tx
      .update(monitoredApps)
      .set({ consecutiveFailures: failures, lastCheckedAt: check!.checkedAt })
      .where(eq(monitoredApps.id, app.id));
    if (ctx.actor !== MONITOR)
      await record(tx, ctx, app, {
        action: "monitoring.app.check",
        resourceType: "monitored_app",
        resourceId: app.id,
        outcome: r.ok ? "SUCCEEDED" : "FAILED",
        metadata: { checkId: check!.id, error: r.error, statusCode: r.statusCode },
      });
    return toCheckDto(check!);
  });
}

export async function listIncidents(db: Db, ownerId: string, q: ListIncidentsQuery) {
  const rows = await db
    .select()
    .from(incidents)
    .where(
      and(
        await scopeOf(db, ownerId, q.projectId, incidents),
        q.status ? eq(incidents.status, q.status) : undefined,
      ),
    )
    .orderBy(desc(incidents.id))
    .limit(INCIDENT_LIST_LIMIT);
  return toIncidentDtos(db, rows);
}

export async function getIncident(db: Db, ownerId: string, id: string) {
  return (await toIncidentDtos(db, [await ownedIncident(db, ownerId, id)]))[0]!;
}

/** OPEN → ACKNOWLEDGED → RESOLVED (or OPEN → RESOLVED). Resolved is final: a new failure streak opens a new one. */
export async function setIncidentStatus(
  db: Db,
  ctx: Ctx,
  id: string,
  status: Exclude<IncidentStatus, "OPEN">,
) {
  return db.transaction(async (tx) => {
    const i = await ownedIncident(tx, ctx.ownerId, id, true);
    await resolveProject(tx, ctx.ownerId, i.projectId, { write: true });
    if (i.status === "RESOLVED")
      throw new HttpError(409, "CONFLICT", "This incident is resolved; a new failure opens a new incident");
    if (i.status === status) return (await toIncidentDtos(tx, [i]))[0]!;
    const now = new Date();
    const [u] = await tx
      .update(incidents)
      .set(status === "ACKNOWLEDGED" ? { status, acknowledgedAt: now } : { status, resolvedAt: now })
      .where(eq(incidents.id, i.id))
      .returning();
    await record(tx, ctx, i, {
      action: `incident.${status.toLowerCase()}`,
      resourceType: "incident",
      resourceId: i.id,
      metadata: { from: i.status, appId: i.appId },
    });
    return (await toIncidentDtos(tx, [u!]))[0]!;
  });
}

// ── Scheduler ──

/** Claims due apps of active projects by moving `next_check_at` forward; racing ticks skip each other's rows. */
async function claimDue(db: Db, now: Date) {
  const due = db
    .select({ id: monitoredApps.id })
    .from(monitoredApps)
    .innerJoin(projects, eq(projects.id, monitoredApps.projectId))
    .where(
      and(
        eq(monitoredApps.disabled, false),
        isNull(projects.archivedAt),
        lte(monitoredApps.nextCheckAt, now),
      ),
    )
    .orderBy(monitoredApps.nextCheckAt)
    .limit(BATCH)
    .for("update", { of: monitoredApps, skipLocked: true });
  return db
    .update(monitoredApps)
    .set({
      nextCheckAt: sql`${now.toISOString()}::timestamptz + make_interval(secs => ${monitoredApps.intervalSeconds})`,
    })
    .where(inArray(monitoredApps.id, due))
    .returning();
}

export type Monitoring = ReturnType<typeof createMonitoring>;

/** The check scheduler (API interval tick) and manual checks. `shutdown` aborts in-flight probes. */
export function createMonitoring(
  db: Db,
  log: FastifyBaseLogger,
  shutdown: AbortSignal,
  probeOpts: ProbeOptions = {},
) {
  let batch: Promise<void> | null = null;
  const run = async (a: AppRow, ctx: Pick<Ctx, "actor" | "correlationId">) =>
    recordCheck(
      db,
      a.id,
      await probe(new URL(a.healthUrl), a.timeoutMs, { ...probeOpts, signal: shutdown }),
      ctx,
    );

  async function runDue(now: Date) {
    const due = await claimDue(db, now);
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        const a = due[next++]!;
        await run(a, { actor: MONITOR, correlationId: randomUUID() }).catch((err: unknown) => {
          if (!shutdown.aborted) log.error({ err, appId: a.id }, "health check failed to record");
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
  }

  return {
    /** Starts checking due apps in the background unless a batch is still running; `drain()` awaits it. */
    tick(now = new Date()) {
      if (batch || shutdown.aborted) return;
      batch = runDue(now)
        .catch((err: unknown) => log.error({ err }, "health check tick failed"))
        .finally(() => {
          batch = null;
        });
    },
    drain: async () => {
      await batch;
    },
    /** Manual check (owner): the app's project must accept writes. */
    async check(ctx: Ctx, appId: string) {
      const a = await ownedApp(db, ctx.ownerId, appId);
      await resolveProject(db, ctx.ownerId, a.projectId, { write: true });
      return run(a, ctx);
    },
  };
}
