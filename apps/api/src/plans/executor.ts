import type { FastifyBaseLogger } from "fastify";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  isTerminal,
  type JobOutcome,
  type JobStatus,
  type JobType,
  type PlanStepStatus,
  type SourceRef,
  type StepArtifact,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { audit } from "../audit.ts";
import { getSalesSummary } from "../business/metrics.ts";
import type { Tx } from "../db/index.ts";
import { jobs, projects, runEvents } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { cancelJob, createJob } from "../jobs.ts";
import { notifyPlan } from "../notifications.ts";
import { requireGithub } from "../routes/github.ts";
import { researchRuns } from "../research/schema.ts";
import { createManualRun, getWatchlist } from "../research/service.ts";
import { assertNotStopped, emergencyStopEngaged } from "../system.ts";
import { resolveAgentProfile } from "../agents/service.ts";
import { AGENT_LABEL, issueBusy, profileBlock, type PlanRow, type StepRow } from "./service.ts";
import { planSteps, plans } from "./schema.ts";

// FR-AGT-01/09 executor: one step at a time through existing typed paths. A step is claimed (RUNNING) under the plan
// lock, then acted on with a deterministic idempotency key, then its source id is recorded. A restart between any
// two of those repeats the idempotent act, so a step never creates a second job or research run. Success is read
// only from the source record's terminal state.

const ACTOR = "system:plans";
const FAILED_DEP = new Set<PlanStepStatus>(["FAILED", "SKIPPED", "CANCELLED"]);
const short = (id: string) => id.slice(0, 8);
const words = (s: string) => s.toLowerCase().replaceAll("_", " ");
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// The outcome that makes a run's step succeed: a draft PR GitHub confirmed, or the diagnostic command's success.
const SUCCESS_OUTCOME: Record<JobType, JobOutcome> = {
  DEV_ISSUE_TO_PR: "PR_CREATED",
  RUNNER_DIAGNOSTIC: "COMMAND_SUCCEEDED",
};
const NO_PR: Partial<Record<JobOutcome, string>> = {
  APPROVAL_DENIED: "The run finished without a pull request: the push was denied.",
  COMPLETED_NO_CHANGES: "The run finished without a pull request: it made no changes.",
};
const runError = (status: JobStatus, outcome: JobOutcome | null) =>
  (status === "COMPLETED" && outcome && NO_PR[outcome]) ||
  `The run ended ${words(status)}${outcome ? ` (${words(outcome)})` : ""}.`;

type Finish = { status: "SUCCEEDED" | "FAILED"; artifact: StepArtifact | null; error: string | null };
const failed = (error: string): Finish => ({ status: "FAILED", artifact: null, error });

export type PlanExecutor = ReturnType<typeof createPlanExecutor>;

export function createPlanExecutor(
  deps: Pick<Deps, "db" | "github" | "research" | "config" | "deepDives">,
  log: FastifyBaseLogger,
) {
  const { db } = deps;
  let busy = false; // ticks overlap when one is slow; the plan row lock keeps them correct, this keeps them cheap

  const lockPlan = async (tx: Tx, id: string) => {
    const [p] = await tx.select().from(plans).where(eq(plans.id, id)).for("update");
    const steps = await tx
      .select()
      .from(planSteps)
      .where(eq(planSteps.planId, id))
      .orderBy(asc(planSteps.index))
      .for("update");
    return { plan: p!, steps };
  };

  /** Dependents of failed steps are skipped; once nothing can run, the plan finishes and notifies once. */
  async function evaluate(tx: Tx, plan: PlanRow, steps: StepRow[]) {
    const now = new Date();
    const status = new Map(steps.map((s) => [s.index, s.status]));
    for (const s of steps)
      if (s.status === "PENDING" && s.dependsOn.some((d) => FAILED_DEP.has(status.get(d)!))) {
        status.set(s.index, "SKIPPED");
        await tx.update(planSteps).set({ status: "SKIPPED", finishedAt: now }).where(eq(planSteps.id, s.id));
      }
    if (plan.status !== "APPROVED" && plan.status !== "RUNNING") return; // cancelled: running steps only settle
    const left = [...status.values()];
    if (left.some((s) => s === "PENDING" || s === "RUNNING")) return;
    const done = left.every((s) => s === "SUCCEEDED");
    await tx
      .update(plans)
      .set({ status: done ? "COMPLETED" : "FAILED", finishedAt: now })
      .where(eq(plans.id, plan.id));
    const succeeded = left.filter((s) => s === "SUCCEEDED").length;
    const first = steps.find((s) => status.get(s.index) === "FAILED");
    const skipped = left.filter((s) => s === "SKIPPED").length;
    await notifyPlan(tx, {
      ownerId: plan.ownerId,
      projectId: plan.projectId,
      planId: plan.id,
      done,
      title: `${done ? "Plan completed" : "Plan failed"} · ${clip(plan.goal.replace(/\s+/g, " "), 120)}`,
      // Built from step states and server-written errors only, never from step titles or agent output.
      body: done
        ? `All ${left.length} steps succeeded, each verified from its source record. Open the plan for the evidence.`
        : `${succeeded} of ${left.length} steps succeeded.${first ? ` Step ${first.index + 1} failed: ${first.error ?? "see the plan"}` : ""}${skipped ? ` ${skipped} dependent ${skipped === 1 ? "step was" : "steps were"} skipped.` : ""}`,
    });
    await audit(tx, {
      actor: ACTOR,
      action: done ? "plan.complete" : "plan.fail",
      resourceType: "plan",
      resourceId: plan.id,
      correlationId: plan.id,
      outcome: done ? "SUCCEEDED" : "FAILED",
      metadata: { workspaceId: plan.workspaceId, projectId: plan.projectId, succeeded, steps: left.length },
    });
  }

  async function finish(planId: string, index: number, f: Finish) {
    await db.transaction(async (tx) => {
      const { plan, steps } = await lockPlan(tx, planId);
      const step = steps.find((s) => s.index === index);
      if (step?.status !== "RUNNING") return; // already settled
      Object.assign(step, { status: f.status, error: f.error }); // the notification below cites this error
      await tx
        .update(planSteps)
        .set({ ...f, finishedAt: new Date() })
        .where(eq(planSteps.id, step.id));
      await audit(tx, {
        actor: ACTOR,
        action: `plan.step.${f.status === "SUCCEEDED" ? "succeed" : "fail"}`,
        resourceType: "plan",
        resourceId: plan.id,
        correlationId: plan.id,
        outcome: f.status,
        metadata: { workspaceId: plan.workspaceId, projectId: plan.projectId, index, agent: step.agent },
      });
      await evaluate(tx, plan, steps);
    });
  }

  /** Records the source a running step waits on; a plan cancelled meanwhile gets its new job or dive cancelled. */
  async function recordSource(
    plan: PlanRow,
    index: number,
    set: { jobId: string } | { researchRunId: string } | { deepDiveId: string },
  ) {
    const cancelled = await db.transaction(async (tx) => {
      const { plan: current } = await lockPlan(tx, plan.id);
      await tx
        .update(planSteps)
        .set(set)
        .where(
          and(eq(planSteps.planId, plan.id), eq(planSteps.index, index), eq(planSteps.status, "RUNNING")),
        );
      return current.status === "CANCELLED";
    });
    const settled = (err: unknown) => {
      if (!(err instanceof HttpError)) throw err;
    };
    if (cancelled && "jobId" in set)
      await cancelJob(db, { ownerId: plan.ownerId, jobId: set.jobId, correlationId: plan.id }).catch(settled);
    if (cancelled && "deepDiveId" in set)
      await deps.deepDives
        .cancel({ ownerId: plan.ownerId, actor: ACTOR, correlationId: plan.id }, set.deepDiveId)
        .catch(settled);
  }

  /** Runs the claimed step's typed path. Safe to repeat: every path is idempotent per `plan:<id>:<index>`. */
  async function act(plan: PlanRow, step: StepRow) {
    const key = `plan:${plan.id}:${step.index}`;
    const a = step.action;
    try {
      if (a.type === "jobs.create") {
        const job = await createJob(db, {
          ownerId: plan.ownerId,
          idempotencyKey: key,
          body: a.request,
          agent: step.agent,
          correlationId: plan.id,
          timezone: deps.config.ownerTimezone,
          pinIssue: (b) =>
            requireGithub(deps.github).issueSnapshot(b.repositoryId, b.issueNumber, b.baseBranch),
        });
        await recordSource(plan, step.index, { jobId: job.id });
      } else if (a.type === "research.run") {
        if ((await getWatchlist(db, plan.ownerId, a.watchlistId)).projectId !== plan.projectId)
          return finish(plan.id, step.index, failed("The watchlist isn't in this plan's project."));
        await assertNotStopped(db);
        const run = await createManualRun(
          db,
          { ownerId: plan.ownerId, actor: ACTOR, correlationId: plan.id },
          a.watchlistId,
          key,
        );
        if (run.status === "RUNNING") deps.research.start(run.id); // ignored when it is already executing
        await recordSource(plan, step.index, { researchRunId: run.id });
      } else if (a.type === "research.deep_dive") {
        // The deep-dive path checks the stop, the researcher's profile and reserves the cap against today's budget.
        const { deepDive } = await deps.deepDives.create(
          { ownerId: plan.ownerId, actor: ACTOR, correlationId: plan.id },
          { ...a.request, projectId: plan.projectId },
          key,
        );
        await recordSource(plan, step.index, { deepDiveId: deepDive.id });
      } else {
        const res = await getSalesSummary(
          {
            db,
            connectorsDir: deps.config.connectorsDir,
            actor: ACTOR,
            correlationId: plan.id,
            ownerId: plan.ownerId,
            projectId: plan.projectId,
          },
          { connectorId: a.connectorId, day: a.day, compare: false },
        );
        const c = res.current;
        if (c.status === "UNAVAILABLE")
          return finish(plan.id, step.index, failed(`${c.reason}: ${c.message}`));
        const p = c.provenance;
        const id = `${p.connectorId}:${p.dataset}:${p.from}`;
        await finish(plan.id, step.index, {
          status: "SUCCEEDED",
          error: null,
          artifact: {
            kind: "metric",
            id,
            evidence: [
              {
                kind: "METRIC",
                id,
                label: `${p.connectorName} · ${p.dataset} · sales summary`,
                asOf: p.queriedAt,
              },
            ],
            verifiedAt: new Date().toISOString(),
          },
        });
      }
    } catch (err) {
      // A refusal of the typed path (budget, stop, archived project, GitHub) fails the step; anything else is
      // retried by the next tick from the same claim.
      if (!(err instanceof HttpError)) throw err;
      await finish(plan.id, step.index, failed(err.message));
    }
  }

  /** Reads the step's source record; only its terminal state settles the step. */
  async function settle(plan: PlanRow, step: StepRow) {
    const verifiedAt = new Date().toISOString();
    if (step.jobId) {
      const [job] = await db.select().from(jobs).where(eq(jobs.id, step.jobId));
      if (!job || !isTerminal(job.status)) return;
      const [event] = await db
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.jobId, job.id), eq(runEvents.type, "job.state.changed")))
        .orderBy(desc(runEvents.sequence))
        .limit(1);
      const evidence: SourceRef[] = [
        {
          kind: "JOB",
          id: job.id,
          label: `run ${short(job.id)} · ${words(job.status)}`,
          asOf: job.updatedAt.toISOString(),
        },
      ];
      if (event)
        evidence.push({
          kind: "RUN_EVENT",
          id: event.id,
          label: `job.state.changed → ${words(job.status)}`,
          asOf: event.occurredAt.toISOString(),
        });
      // A run succeeds only with its job type's success outcome: COMPLETED alone also covers a denied push or a run
      // without changes, which opened no PR.
      const ok = job.status === "COMPLETED" && job.outcome === SUCCESS_OUTCOME[job.jobType];
      return finish(plan.id, step.index, {
        status: ok ? "SUCCEEDED" : "FAILED",
        artifact: { kind: "job", id: job.id, evidence, verifiedAt },
        error: ok ? null : runError(job.status, job.outcome),
      });
    }
    if (step.deepDiveId) {
      // "Done" comes from the dive's own status; QUEUED/RUNNING waits, a restart-failed dive fails the step.
      const dive = await deps.deepDives.get(plan.ownerId, step.deepDiveId).catch((err: unknown) => {
        if (err instanceof HttpError && err.statusCode === 404) return null;
        throw err;
      });
      if (!dive) return finish(plan.id, step.index, failed("The step's deep dive can't be found any more."));
      if (dive.status === "QUEUED" || dive.status === "RUNNING") return;
      const ok = dive.status === "COMPLETED" && dive.report !== null;
      const claims = dive.report?.claims ?? [];
      const verified = claims.filter((c) => c.evidence.some((e) => e.verified)).length;
      return finish(plan.id, step.index, {
        status: ok ? "SUCCEEDED" : "FAILED",
        artifact: {
          kind: "deep_dive",
          id: dive.id,
          evidence: [
            {
              kind: "DEEP_DIVE",
              id: dive.id,
              label: ok
                ? `deep dive · completed · ${claims.length} ${claims.length === 1 ? "claim" : "claims"}, ${verified} with verified evidence`
                : `deep dive · ${words(dive.status)}`,
              asOf: dive.finishedAt ?? dive.createdAt,
            },
          ],
          verifiedAt,
        },
        error: ok ? null : (dive.error ?? `The deep dive ended ${words(dive.status)}.`),
      });
    }
    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, step.researchRunId!));
    if (!run || run.status === "RUNNING") return;
    const ok = run.status === "COMPLETED" || run.status === "PARTIAL";
    return finish(plan.id, step.index, {
      status: ok ? "SUCCEEDED" : "FAILED",
      artifact: {
        kind: "research_run",
        id: run.id,
        evidence: [
          {
            kind: "RESEARCH_RUN",
            id: run.id,
            label: `brief · ${words(run.status)} · ${run.newFindings} new ${run.newFindings === 1 ? "finding" : "findings"}`,
            asOf: (run.finishedAt ?? run.startedAt).toISOString(),
          },
        ],
        verifiedAt,
      },
      error: ok ? null : (run.error ?? "The research run failed."),
    });
  }

  /** A cancelled plan's claimed step that never recorded its source: adopt a source a crash left, else stop it. */
  async function abandon(plan: PlanRow, step: StepRow) {
    const key = `plan:${plan.id}:${step.index}`;
    const [job] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.initiatorId, plan.ownerId), eq(jobs.idempotencyKey, key)));
    if (job) return recordSource(plan, step.index, { jobId: job.id }); // cancels it; the step settles from it
    const [run] = await db
      .select({ id: researchRuns.id })
      .from(researchRuns)
      .where(eq(researchRuns.idempotencyKey, key));
    if (run) return recordSource(plan, step.index, { researchRunId: run.id });
    // shortcut: the deep-dive service has no lookup by idempotency key, so a dive created just before a crash on a
    // cancelled plan isn't adopted here; it stays bounded by its own limits and can be cancelled in Research.
    await db
      .update(planSteps)
      .set({ status: "CANCELLED", finishedAt: new Date() })
      .where(and(eq(planSteps.id, step.id), eq(planSteps.status, "RUNNING")));
  }

  /** Claims the next runnable step, after re-checking the stop and the agent's current profile. */
  async function startNext(planId: string) {
    const claimed = await db.transaction(async (tx) => {
      const { plan, steps } = await lockPlan(tx, planId);
      if (
        (plan.status !== "APPROVED" && plan.status !== "RUNNING") ||
        steps.some((s) => s.status === "RUNNING")
      )
        return null;
      const next = steps.find((s) => s.status === "PENDING");
      if (!next) {
        await evaluate(tx, plan, steps);
        return null;
      }
      // Settings never expand an approved plan: they can only stop a step that is no longer allowed. An issue NEXUS
      // took up since the plan was drafted (another run, or a pull request) isn't worked on twice.
      const reason = (await emergencyStopEngaged(tx))
        ? "Emergency stop is engaged: the step didn't start."
        : (profileBlock(
            await resolveAgentProfile(db, plan.ownerId, plan.projectId, next.agent),
            next.action,
          ) ?? (await issueBusy(tx, plan.ownerId, next.action)));
      const now = new Date();
      if (reason) {
        const error = reason.endsWith(".") ? reason : `${reason}: the step didn't start.`;
        await tx
          .update(planSteps)
          .set({ status: "FAILED", error, finishedAt: now })
          .where(eq(planSteps.id, next.id));
        next.status = "FAILED";
        next.error = error;
        await audit(tx, {
          actor: ACTOR,
          action: "plan.step.blocked",
          resourceType: "plan",
          resourceId: plan.id,
          correlationId: plan.id,
          outcome: "DENIED",
          metadata: {
            workspaceId: plan.workspaceId,
            projectId: plan.projectId,
            index: next.index,
            agent: next.agent,
          },
        });
        await evaluate(tx, plan, steps);
        return null;
      }
      await tx.update(planSteps).set({ status: "RUNNING", startedAt: now }).where(eq(planSteps.id, next.id));
      if (plan.status === "APPROVED")
        await tx.update(plans).set({ status: "RUNNING" }).where(eq(plans.id, plan.id));
      await audit(tx, {
        actor: ACTOR,
        action: "plan.step.start",
        resourceType: "plan",
        resourceId: plan.id,
        correlationId: plan.id,
        metadata: {
          workspaceId: plan.workspaceId,
          projectId: plan.projectId,
          index: next.index,
          agent: next.agent,
          label: AGENT_LABEL[next.agent],
          action: next.action.type,
        },
      });
      return { plan, step: next };
    });
    if (claimed) await act(claimed.plan, claimed.step);
  }

  const guard = (planId: string, fn: () => Promise<unknown>) =>
    fn().catch((err: unknown) => log.error({ err, planId }, "plan executor step failed; retried next tick"));

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const running = await db
        .select({ step: planSteps, plan: plans })
        .from(planSteps)
        .innerJoin(plans, eq(plans.id, planSteps.planId))
        .where(eq(planSteps.status, "RUNNING"));
      for (const { step, plan } of running)
        await guard(plan.id, () =>
          step.jobId || step.researchRunId || step.deepDiveId
            ? settle(plan, step)
            : plan.status === "CANCELLED"
              ? abandon(plan, step)
              : act(plan, step),
        );
      // An archived project's plans wait; they resume when it is unarchived.
      const active = await db
        .select({ id: plans.id })
        .from(plans)
        .innerJoin(projects, eq(projects.id, plans.projectId))
        .where(and(inArray(plans.status, ["APPROVED", "RUNNING"]), isNull(projects.archivedAt)))
        .orderBy(asc(plans.id));
      for (const { id } of active) await guard(id, () => startNext(id));
    } finally {
      busy = false;
    }
  }

  return { tick };
}
