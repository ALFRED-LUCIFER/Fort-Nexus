import { and, count, desc, eq, gte, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import {
  AgentKey,
  JOB_STATUS_GROUPS,
  JobTests,
  type AgentPerformance,
  type AgentPerformanceQuery,
  type AgentPerformanceRow,
  type JobHistoryList,
  type JobHistoryQuery,
  type JobStatusGroup,
} from "@nexus/contracts";
import type { Db } from "./db/index.ts";
import { aiSpend, approvals, jobs, runEvents, workspaces, type AiSpendSource } from "./db/schema.ts";
import { HttpError } from "./errors.ts";
import { toJobDto } from "./jobs.ts";
import { localDate } from "./research/schedule.ts";
import { resolveProject } from "./workspaces.ts";

// Jobs wave A: the Jobs page and agent performance, from NEXUS's own records only (FR-OBS-03/04, §D.4).

const SPEND_AGENT: Record<AiSpendSource, AgentKey> = { DEEP_DIVE: "AI_RESEARCHER", JOB_DRAFT: "DEVELOPER" };
const micros = (n: number) => Math.round(n * 1e6);

/** Start of local day `date` in `tz`, as an instant. */
const localMidnight = (date: string, tz: string, plusDays = 0) =>
  sql`((${date}::date + ${plusDays}::int)::timestamp at time zone ${tz}::text)`;
const inGroup = (g: JobStatusGroup) => inArray(jobs.status, [...JOB_STATUS_GROUPS[g]]);
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Jobs of the owner, in one of their projects (404 for any other) or all of them. */
async function jobScope(db: Db, ownerId: string, projectId: string | undefined) {
  if (projectId) await resolveProject(db, ownerId, projectId);
  return and(eq(jobs.initiatorId, ownerId), projectId ? eq(jobs.projectId, projectId) : undefined);
}

export async function jobHistory(
  db: Db,
  ownerId: string,
  timezone: string,
  q: JobHistoryQuery,
): Promise<JobHistoryList> {
  if (q.from && q.to && q.from > q.to)
    throw new HttpError(400, "VALIDATION_FAILED", "from must be on or before to", { field: "from" });
  const scope = await jobScope(db, ownerId, q.projectId);

  const latest = db
    .select({
      id: approvals.id,
      status: approvals.status,
      tests: sql<string | null>`${approvals.action}->'verification'->>'status'`.as("approval_tests"),
    })
    .from(approvals)
    .where(eq(approvals.jobId, jobs.id))
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(1)
    .as("latest_approval");
  const executed = db
    .select({ result: approvals.result })
    .from(approvals)
    .where(and(eq(approvals.jobId, jobs.id), eq(approvals.status, "EXECUTED"), isNotNull(approvals.result)))
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(1)
    .as("executed_approval");
  // The runner's own verification event (its payload is the Verification it ran), for jobs without an approval yet.
  const tested = db
    .select({ status: sql<string | null>`${runEvents.payload}->>'status'`.as("event_tests") })
    .from(runEvents)
    .where(and(eq(runEvents.jobId, jobs.id), eq(runEvents.type, "test.completed")))
    .orderBy(desc(runEvents.sequence))
    .limit(1)
    .as("test_event");

  const rows = await db
    .select({
      job: jobs,
      approvalId: latest.id,
      approvalStatus: latest.status,
      approvalTests: latest.tests,
      eventTests: tested.status,
      pr: executed.result,
    })
    .from(jobs)
    .leftJoinLateral(latest, sql`true`)
    .leftJoinLateral(executed, sql`true`)
    .leftJoinLateral(tested, sql`true`)
    .where(
      and(
        scope,
        q.repositoryId ? sql`${jobs.issueSnapshot}->>'repositoryId' = ${q.repositoryId}` : undefined,
        q.agent ? eq(jobs.agent, q.agent) : undefined,
        q.status ? inGroup(q.status) : undefined,
        q.from ? gte(jobs.createdAt, localMidnight(q.from, timezone)) : undefined,
        q.to ? lt(jobs.createdAt, localMidnight(q.to, timezone, 1)) : undefined,
        q.cursor ? lt(jobs.id, q.cursor) : undefined,
      ),
    )
    .orderBy(desc(jobs.id))
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit);
  return {
    items: page.map((r) => {
      const { startedAt, finishedAt, issueSnapshot } = r.job;
      return {
        job: toJobDto(r.job),
        repositoryId: issueSnapshot?.repositoryId ?? null,
        repositoryFullName: issueSnapshot?.fullName ?? null,
        // Clamped: backfilled times come from runner-reported event clocks.
        durationMs: startedAt && finishedAt ? Math.max(0, finishedAt.getTime() - startedAt.getTime()) : null,
        tests: JobTests.safeParse(r.approvalId ? r.approvalTests : r.eventTests).data ?? null,
        pullRequest: r.pr ? { number: r.pr.pullRequestNumber, url: r.pr.pullRequestUrl } : null,
        approval: r.approvalId && r.approvalStatus ? { id: r.approvalId, status: r.approvalStatus } : null,
      };
    }),
    nextCursor: rows.length > q.limit ? page[page.length - 1]!.job.id : null,
  };
}

export async function agentPerformance(
  db: Db,
  ownerId: string,
  timezone: string,
  q: AgentPerformanceQuery,
  now = new Date(),
): Promise<AgentPerformance> {
  const scope = await jobScope(db, ownerId, q.projectId);
  const to = localDate(now, timezone);
  const from = addDays(to, 1 - q.days);
  const start = localMidnight(from, timezone);
  const end = localMidnight(to, timezone, 1);

  const ap = db
    .select({
      prs: sql<number>`count(*) filter (where ${approvals.status} = 'EXECUTED' and ${approvals.result} is not null)`.as(
        "prs",
      ),
      approved:
        sql<number>`count(*) filter (where ${inArray(approvals.status, ["APPROVED", "EXECUTED", "FAILED"])})`.as(
          "approved",
        ),
      denied: sql<number>`count(*) filter (where ${approvals.status} = 'DENIED')`.as("denied"),
      expired: sql<number>`count(*) filter (where ${approvals.status} = 'EXPIRED')`.as("expired"),
      pending: sql<number>`count(*) filter (where ${approvals.status} = 'PENDING')`.as("pending"),
      firstAt: sql<Date | null>`min(${approvals.createdAt})`.as("first_at"),
    })
    .from(approvals)
    .where(eq(approvals.jobId, jobs.id))
    .as("ap");
  const filtered = (g: JobStatusGroup) => sql`count(*) filter (where ${inGroup(g)})`.mapWith(Number);
  const total = (c: SQL.Aliased<number>) => sql`coalesce(sum(${c}), 0)`.mapWith(Number);

  const [jobRows, spendRows] = await Promise.all([
    db
      .select({
        agent: jobs.agent,
        jobs: count(),
        succeeded: filtered("SUCCEEDED"),
        failed: filtered("FAILED"),
        cancelled: filtered("CANCELLED"),
        costUsd: sql`coalesce(sum(${jobs.estimatedCostUsd}), 0)`.mapWith(Number),
        pullRequests: total(ap.prs),
        approved: total(ap.approved),
        denied: total(ap.denied),
        expired: total(ap.expired),
        pending: total(ap.pending),
        medianMinutes:
          sql`percentile_cont(0.5) within group (order by extract(epoch from ${ap.firstAt} - ${jobs.createdAt}) / 60)`.mapWith(
            Number,
          ),
      })
      .from(jobs)
      .leftJoinLateral(ap, sql`true`)
      .where(and(scope, gte(jobs.createdAt, start), lt(jobs.createdAt, end)))
      .groupBy(jobs.agent),
    db
      .select({
        source: aiSpend.source,
        usd: sql`coalesce(sum(coalesce(${aiSpend.costUsd}, ${aiSpend.reservedUsd})), 0)`.mapWith(Number),
      })
      .from(aiSpend)
      .where(
        and(
          q.projectId
            ? eq(aiSpend.projectId, q.projectId)
            : inArray(
                aiSpend.workspaceId,
                db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.ownerId, ownerId)),
              ),
          gte(aiSpend.createdAt, start),
          lt(aiSpend.createdAt, end),
        ),
      )
      .groupBy(aiSpend.source),
  ]);

  const spend = new Map<AgentKey, number>();
  for (const s of spendRows) {
    const agent = SPEND_AGENT[s.source];
    spend.set(agent, (spend.get(agent) ?? 0) + micros(s.usd));
  }
  const items = AgentKey.options.map((agent): AgentPerformanceRow => {
    const r = jobRows.find((x) => x.agent === agent);
    const succeeded = r?.succeeded ?? 0;
    const failed = r?.failed ?? 0;
    const pullRequests = r?.pullRequests ?? 0;
    const costUsd = (micros(r?.costUsd ?? 0) + (spend.get(agent) ?? 0)) / 1e6;
    return {
      agent,
      jobs: r?.jobs ?? 0,
      succeeded,
      failed,
      cancelled: r?.cancelled ?? 0,
      successRate: succeeded + failed === 0 ? null : succeeded / (succeeded + failed),
      pullRequests,
      costUsd,
      costPerPullRequestUsd: pullRequests === 0 ? null : micros(costUsd / pullRequests) / 1e6,
      medianMinutesToReviewReady: r?.medianMinutes ?? null,
      approvals: {
        approved: r?.approved ?? 0,
        denied: r?.denied ?? 0,
        expired: r?.expired ?? 0,
        pending: r?.pending ?? 0,
      },
    };
  });
  return { days: q.days as 7 | 30, from, to, items, asOf: now.toISOString() };
}
