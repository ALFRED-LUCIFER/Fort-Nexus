import { and, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { CreateJobRequest, JobStatus, RunnerEventInput, SystemControls } from "@nexus/contracts";
import { audit } from "./audit.ts";
import type { Db, Tx } from "./db/index.ts";
import { aiSpend, jobs, systemControls, type AiSpendSource } from "./db/schema.ts";
import { HttpError } from "./errors.ts";
import { LEASED, moveJob, ownerActor, type JobRow } from "./jobs.ts";
import { notifySecurity } from "./notifications.ts";

// Owner safety controls: emergency stop (FR-INB-04, FR-CSP-09) and the daily budget cap (FR-SEC-08, GATE-09).
// Lock order everywhere: the controls row first, then jobs, so engaging the stop can't deadlock with a create/lease.

const ROW = eq(systemControls.id, 1);
const MAX_REPORTED_COST_USD = 1_000; // a summary claiming more is a broken runner, not a real run
const usd = (n: number) => `$${n.toFixed(2)}`;
const micros = (n: number) => Math.round(n * 1e6);

async function controls(db: Db | Tx, lock?: "share" | "update") {
  const q = db.select().from(systemControls).where(ROW);
  const [row] = await (lock ? q.for(lock) : q);
  if (!row) throw new Error("system_controls row is missing (migration 0003 seeds it)");
  return row;
}

/** Share-locks the controls row: an engaging stop waits for this transaction, or this one sees it engaged. */
export const emergencyStopEngaged = async (db: Db | Tx) => (await controls(db, "share")).emergencyStopEngaged;

/** Guard for anything that would start work or execute an approval. */
export async function assertNotStopped(tx: Db | Tx) {
  if (await emergencyStopEngaged(tx))
    throw new HttpError(
      409,
      "EMERGENCY_STOP",
      "Emergency stop is engaged: nothing new can start and approvals can't execute until you release it.",
    );
}

// While an issue run's agent may still be spending (or NEXUS lost sight of it), its whole cost cap is reserved; once
// it stopped, only the cost the runner reported counts (none reported = nothing spent, e.g. cancelled while queued).
const RESERVING: readonly JobStatus[] = [
  "DRAFT",
  "VALIDATING",
  "QUEUED",
  "PREPARING",
  "RUNNING",
  "VERIFYING",
  "RECOVERY_REQUIRED",
];
const jobSpend = sql`case when ${jobs.jobType} = 'DEV_ISSUE_TO_PR' and ${inArray(jobs.status, [...RESERVING])}
  then greatest(coalesce(${jobs.estimatedCostUsd}, 0), (${jobs.request}->'budget'->>'maxCostUsd')::numeric)
  else coalesce(${jobs.estimatedCostUsd}, 0) end`;

/**
 * Today's spend in the owner's timezone, for work created since local midnight: each job's reported cost, or its
 * whole cap while it may still spend (RESERVING), plus the AI spend ledger, where an unsettled reservation counts in
 * full. A job is counted once: by its cap or by its reported cost, never both. `exceptJobId` leaves one job out
 * (a lease sizes that job's cap from what the others leave).
 */
async function budgetStatus(db: Db | Tx, timezone: string, now: Date, exceptJobId?: string) {
  const local = sql`(${now.toISOString()}::timestamptz at time zone ${timezone}::text)`;
  const dayStart = sql`date_trunc('day', ${local}) at time zone ${timezone}::text`;
  const dayEnd = sql`(date_trunc('day', ${local}) + interval '1 day') at time zone ${timezone}::text`;
  const [row] = await db
    .select({
      spent: sql`coalesce(sum(${jobSpend}), 0)`.mapWith(Number),
      resetsAt: sql`${dayEnd}`.mapWith(jobs.createdAt),
    })
    .from(jobs)
    .where(
      and(
        gte(jobs.createdAt, dayStart),
        lt(jobs.createdAt, dayEnd),
        exceptJobId ? ne(jobs.id, exceptJobId) : undefined,
      ),
    );
  const [ledger] = await db
    .select({
      spent: sql`coalesce(sum(coalesce(${aiSpend.costUsd}, ${aiSpend.reservedUsd})), 0)`.mapWith(Number),
    })
    .from(aiSpend)
    .where(and(gte(aiSpend.createdAt, dayStart), lt(aiSpend.createdAt, dayEnd)));
  const cap = (await controls(db)).dailyBudgetUsd;
  const spent = (micros(row!.spent) + micros(ledger!.spent)) / 1e6;
  return {
    dailyCapUsd: cap,
    spentTodayUsd: spent,
    remainingUsd: Math.max(0, micros(cap) - micros(spent)) / 1e6,
    timezone,
    resetsAt: row!.resetsAt,
    exhausted: micros(spent) >= micros(cap),
  };
}

export async function getSystemControls(db: Db, timezone: string, now = new Date()): Promise<SystemControls> {
  const row = await controls(db);
  const b = await budgetStatus(db, timezone, now);
  return {
    emergencyStop: {
      engaged: row.emergencyStopEngaged,
      changedAt: row.emergencyStopChangedAt?.toISOString() ?? null,
    },
    budget: {
      dailyCapUsd: b.dailyCapUsd,
      spentTodayUsd: b.spentTodayUsd,
      timezone,
      resetsAt: b.resetsAt.toISOString(),
      exhausted: b.exhausted,
    },
  };
}

// How the owner calls each ledger source's work in a BUDGET_EXHAUSTED message; only a run's and a deep dive's cap is
// theirs to lower.
const SPEND_WORK: Record<AiSpendSource, string> = {
  DEEP_DIVE: "deep dive",
  JOB_DRAFT: "job draft",
  EXPLAIN: "explanation",
  TRIAGE: "triage",
  TALK: "answer",
  PLAN_DRAFT: "plan draft",
};

/** BUDGET_EXHAUSTED unless `max` fits in what is left of today's budget; `what` names the work for the owner. */
async function assertFits(tx: Db | Tx, max: number, timezone: string, what: string) {
  const b = await budgetStatus(tx, timezone, new Date());
  const lower = what === "run" || what === "deep dive" ? `Lower the ${what}'s cost cap, or raise` : "Raise";
  if (micros(b.spentTodayUsd) + micros(max) > micros(b.dailyCapUsd))
    throw new HttpError(
      409,
      "BUDGET_EXHAUSTED",
      `Today's AI budget can't cover this ${what}: ${usd(b.remainingUsd)} of ${usd(b.dailyCapUsd)} is left and this ${what} may use up to ${usd(max)}. ${lower} the daily cap in Settings → Budgets & limits. It resets at midnight ${timezone}.`,
      {
        dailyCapUsd: b.dailyCapUsd,
        spentTodayUsd: b.spentTodayUsd,
        remainingUsd: b.remainingUsd,
        requestedMaxCostUsd: max,
        resetsAt: b.resetsAt.toISOString(),
      },
    );
}

/**
 * Create guard: not stopped, and an issue run's cost cap fits in what is left of today's budget, where every other
 * run still going counts its whole cap (`budgetStatus`). For an issue run the controls row is locked for update
 * (the lock order of every reservation), so parallel creates queue here and each sees the others' caps: N runs
 * can't each pass against the same remainder. Inside the create transaction, the new job's insert reserves its cap.
 */
export async function assertCanStart(tx: Db | Tx, body: CreateJobRequest, timezone: string) {
  if (body.jobType !== "DEV_ISSUE_TO_PR") return assertNotStopped(tx);
  if ((await controls(tx, "update")).emergencyStopEngaged)
    throw new HttpError(
      409,
      "EMERGENCY_STOP",
      "Emergency stop is engaged: nothing new can start and approvals can't execute until you release it.",
    );
  await assertFits(tx, body.budget.maxCostUsd, timezone, "run");
}

/**
 * Reserves `maxUsd` of today's budget for direct model calls (FR-CSP-08), in the caller's transaction. The controls
 * row is locked for update first (the same order as jobs), so concurrent reservations queue and can't overshoot
 * the cap together; an engaged emergency stop refuses too. Same 409s as `assertCanStart`.
 */
export async function reserveAiSpend(
  tx: Tx,
  i: {
    workspaceId: string;
    projectId: string;
    source: AiSpendSource;
    sourceId: string;
    maxUsd: number;
    timezone: string;
  },
): Promise<{ spendId: string }> {
  if ((await controls(tx, "update")).emergencyStopEngaged)
    throw new HttpError(
      409,
      "EMERGENCY_STOP",
      "Emergency stop is engaged: nothing new can start and approvals can't execute until you release it.",
    );
  await assertFits(tx, i.maxUsd, i.timezone, SPEND_WORK[i.source]);
  const [row] = await tx
    .insert(aiSpend)
    .values({
      workspaceId: i.workspaceId,
      projectId: i.projectId,
      source: i.source,
      sourceId: i.sourceId,
      reservedUsd: i.maxUsd,
    })
    .returning({ id: aiSpend.id });
  return { spendId: row!.id };
}

/** Replaces a reservation with the measured cost. Settles once: a repeated call changes nothing. */
export async function settleAiSpend(db: Db | Tx, spendId: string, costUsd: number): Promise<void> {
  await db
    .update(aiSpend)
    .set({ costUsd: Math.max(0, micros(costUsd)) / 1e6, settledAt: new Date() })
    .where(and(eq(aiSpend.id, spendId), isNull(aiSpend.settledAt)));
}

/**
 * The request a runner leases: an issue run's cost cap is lowered to what the rest of today's spend leaves (whole
 * cents; its own reservation doesn't count against it). null when less than a cent is left: the caller fails the
 * job instead of starting it.
 */
export async function leaseRequest(db: Db, job: JobRow, timezone: string): Promise<CreateJobRequest | null> {
  const r = job.request;
  if (r.jobType !== "DEV_ISSUE_TO_PR") return r;
  const left = Math.floor((await budgetStatus(db, timezone, new Date(), job.id)).remainingUsd * 100) / 100;
  if (left <= 0) return null;
  return left < r.budget.maxCostUsd ? { ...r, budget: { ...r.budget, maxCostUsd: left } } : r;
}

/** Cost the runner reported in a batch's `agent.message` summaries; null when the batch has none. */
export function reportedCostUsd(
  events: readonly Pick<RunnerEventInput, "type" | "payload">[],
): number | null {
  let total: number | null = null;
  for (const { type, payload } of events) {
    const c = payload.estimatedCostUsd;
    if (type !== "agent.message" || payload.kind !== "summary" || typeof c !== "number") continue;
    if (Number.isFinite(c) && c >= 0 && c <= MAX_REPORTED_COST_USD) total = (total ?? 0) + c;
  }
  return total;
}

/**
 * Engage: queued jobs are cancelled now, leased ones get a cancel request (runners see it on their next
 * heartbeat), leases and job creation stop, approvals can't execute. Release only by an explicit call.
 * Repeating the current state changes nothing and records nothing.
 */
export async function setEmergencyStop(
  db: Db,
  input: { ownerId: string; engaged: boolean; correlationId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await controls(tx, "update");
    if (row.emergencyStopEngaged === input.engaged) return;
    const now = new Date();
    const actor = ownerActor(input.ownerId);
    await tx
      .update(systemControls)
      .set({ emergencyStopEngaged: input.engaged, emergencyStopChangedAt: now, updatedAt: now })
      .where(ROW);
    const cancelled: string[] = [];
    const stopping: string[] = [];
    if (input.engaged) {
      // shortcut: one owner per NEXUS, so the stop is global; scope it per workspace once workspaces land (FR-WKS-01).
      const queued = await tx.select().from(jobs).where(eq(jobs.status, "QUEUED")).for("update");
      for (const job of queued) {
        await moveJob(tx, job, "CANCELLED", actor, [
          { type: "job.cancelled", payload: { terminated: false, reason: "EMERGENCY_STOP" } },
        ]);
        cancelled.push(job.id);
      }
      const leased = await tx
        .update(jobs)
        .set({ cancelRequestedAt: now, updatedAt: now })
        .where(and(inArray(jobs.status, LEASED), isNull(jobs.cancelRequestedAt)))
        .returning({ id: jobs.id });
      stopping.push(...leased.map((j) => j.id));
      for (const [ids, action] of [
        [cancelled, "job.cancel"],
        [stopping, "job.cancel_requested"],
      ] as const)
        for (const id of ids)
          await audit(tx, {
            actor,
            action,
            resourceType: "job",
            resourceId: id,
            correlationId: input.correlationId,
            metadata: { reason: "EMERGENCY_STOP" },
          });
    }
    await audit(tx, {
      actor,
      action: input.engaged ? "system.emergency_stop.engage" : "system.emergency_stop.release",
      resourceType: "system",
      resourceId: "emergency_stop",
      correlationId: input.correlationId,
      // FR-INB-04: what was actually stopped, not just that the button was pressed.
      metadata: input.engaged ? { cancelledJobIds: cancelled, cancelRequestedJobIds: stopping } : {},
    });
    await notifySecurity(tx, {
      ownerId: input.ownerId,
      dedupKey: `emergency_stop:${input.engaged ? "engaged" : "released"}:${input.correlationId}`,
      ...(input.engaged
        ? {
            title: "Emergency stop engaged",
            body: `Queued runs cancelled: ${cancelled.length}. Running runs asked to stop: ${stopping.length}. Nothing new starts and approved pushes wait until you release it.`,
          }
        : {
            title: "Emergency stop released",
            body: "Runs can start again and approved pushes the stop held resume now.",
          }),
    });
  });
}

export async function setDailyBudget(
  db: Db,
  input: { ownerId: string; dailyCapUsd: number; correlationId: string },
): Promise<void> {
  const cap = Math.round(input.dailyCapUsd * 100) / 100; // whole cents, as the owner sees it
  if (cap <= 0) throw new HttpError(400, "VALIDATION_FAILED", "The daily cap must be at least $0.01");
  await db.transaction(async (tx) => {
    const row = await controls(tx, "update");
    if (micros(row.dailyBudgetUsd) === micros(cap)) return;
    await tx.update(systemControls).set({ dailyBudgetUsd: cap, updatedAt: new Date() }).where(ROW);
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: "system.budget.set",
      resourceType: "system",
      resourceId: "daily_budget",
      correlationId: input.correlationId,
      metadata: { fromUsd: row.dailyBudgetUsd, toUsd: cap },
    });
  });
}
