import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  RUNNER_LEASE_TTL_MS,
  canTransition,
  isTerminal,
  type AppendEventsRequest,
  type AppendEventsResponse,
  type CreateJobRequest,
  type IssueSnapshot,
  type Job,
  type JobList,
  type JobStatus,
  type ListJobsQuery,
  type RunEvent,
  type RunEventType,
  type RunStage,
} from "@nexus/contracts";
import { audit } from "./audit.ts";
import type { Db, Tx } from "./db/index.ts";
import { approvals, jobs, runEventBatches, runEvents, runners } from "./db/schema.ts";
import { HttpError, invalidTransition, notFound } from "./errors.ts";
import { workBranch } from "./issue-to-pr.ts";
import { notifyForJobEvents } from "./notifications.ts";
import { assertCanStart, emergencyStopEngaged, reportedCostUsd } from "./system.ts";
import { assertProjectAllowsJob } from "./workspaces.ts";

export const JOB_EVENTS_CHANNEL = "nexus_job_events";
export const LEASED: JobStatus[] = ["PREPARING", "RUNNING", "VERIFYING"];
// Types only the server may emit; runners get 400 if they try.
const SERVER_ONLY_EVENTS = new Set<RunEventType>([
  "job.created",
  "job.state.changed",
  "job.recovery_required",
]);

export type JobRow = typeof jobs.$inferSelect;
type RunnerRow = typeof runners.$inferSelect;
export type NewEvent = {
  type: RunEventType;
  stage?: RunStage | null;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
};

export const ownerActor = (userId: string) => `user:${userId}`;
export const runnerActor = (runnerId: string) => `runner:${runnerId}`;

export const toJobDto = (j: JobRow): Job => ({
  id: j.id,
  projectId: j.projectId,
  jobType: j.jobType,
  status: j.status,
  riskTier: j.riskTier,
  request: j.request,
  runnerId: j.runnerId,
  outcome: j.outcome,
  stateVersion: j.stateVersion,
  lastEventSequence: j.lastEventSequence,
  issue: j.issueSnapshot
    ? {
        fullName: j.issueSnapshot.fullName,
        issueNumber: j.issueSnapshot.issueNumber,
        title: j.issueSnapshot.title,
        workBranch: workBranch(j.issueSnapshot.issueNumber, j.id),
      }
    : null,
  estimatedCostUsd: j.estimatedCostUsd,
  createdAt: j.createdAt.toISOString(),
  updatedAt: j.updatedAt.toISOString(),
});

export const toRunEventDto = (e: typeof runEvents.$inferSelect): RunEvent => ({
  eventId: e.id,
  jobId: e.jobId,
  sequence: e.sequence,
  occurredAt: e.occurredAt.toISOString(),
  type: e.type,
  stage: e.stage,
  actor: e.actor,
  payload: e.payload,
});

export const stateChanged = (
  from: JobStatus,
  to: JobStatus,
  extra: Record<string, unknown> = {},
): NewEvent => ({
  type: "job.state.changed",
  payload: { from, to, ...extra },
});

/** Appends events after `afterSeq` and NOTIFYs listeners (delivered on commit). Returns the new last sequence. */
export async function writeEvents(
  tx: Tx,
  jobId: string,
  afterSeq: number,
  actor: string,
  events: NewEvent[],
) {
  if (events.length === 0) return afterSeq;
  await tx.insert(runEvents).values(
    events.map((e, i) => ({
      jobId,
      sequence: afterSeq + i + 1,
      occurredAt: e.occurredAt ?? new Date(),
      type: e.type,
      stage: e.stage ?? null,
      actor,
      payload: e.payload ?? {},
    })),
  );
  await tx.execute(sql`select pg_notify(${JOB_EVENTS_CHANNEL}, ${jobId})`);
  await notifyForJobEvents(tx, jobId, events);
  return afterSeq + events.length;
}

// Stable key order so semantically equal bodies hash equally.
export const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Server-driven transition of a locked job row: `events`, then its job.state.changed, in one write. */
export async function moveJob(
  tx: Tx,
  job: JobRow,
  to: JobStatus,
  actor: string,
  events: NewEvent[],
  set: Partial<Pick<JobRow, "outcome" | "leaseExpiresAt">> = {},
): Promise<JobRow> {
  if (!canTransition(job.status, to)) throw invalidTransition(job.status, to);
  const seq = await writeEvents(tx, job.id, job.lastEventSequence, actor, [
    ...events,
    stateChanged(job.status, to, set.outcome ? { outcome: set.outcome } : {}),
  ]);
  const [moved] = await tx
    .update(jobs)
    .set({
      status: to,
      stateVersion: job.stateVersion + 1,
      lastEventSequence: seq,
      updatedAt: new Date(),
      ...set,
    })
    .where(eq(jobs.id, job.id))
    .returning();
  return moved!;
}

/** The API itself fails a job it was driving (e.g. no GitHub token at lease time). No-op once terminal. */
export async function failJob(
  db: Db,
  input: { jobId: string; actor: string; reason: string; message: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, input.jobId)).for("update");
    if (!job || !canTransition(job.status, "FAILED")) return;
    await moveJob(
      tx,
      job,
      "FAILED",
      input.actor,
      [{ type: "job.failed", payload: { reason: input.reason, message: input.message } }],
      { leaseExpiresAt: null },
    );
    await audit(tx, {
      actor: input.actor,
      action: "job.fail",
      resourceType: "job",
      resourceId: job.id,
      correlationId: job.id,
      outcome: "FAILED",
      metadata: { from: job.status, reason: input.reason },
    });
  });
}

// ── Owner operations ──
// Creation and lists are scoped by project (FR-WKS-02); single-object reads stay owner-scoped and return projectId.

export async function createJob(
  db: Db,
  input: {
    ownerId: string;
    idempotencyKey: string;
    body: CreateJobRequest;
    correlationId: string;
    /** The owner's day for the daily budget (config OWNER_TIMEZONE). */
    timezone: string;
    /** DEV_ISSUE_TO_PR: validates against GitHub and pins the issue. Runs only for a new key, outside the tx. */
    pinIssue: (body: Extract<CreateJobRequest, { jobType: "DEV_ISSUE_TO_PR" }>) => Promise<IssueSnapshot>;
  },
): Promise<JobRow> {
  const requestHash = sha256(canonical(input.body));
  const byKey = and(eq(jobs.initiatorId, input.ownerId), eq(jobs.idempotencyKey, input.idempotencyKey));
  const replay = (existing: JobRow) => {
    if (existing.requestHash !== requestHash)
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key was already used with a different body",
      );
    return existing;
  };

  const [existing] = await db.select().from(jobs).where(byKey);
  if (existing) return replay(existing);
  const body = input.body;
  // Before GitHub is called; both re-checked under lock below.
  await assertProjectAllowsJob(db, input.ownerId, body);
  await assertCanStart(db, body, input.timezone);
  const snapshot = body.jobType === "DEV_ISSUE_TO_PR" ? await input.pinIssue(body) : null;

  return db.transaction(async (tx) => {
    await assertProjectAllowsJob(tx, input.ownerId, body);
    await assertCanStart(tx, body, input.timezone);
    const target = input.body.runnerId;
    if (target) {
      const [r] = await tx
        .select({ id: runners.id })
        .from(runners)
        .where(and(eq(runners.id, target), eq(runners.ownerId, input.ownerId), isNull(runners.revokedAt)));
      if (!r)
        throw new HttpError(400, "VALIDATION_FAILED", "Unknown or revoked runner", { field: "runnerId" });
    }

    // Validation already happened (Zod + runner check); the job is recorded as DRAFT → VALIDATING → QUEUED.
    const [job] = await tx
      .insert(jobs)
      .values({
        initiatorId: input.ownerId,
        projectId: body.projectId,
        jobType: body.jobType,
        status: "QUEUED",
        // RUNNER_DIAGNOSTIC: read-only fixed argv. DEV_ISSUE_TO_PR: sandboxed edits; the push is a separate R2 approval.
        riskTier: snapshot ? "R1" : "R0",
        request: body,
        issueSnapshot: snapshot,
        requestHash,
        idempotencyKey: input.idempotencyKey,
        targetRunnerId: target ?? null,
        stateVersion: 2,
        lastEventSequence: 3,
      })
      .onConflictDoNothing({ target: [jobs.initiatorId, jobs.idempotencyKey] })
      .returning();
    if (!job) {
      // A concurrent request with the same key won the insert.
      const [raced] = await tx.select().from(jobs).where(byKey);
      if (!raced) throw new Error("idempotent insert conflicted but no row found");
      return replay(raced);
    }
    const actor = ownerActor(input.ownerId);
    await writeEvents(tx, job.id, 0, actor, [
      {
        type: "job.created",
        payload: {
          jobType: job.jobType,
          request: job.request,
          // FR-DEV-01: missing acceptance criteria are recorded, not blocking.
          ...(snapshot
            ? { issue: snapshot, missingAcceptanceCriteria: snapshot.acceptanceCriteria.length === 0 }
            : {}),
        },
      },
      stateChanged("DRAFT", "VALIDATING"),
      stateChanged("VALIDATING", "QUEUED"),
    ]);
    await audit(tx, {
      actor,
      action: "job.create",
      resourceType: "job",
      resourceId: job.id,
      correlationId: input.correlationId,
      metadata: {
        jobType: job.jobType,
        projectId: job.projectId,
        targetRunnerId: target ?? null,
        ...(body.jobType === "RUNNER_DIAGNOSTIC"
          ? { preset: body.preset }
          : {
              repositoryId: body.repositoryId,
              issueNumber: body.issueNumber,
              baseBranch: snapshot!.baseBranch,
              baseSha: snapshot!.baseSha,
            }),
      },
    });
    return job;
  });
}

export async function getJob(db: Db, ownerId: string, jobId: string): Promise<JobRow> {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.initiatorId, ownerId)));
  if (!job) throw notFound("Job");
  return job;
}

export async function listJobs(db: Db, ownerId: string, q: ListJobsQuery): Promise<JobList> {
  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.initiatorId, ownerId),
        q.projectId ? eq(jobs.projectId, q.projectId) : undefined,
        q.status ? eq(jobs.status, q.status) : undefined,
        q.cursor ? lt(jobs.id, q.cursor) : undefined,
      ),
    )
    .orderBy(desc(jobs.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return { items: page.map(toJobDto), nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null };
}

export async function cancelJob(
  db: Db,
  input: { ownerId: string; jobId: string; correlationId: string },
): Promise<JobRow> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, input.jobId), eq(jobs.initiatorId, input.ownerId)))
      .for("update");
    if (!job) throw notFound("Job");
    const actor = ownerActor(input.ownerId);
    const now = new Date();
    const record = (action: string) =>
      audit(tx, {
        actor,
        action,
        resourceType: "job",
        resourceId: job.id,
        correlationId: input.correlationId,
        metadata: { from: job.status },
      });

    if (LEASED.includes(job.status)) {
      // The runner holds it: ask via heartbeat; only the runner may confirm CANCELLED once the process is gone.
      if (job.cancelRequestedAt) return job;
      const [updated] = await tx
        .update(jobs)
        .set({ cancelRequestedAt: now, updatedAt: now })
        .where(eq(jobs.id, job.id))
        .returning();
      await record("job.cancel_requested");
      return updated!;
    }
    if (!canTransition(job.status, "CANCELLED")) throw invalidTransition(job.status, "CANCELLED");
    if (job.status === "AWAITING_APPROVAL") {
      // An approved push is already running on GitHub's side; a pending one is withdrawn with the job.
      const open = await tx.select().from(approvals).where(eq(approvals.jobId, job.id)).for("update");
      if (open.some((a) => a.status === "APPROVED"))
        throw new HttpError(409, "CONFLICT", "The approved push is in progress and can't be cancelled");
      await tx
        .update(approvals)
        .set({ status: "DENIED", decidedAt: now, decidedBy: actor, error: "Run cancelled" })
        .where(and(eq(approvals.jobId, job.id), eq(approvals.status, "PENDING")));
    }
    const seq = await writeEvents(tx, job.id, job.lastEventSequence, actor, [
      stateChanged(job.status, "CANCELLED"),
      { type: "job.cancelled", payload: { terminated: false, reason: "CANCELLED_BEFORE_START" } },
    ]);
    const [updated] = await tx
      .update(jobs)
      .set({
        status: "CANCELLED",
        cancelRequestedAt: now,
        stateVersion: job.stateVersion + 1,
        lastEventSequence: seq,
        updatedAt: now,
      })
      .where(eq(jobs.id, job.id))
      .returning();
    await record("job.cancel");
    return updated!;
  });
}

/** Events with sequence > afterSequence, oldest first. */
export const eventsAfter = (db: Db, jobId: string, afterSequence: number, limit = 500) =>
  db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.jobId, jobId), gt(runEvents.sequence, afterSequence)))
    .orderBy(asc(runEvents.sequence))
    .limit(limit);

// ── Runner operations ──

/** Claims the oldest eligible QUEUED job for this runner (the jobs table is the queue). */
export async function tryLease(db: Db, runner: RunnerRow): Promise<JobRow | null> {
  return db.transaction(async (tx) => {
    // Lock the runner row so concurrent lease calls from one runner can't exceed its capacity.
    const [locked] = await tx.select().from(runners).where(eq(runners.id, runner.id)).for("update");
    if (!locked || locked.revokedAt) return null;
    if (await emergencyStopEngaged(tx)) return null;
    const [held] = await tx
      .select({ n: count() })
      .from(jobs)
      .where(and(eq(jobs.runnerId, runner.id), inArray(jobs.status, LEASED)));
    if ((held?.n ?? 0) >= locked.capacity) return null;

    const [job] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "QUEUED"),
          eq(jobs.initiatorId, locked.ownerId),
          or(isNull(jobs.targetRunnerId), eq(jobs.targetRunnerId, runner.id)),
        ),
      )
      .orderBy(asc(jobs.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!job) return null;

    const now = new Date();
    const seq = await writeEvents(tx, job.id, job.lastEventSequence, "system:scheduler", [
      stateChanged("QUEUED", "PREPARING", { runnerId: runner.id }),
    ]);
    const [leased] = await tx
      .update(jobs)
      .set({
        status: "PREPARING",
        runnerId: runner.id,
        fencingToken: job.fencingToken + 1,
        leaseExpiresAt: new Date(now.getTime() + RUNNER_LEASE_TTL_MS),
        stateVersion: job.stateVersion + 1,
        lastEventSequence: seq,
        updatedAt: now,
      })
      .where(eq(jobs.id, job.id))
      .returning();
    return leased!;
  });
}

export async function heartbeat(db: Db, runner: RunnerRow, activeJobIds: string[]): Promise<string[]> {
  const now = new Date();
  const mine = and(eq(jobs.runnerId, runner.id), inArray(jobs.status, LEASED));
  await db.update(runners).set({ lastHeartbeatAt: now }).where(eq(runners.id, runner.id));
  if (activeJobIds.length > 0)
    // Only live leases are extended; an expired one belongs to the reaper.
    await db
      .update(jobs)
      .set({ leaseExpiresAt: new Date(now.getTime() + RUNNER_LEASE_TTL_MS) })
      .where(and(mine, inArray(jobs.id, activeJobIds), gt(jobs.leaseExpiresAt, now)));
  const cancel = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(mine, isNotNull(jobs.cancelRequestedAt)));
  return cancel.map((c) => c.id);
}

/**
 * Runner-reported progress: events in the given order, then the transition (its job.state.changed last).
 * Idempotent per (jobId, batchId): a batch already applied returns the current state and appends nothing.
 */
export async function appendRunnerEvents(
  db: Db,
  runner: RunnerRow,
  jobId: string,
  body: AppendEventsRequest,
): Promise<AppendEventsResponse> {
  const forbidden = body.events.find((e) => SERVER_ONLY_EVENTS.has(e.type));
  if (forbidden) throw new HttpError(400, "VALIDATION_FAILED", `Runners cannot emit ${forbidden.type}`);
  const t = body.transition;
  if (t && (t.to === "COMPLETED" || t.to === "FAILED") !== (t.outcome !== undefined))
    throw new HttpError(
      400,
      "VALIDATION_FAILED",
      "outcome is required for COMPLETED/FAILED and only for them",
    );

  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
    if (!job || job.initiatorId !== runner.ownerId) throw notFound("Job");
    const stale = () =>
      new HttpError(409, "STALE_LEASE", "This runner no longer holds the lease for this job");

    // Checked before the lease: a retry of the final (terminal) batch must still get its answer.
    const [applied] = await tx
      .select({ runnerId: runEventBatches.runnerId })
      .from(runEventBatches)
      .where(and(eq(runEventBatches.jobId, job.id), eq(runEventBatches.batchId, body.batchId)));
    if (applied) {
      if (applied.runnerId !== runner.id) throw stale();
      return { lastSequence: job.lastEventSequence, status: job.status };
    }

    const now = new Date();
    if (
      job.runnerId !== runner.id ||
      job.fencingToken !== body.fencingToken ||
      !LEASED.includes(job.status) ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= now
    )
      throw stale();

    const events: NewEvent[] = body.events.map((e) => ({ ...e, occurredAt: new Date(e.occurredAt) }));
    let { status, outcome, stateVersion } = job;
    if (t) {
      if (!canTransition(job.status, t.to)) throw invalidTransition(job.status, t.to);
      events.push(stateChanged(job.status, t.to, t.outcome ? { outcome: t.outcome } : {}));
      status = t.to;
      outcome = t.outcome ?? outcome;
      stateVersion += 1;
    }
    const cost = reportedCostUsd(body.events);
    await tx.insert(runEventBatches).values({ jobId: job.id, batchId: body.batchId, runnerId: runner.id });
    const seq = await writeEvents(tx, job.id, job.lastEventSequence, runnerActor(runner.id), events);
    await tx
      .update(jobs)
      .set({
        status,
        outcome,
        stateVersion,
        lastEventSequence: seq,
        leaseExpiresAt: LEASED.includes(status) ? job.leaseExpiresAt : null,
        ...(cost === null ? {} : { estimatedCostUsd: (job.estimatedCostUsd ?? 0) + cost }),
        updatedAt: now,
      })
      .where(eq(jobs.id, job.id));
    return { lastSequence: seq, status };
  });
}

/** Leased jobs whose lease ran out → RECOVERY_REQUIRED. Never auto-retried. Returns how many were moved. */
export async function reapExpiredLeases(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const expired = await tx
      .select()
      .from(jobs)
      .where(and(inArray(jobs.status, LEASED), lt(jobs.leaseExpiresAt, now)))
      .limit(100)
      .for("update", { skipLocked: true });
    for (const job of expired) {
      const seq = await writeEvents(tx, job.id, job.lastEventSequence, "system:reaper", [
        stateChanged(job.status, "RECOVERY_REQUIRED", { reason: "LEASE_EXPIRED" }),
        {
          type: "job.recovery_required",
          payload: { reason: "LEASE_EXPIRED", runnerId: job.runnerId, fencingToken: job.fencingToken },
        },
      ]);
      await tx
        .update(jobs)
        .set({
          status: "RECOVERY_REQUIRED",
          leaseExpiresAt: null,
          stateVersion: job.stateVersion + 1,
          lastEventSequence: seq,
          updatedAt: now,
        })
        .where(eq(jobs.id, job.id));
      await audit(tx, {
        actor: "system:reaper",
        action: "job.recovery_required",
        resourceType: "job",
        resourceId: job.id,
        correlationId: job.id,
        metadata: { from: job.status, runnerId: job.runnerId, reason: "LEASE_EXPIRED" },
      });
    }
    return expired.length;
  });
}

export const isJobTerminal = (j: Pick<JobRow, "status">) => isTerminal(j.status);
