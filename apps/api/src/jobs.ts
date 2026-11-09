import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  RUNNER_LEASE_TTL_MS,
  canTransition,
  type AgentKey,
  type JobType,
  isTerminal,
  type AppendEventsRequest,
  type AppendEventsResponse,
  type CreateJobRequest,
  type IssueSnapshot,
  type Job,
  type JobList,
  type JobStatus,
  type ListJobsQuery,
  type RemoteAccessReport,
  type RunEvent,
  type RunEventType,
  type RunStage,
} from "@nexus/contracts";
import { resolveAgentProfile } from "./agents/service.ts";
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
  // Only the API talks to GitHub for a push: a runner can't claim a PR was opened, or is being retried.
  "external_action.completed",
  "external_action.retrying",
]);

export type JobRow = typeof jobs.$inferSelect;
type RunnerRow = typeof runners.$inferSelect;
export type NewEvent = {
  type: RunEventType;
  stage?: RunStage | null;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
};

/** A `test.completed` event with `only` is NEXUS's check of the base or of the tests alone, not the job's result. */
export const notBaselineRun = sql`coalesce(${runEvents.payload}->>'only', '') not in ('base', 'red')`;

export const defaultJobAgent = (t: JobType): AgentKey => (t === "DEV_ISSUE_TO_PR" ? "DEVELOPER" : "DEVOPS");

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
  agent: j.agent,
  retryOfJobId: j.retryOfJobId,
  startedAt: j.startedAt?.toISOString() ?? null,
  finishedAt: j.finishedAt?.toISOString() ?? null,
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
  const now = new Date();
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
      updatedAt: now,
      // The Jobs page's duration: first lease start → terminal move.
      ...(to === "PREPARING" && !job.startedAt ? { startedAt: now } : {}),
      ...(isTerminal(to) ? { finishedAt: now } : {}),
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

/**
 * Every issue job the owner (or an automation, draft or Talk on the owner's behalf) starts follows the Developer's
 * effective profile: the budget cap and the model. Only an approved plan's steps keep their own behaviour; their
 * idempotency keys are `plan:<id>:<index>`. The one predicate for both the cap and the lease's model.
 */
export const usesDeveloperProfile = (idempotencyKey: string) => !idempotencyKey.startsWith("plan:");

/** A direct issue job's budget never exceeds what the Developer's effective profile allows (spec §6). */
async function withProfileLimits(
  db: Db,
  input: { ownerId: string; body: CreateJobRequest; idempotencyKey: string },
): Promise<CreateJobRequest> {
  const { body } = input;
  if (!usesDeveloperProfile(input.idempotencyKey) || body.jobType !== "DEV_ISSUE_TO_PR") return body;
  const { settings } = await resolveAgentProfile(db, input.ownerId, body.projectId, "DEVELOPER");
  return {
    ...body,
    budget: {
      ...body.budget,
      maxCostUsd: Math.min(body.budget.maxCostUsd, settings.maxCostUsdPerTask),
      maxTurns: Math.min(body.budget.maxTurns, settings.maxTurns),
    },
  };
}

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
    /** Trusted callers only (plan steps, job drafts); otherwise the job type's default agent. */
    agent?: AgentKey;
    /** `retryJob` and `keepFixingJob` only: the finished job this one reruns. */
    retryOfJobId?: string;
    /**
     * `keepFixingJob` only: the new job starts from the original's issue snapshot (never pinned again), continues its
     * stored changeset unless `beforeCreate` says it has nothing to continue (NEEDS_INFO), and carries the owner's note. `beforeCreate` runs in the creating
     * transaction (not on a replay) and may refuse it.
     */
    keepFixing?: {
      snapshot: IssueSnapshot;
      note: string | null;
      beforeCreate: (tx: Tx) => Promise<{ continues: boolean }>;
    };
  },
): Promise<JobRow> {
  // A rerun is identified by the job it reruns: its body is derived again on every call, so a runner pin dropped
  // between two calls can't turn a replay into a key conflict. Keep fixing hashes differently, so a key used for one
  // never replays as the other.
  const requestHash = sha256(
    canonical(
      input.keepFixing
        ? { keepFixingOf: input.retryOfJobId, note: input.keepFixing.note }
        : input.retryOfJobId
          ? { retryOfJobId: input.retryOfJobId }
          : input.body,
    ),
  );
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
  // Before GitHub is called; both re-checked under lock below.
  await assertProjectAllowsJob(db, input.ownerId, input.body);
  const body = await withProfileLimits(db, input);
  await assertCanStart(db, body, input.timezone);
  const snapshot = input.keepFixing
    ? input.keepFixing.snapshot
    : body.jobType === "DEV_ISSUE_TO_PR"
      ? await input.pinIssue(body)
      : null;

  return db.transaction(async (tx) => {
    await assertProjectAllowsJob(tx, input.ownerId, body);
    await assertCanStart(tx, body, input.timezone);
    const kept = await input.keepFixing?.beforeCreate(tx);
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
        agent: input.agent ?? defaultJobAgent(body.jobType),
        retryOfJobId: input.retryOfJobId ?? null,
        continuesChangeset: kept?.continues ?? false,
        ownerNote: input.keepFixing?.note ?? null,
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
          ...(input.retryOfJobId ? { retryOfJobId: input.retryOfJobId } : {}),
          ...(kept ? { keepFixing: true, continuesChangeset: kept.continues } : {}),
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
      action: input.keepFixing ? "job.keep_fixing" : input.retryOfJobId ? "job.retry" : "job.create",
      resourceType: "job",
      resourceId: job.id,
      correlationId: input.correlationId,
      metadata: {
        jobType: job.jobType,
        projectId: job.projectId,
        targetRunnerId: target ?? null,
        ...(input.retryOfJobId ? { retryOfJobId: input.retryOfJobId } : {}),
        ...(kept ? { continuesChangeset: kept.continues } : {}),
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

/**
 * FR-RUN-06: a finished job starts again as a new job linked by retryOfJobId; the original is never changed. It goes
 * through createJob, so every check applies and an issue run pins the issue as it is now. RECOVERY_REQUIRED isn't
 * terminal, so it stays refused until reconciled.
 */
export async function retryJob(
  db: Db,
  input: {
    ownerId: string;
    jobId: string;
    idempotencyKey: string;
    correlationId: string;
    timezone: string;
    pinIssue: Parameters<typeof createJob>[1]["pinIssue"];
  },
): Promise<JobRow> {
  const { jobId, ...create } = input;
  const original = await getJob(db, input.ownerId, jobId);
  const { status } = original;
  if (status === "RECOVERY_REQUIRED")
    throw new HttpError(409, "CONFLICT", "This job must be recovered before it can run again", { status });
  if (!isTerminal(status))
    throw new HttpError(409, "CONFLICT", `Only a finished job can run again; this one is ${status}`, {
      status,
    });

  const pin = original.request.runnerId;
  const [pinned] = pin
    ? await db
        .select({ id: runners.id })
        .from(runners)
        .where(and(eq(runners.id, pin), eq(runners.ownerId, input.ownerId), isNull(runners.revokedAt)))
    : [];
  return createJob(db, {
    ...create,
    // A runner revoked since is dropped rather than failing the rerun; any runner may lease it.
    body: pin && !pinned ? { ...original.request, runnerId: undefined } : original.request,
    agent: original.agent,
    retryOfJobId: original.id,
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
        finishedAt: now,
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
        startedAt: job.startedAt ?? now,
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

export async function heartbeat(
  db: Db,
  runner: RunnerRow,
  activeJobIds: string[],
  remoteAccess?: RemoteAccessReport,
): Promise<string[]> {
  const now = new Date();
  const mine = and(eq(jobs.runnerId, runner.id), inArray(jobs.status, LEASED));
  await db
    .update(runners)
    // Most beats carry no report; the last one stays until the next arrives.
    .set({ lastHeartbeatAt: now, ...(remoteAccess ? { remoteAccess, remoteAccessAt: now } : {}) })
    .where(eq(runners.id, runner.id));
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
        ...(isTerminal(status) ? { finishedAt: now } : {}),
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
