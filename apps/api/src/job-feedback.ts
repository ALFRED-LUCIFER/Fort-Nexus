import { and, asc, eq, isNull } from "drizzle-orm";
import {
  isTerminal,
  type ClaimFeedbackResponse,
  type IssueToPrTask,
  type JobFeedback,
  type JobFeedbackList,
  type Verification,
} from "@nexus/contracts";
import { resolveAgentProfile } from "./agents/service.ts";
import { audit } from "./audit.ts";
import type { Db, Tx } from "./db/index.ts";
import { approvals, changesets, jobFeedback, jobs, runners } from "./db/schema.ts";
import { HttpError, notFound } from "./errors.ts";
import { LEASED, createJob, getJob, moveJob, ownerActor, usesDeveloperProfile, type JobRow } from "./jobs.ts";
import type { RunnerRow } from "./runners.ts";

// Spec §5 (Keep fixing) and §6a (feedback): what the owner can say to an issue job, and how the runner picks it up.

type FeedbackRow = typeof jobFeedback.$inferSelect;

const toFeedbackDto = (f: FeedbackRow): JobFeedback => ({
  id: f.id,
  jobId: f.jobId,
  text: f.text,
  createdAt: f.createdAt.toISOString(),
  deliveredRound: f.deliveredRound,
});

// ── Keep fixing ──

const conflict = (message: string, details?: Record<string, unknown>) =>
  new HttpError(409, "CONFLICT", message, details);

/**
 * What Keep fixing may do with the locked job: continue its stored changeset (`continues`), or answer the questions
 * of a NEEDS_INFO job (nothing to continue). Throws the owner-facing refusal otherwise.
 */
async function keepFixingPlan(tx: Tx, job: JobRow, note: string | null) {
  const { status } = job;
  if (!isTerminal(status) && status !== "AWAITING_APPROVAL")
    throw conflict(`This job is still working (${status}). Keep fixing is for a job that has stopped.`, {
      status,
    });
  const rows = await tx.select().from(approvals).where(eq(approvals.jobId, job.id)).for("update");
  if (rows.some((a) => a.status === "EXECUTED" || a.status === "APPROVED"))
    throw conflict("This change was already pushed as a pull request, so there is nothing left to fix here.");

  if (job.outcome === "NEEDS_INFO") {
    if (!note)
      throw new HttpError(400, "VALIDATION_FAILED", "Answer the agent's questions in a note", {
        field: "note",
      });
    return { continues: false, pending: [] };
  }
  const [stored] = await tx.select().from(changesets).where(eq(changesets.jobId, job.id));
  if (!stored) throw conflict("This job saved no changes to continue from. Use Run again to start over.");
  // Changesets stored before the result was kept on them: the approval's own recorded result.
  const latest = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const verification: Verification["status"] | undefined = (
    stored.verification ?? latest?.action.verification
  )?.status;
  if (verification === "passed")
    throw conflict("The tests passed for this change, so there is nothing to fix. Review it and approve it.");
  if (verification === "not_configured")
    throw conflict(
      "This repository has no tests NEXUS can run at the base commit, and Keep fixing keeps that base. Add tests to the repository, then use Run again.",
    );
  return { continues: true, pending: rows.filter((a) => a.status === "PENDING") };
}

/**
 * A new job linked by retryOfJobId that continues a stopped job on its pinned base commit and issue snapshot. It goes
 * through createJob, so the project, the emergency stop and the budget apply. A pending approval of the old job
 * (medvya #213) is withdrawn in the same transaction: the approval is DENIED and the job CANCELLED.
 */
export async function keepFixingJob(
  db: Db,
  input: {
    ownerId: string;
    jobId: string;
    note: string | null;
    idempotencyKey: string;
    correlationId: string;
    timezone: string;
  },
): Promise<JobRow> {
  const original = await getJob(db, input.ownerId, input.jobId);
  const snapshot = original.issueSnapshot;
  if (original.jobType !== "DEV_ISSUE_TO_PR" || !snapshot)
    throw conflict("Only an issue run can keep fixing.");
  const { note } = input;
  const pin = original.request.runnerId;
  const [pinned] = pin
    ? await db
        .select({ id: runners.id })
        .from(runners)
        .where(and(eq(runners.id, pin), eq(runners.ownerId, input.ownerId), isNull(runners.revokedAt)))
    : [];

  return createJob(db, {
    ownerId: input.ownerId,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    timezone: input.timezone,
    body: pin && !pinned ? { ...original.request, runnerId: undefined } : original.request,
    agent: original.agent,
    retryOfJobId: original.id,
    pinIssue: () => Promise.reject(new Error("Keep fixing never pins the issue again")),
    keepFixing: {
      snapshot,
      note,
      // Judged on the locked job, inside the creating transaction (never on a replay).
      beforeCreate: async (tx) => {
        // Same lock shape as decideApproval (the approvals joined to the job, in one statement), so a concurrent
        // approve and Keep fixing queue behind each other instead of deadlocking. No approval: the job alone.
        const [joined] = await tx
          .select({ job: jobs })
          .from(approvals)
          .innerJoin(jobs, eq(jobs.id, approvals.jobId))
          .where(eq(approvals.jobId, original.id))
          .for("update");
        const [locked] = joined
          ? [joined.job]
          : await tx.select().from(jobs).where(eq(jobs.id, original.id)).for("update");
        if (!locked) throw notFound("Job");
        const plan = await keepFixingPlan(tx, locked, note);
        if (plan.pending[0]) await withdraw(tx, locked, plan.pending[0].id, input);
        return { continues: plan.continues };
      },
    },
  });
}

/** The old job's pending approval can no longer be decided, and the job ends CANCELLED (AWAITING_APPROVAL allows it). */
async function withdraw(
  tx: Tx,
  job: JobRow,
  approvalId: string,
  by: { ownerId: string; correlationId: string },
) {
  const actor = ownerActor(by.ownerId);
  await tx
    .update(approvals)
    .set({
      status: "DENIED",
      decidedAt: new Date(),
      decidedBy: actor,
      error: "Withdrawn: Keep fixing continued this change in a new run",
    })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "PENDING")));
  await moveJob(
    tx,
    job,
    "CANCELLED",
    actor,
    [
      { type: "approval.decided", stage: "publish", payload: { approvalId, decision: "withdrawn" } },
      { type: "job.cancelled", payload: { terminated: false, reason: "KEEP_FIXING" } },
    ],
    { leaseExpiresAt: null },
  );
  await audit(tx, {
    actor,
    action: "approval.withdraw",
    resourceType: "approval",
    resourceId: approvalId,
    correlationId: by.correlationId,
    outcome: "DENIED",
    metadata: { jobId: job.id, reason: "keep_fixing" },
  });
}

// ── The lease ──

/** The stopped job's saved changes and the owner's note, for a job started by Keep fixing. */
export async function leaseContinuation(
  db: Db,
  job: JobRow,
): Promise<IssueToPrTask["continuation"] | undefined> {
  if (!job.continuesChangeset && !job.ownerNote) return undefined;
  if (!job.continuesChangeset || !job.retryOfJobId) return { files: [], note: job.ownerNote };
  const [stored] = await db
    .select({ files: changesets.files })
    .from(changesets)
    .where(eq(changesets.jobId, job.retryOfJobId));
  if (!stored) throw conflict("The saved changes this run should continue from are missing.");
  return { files: stored.files, note: job.ownerNote };
}

/** The Developer's model for a directly started job; a plan step's job keeps the runner's default. */
export async function leaseModel(db: Db, job: JobRow): Promise<string | undefined> {
  if (!usesDeveloperProfile(job.idempotencyKey)) return undefined;
  const { settings } = await resolveAgentProfile(db, job.initiatorId, job.projectId, "DEVELOPER");
  return settings.model;
}

// ── Feedback ──

/** A message for a job that hasn't finished. The same key with the same message returns the stored one. */
export async function createFeedback(
  db: Db,
  input: { ownerId: string; jobId: string; text: string; idempotencyKey: string; correlationId: string },
): Promise<JobFeedback> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, input.jobId)).for("update");
    if (!job || job.initiatorId !== input.ownerId) throw notFound("Job");
    const [existing] = await tx
      .select()
      .from(jobFeedback)
      .where(
        and(eq(jobFeedback.ownerId, input.ownerId), eq(jobFeedback.idempotencyKey, input.idempotencyKey)),
      );
    if (existing) {
      if (existing.jobId !== job.id || existing.text !== input.text)
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency-Key was already used with a different body",
        );
      return toFeedbackDto(existing);
    }
    if (job.jobType !== "DEV_ISSUE_TO_PR") throw conflict("Only an issue run takes feedback.");
    if (isTerminal(job.status)) throw conflict("This job has finished. Use Keep fixing to continue it.");
    // No runner holds it and none will claim again: the message would wait forever.
    if (job.status === "AWAITING_APPROVAL")
      throw conflict(
        "This job is waiting for your approval, so no round will read a message. Use Keep fixing to continue it.",
      );

    const [row] = await tx
      .insert(jobFeedback)
      .values({
        jobId: job.id,
        ownerId: input.ownerId,
        text: input.text,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: "job.feedback",
      resourceType: "job",
      resourceId: job.id,
      correlationId: input.correlationId,
      // The message is the owner's words for the agent; the audit trail keeps only that it was sent.
      metadata: { feedbackId: row!.id, length: input.text.length },
    });
    return toFeedbackDto(row!);
  });
}

export async function listFeedback(db: Db, ownerId: string, jobId: string): Promise<JobFeedbackList> {
  await getJob(db, ownerId, jobId);
  const rows = await db
    .select()
    .from(jobFeedback)
    .where(eq(jobFeedback.jobId, jobId))
    .orderBy(asc(jobFeedback.createdAt), asc(jobFeedback.id));
  return { items: rows.map(toFeedbackDto) };
}

/**
 * The runner takes the waiting messages for the round it is about to start, under its lease. They are assigned to
 * `round` under the job's row lock, so concurrent claims can't hand one out twice; asking again for the same round returns
 * what it was assigned, so a lost response loses nothing. Round 0 means no round will use them.
 */
export async function claimFeedback(
  db: Db,
  runner: RunnerRow,
  jobId: string,
  body: { fencingToken: number; round: number },
): Promise<ClaimFeedbackResponse> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
    if (!job || job.initiatorId !== runner.ownerId) throw notFound("Job");
    if (
      job.runnerId !== runner.id ||
      job.fencingToken !== body.fencingToken ||
      !LEASED.includes(job.status) ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= new Date()
    )
      throw new HttpError(409, "STALE_LEASE", "This runner no longer holds the lease for this job");
    await tx
      .update(jobFeedback)
      .set({ deliveredRound: body.round })
      .where(and(eq(jobFeedback.jobId, job.id), isNull(jobFeedback.deliveredRound)));
    const rows = await tx
      .select()
      .from(jobFeedback)
      .where(and(eq(jobFeedback.jobId, job.id), eq(jobFeedback.deliveredRound, body.round)))
      .orderBy(asc(jobFeedback.createdAt), asc(jobFeedback.id));
    return { items: rows.map((r) => ({ id: r.id, text: r.text })) };
  });
}
