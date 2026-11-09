import { and, desc, eq, gt, gte, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { unionAll, type AnyPgColumn } from "drizzle-orm/pg-core";
import {
  AgentKey,
  JOB_STATUS_GROUPS,
  JobTests,
  type HomeAgentActivity,
  type HomeDecisions,
  type HomeExecution,
  type HomeHeadline,
  type HomeKpi,
  type HomeQuery,
  type HomeRef,
  type HomeResult,
  type HomeSummary,
  type JobStatus,
  type RunStage,
} from "@nexus/contracts";
import type { Db } from "./db/index.ts";
import { aiSpend, approvals, jobs, runEvents, user, type AiSpendSource } from "./db/schema.ts";
import { notBaselineRun } from "./jobs.ts";
import { jobDrafts } from "./job-drafts/schema.ts";
import { incidents } from "./monitoring/schema.ts";
import { planSteps, plans } from "./plans/schema.ts";
import { researchDeepDives } from "./research/deep/schema.ts";
import { researchOpportunities } from "./research/opportunities/schema.ts";
import { localDate } from "./research/schedule.ts";
import { ownerWorkspaceIds, resolveProject } from "./workspaces.ts";

// Cofounder home (PRD §D.4): the owner's day from NEXUS's own records only. No model text: the headline is built here
// from counts, so it is true, free and works without ai.json.

const DAYS = 7;
const MAX_EXECUTION = 8;
const MAX_TOP = 5;
const ACTIVE: readonly JobStatus[] = JOB_STATUS_GROUPS.ACTIVE;
const NEEDS_YOU: readonly JobStatus[] = JOB_STATUS_GROUPS.NEEDS_YOU;
const SPEND_AGENT: Record<AiSpendSource, AgentKey> = {
  DEEP_DIVE: "AI_RESEARCHER",
  JOB_DRAFT: "DEVELOPER",
  EXPLAIN: "AI_RESEARCHER",
  TRIAGE: "DEVOPS",
  TALK: "CHIEF_OF_STAFF",
  PLAN_DRAFT: "CHIEF_OF_STAFF",
};
const STATUS_WORD: Partial<Record<JobStatus, string>> = {
  DRAFT: "draft",
  VALIDATING: "validating",
  QUEUED: "queued",
  PREPARING: "preparing",
  RUNNING: "running",
  VERIFYING: "verifying",
  AWAITING_APPROVAL: "waiting for your approval",
  BLOCKED: "blocked",
  BLOCKED_NEEDS_INFO: "needs info",
  RECOVERY_REQUIRED: "needs recovery",
};

const micros = (n: number) => Math.round(n * 1e6);
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Start of local day `date` in `tz`, as an instant (as job-history.ts). */
const localMidnight = (date: string, tz: string, plusDays = 0) =>
  sql`((${date}::date + ${plusDays}::int)::timestamp at time zone ${tz}::text)`;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = xs.toSorted((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
const ratio = (passed: number, failed: number) => (passed + failed === 0 ? null : passed / (passed + failed));

type Scoped = { workspaceId: AnyPgColumn; projectId: AnyPgColumn };

/** One project of the owner (404 for any other) or all of theirs; never another owner's records. */
async function homeScope(db: Db, ownerId: string, projectId: string | undefined) {
  if (projectId) {
    const s = await resolveProject(db, ownerId, projectId);
    return {
      jobs: and(eq(jobs.initiatorId, ownerId), eq(jobs.projectId, s.projectId))!,
      of: (t: Scoped) => and(eq(t.workspaceId, s.workspaceId), eq(t.projectId, s.projectId))!,
    };
  }
  const ws = await ownerWorkspaceIds(db, ownerId);
  return { jobs: eq(jobs.initiatorId, ownerId), of: (t: Scoped) => inArray(t.workspaceId, ws) };
}

const jobTitle = (j: { issueNumber: number | null; issueTitle: string | null; preset: string | null }) =>
  j.issueNumber !== null
    ? `#${j.issueNumber} ${j.issueTitle ?? ""}`.trimEnd()
    : `Runner diagnostic${j.preset ? ` · ${j.preset}` : ""}`;

type HomeScope = Awaited<ReturnType<typeof homeScope>>;

/**
 * What waits on the owner (HomeDecisions): one set of predicates for the counts and the most urgent items, shared by
 * GET /v1/home and Talk's "what's waiting on me" so the two never disagree.
 */
function decisionSources(db: Db, ownerId: string, scope: HomeScope, now: Date) {
  const scopedJobIds = db.select({ id: jobs.id }).from(jobs).where(scope.jobs);
  const pendingApproval = and(
    eq(approvals.status, "PENDING"),
    gt(approvals.expiresAt, now),
    inArray(approvals.jobId, scopedJobIds),
  )!;
  const pendingPlan = and(
    scope.of(plans),
    eq(plans.ownerId, ownerId),
    eq(plans.status, "DRAFT"),
    isNotNull(plans.planHash),
  );
  const pendingDraft = and(
    scope.of(jobDrafts),
    eq(jobDrafts.ownerId, ownerId),
    inArray(jobDrafts.status, ["READY", "NEEDS_REPO"]),
  );
  const openOpportunity = and(scope.of(researchOpportunities), eq(researchOpportunities.status, "OPEN"));
  const openIncident = and(scope.of(incidents), eq(incidents.status, "OPEN"));
  const at = (c: AnyPgColumn) => sql<Date>`${c}`.mapWith(c).as("created_at");
  const noNumber = sql<number | null>`null::int`.as("number");
  const noExpiry = sql<Date | null>`null::timestamptz`.mapWith(approvals.expiresAt).as("expires_at");
  const notPlan = sql<number | null>`null::int`.as("uncovered");
  const kind = (k: HomeRef["kind"]) => sql<HomeRef["kind"]>`${k}::text`.as("kind");
  // Open incidents sort before everything else (the union can only order by result columns).
  const urgency = (k: HomeRef["kind"]) => sql<number>`${k === "INCIDENT" ? 1 : 0}::int`.as("urgency");

  return {
    where: { pendingApproval },
    counts: {
      approvals: db.$count(approvals, pendingApproval),
      plans: db.$count(plans, pendingPlan),
      jobDrafts: db.$count(jobDrafts, pendingDraft),
      opportunities: db.$count(researchOpportunities, openOpportunity),
      incidents: db.$count(incidents, openIncident),
    },
    top: (limit: number) =>
      unionAll(
        // An open incident is the most urgent: it sorts before everything else.
        db
          .select({
            kind: kind("INCIDENT"),
            urgency: urgency("INCIDENT"),
            id: sql<string>`${incidents.id}`.as("id"),
            title: sql<string>`${incidents.severity} || ' · ' || ${incidents.title}`.as("title"),
            number: noNumber,
            expiresAt: noExpiry,
            uncovered: notPlan,
            createdAt: at(incidents.openedAt),
          })
          .from(incidents)
          .where(openIncident),
        // A push approval opens through its run.
        db
          .select({
            kind: kind("JOB"),
            urgency: urgency("JOB"),
            id: sql<string>`${approvals.jobId}`.as("id"),
            title: sql<string>`${approvals.action}->>'title'`.as("title"),
            number: sql<number | null>`(${approvals.action}->>'issueNumber')::int`.as("number"),
            expiresAt: sql<Date | null>`${approvals.expiresAt}`.mapWith(approvals.expiresAt).as("expires_at"),
            uncovered: notPlan,
            createdAt: at(approvals.createdAt),
          })
          .from(approvals)
          .where(pendingApproval),
        db
          .select({
            kind: kind("PLAN"),
            urgency: urgency("PLAN"),
            id: sql<string>`${plans.id}`.as("id"),
            title: sql<string>`${plans.goal}`.as("title"),
            number: noNumber,
            expiresAt: noExpiry,
            // A plan without steps can't be approved: what waits is starting its gaps as new jobs. Spelled out
            // (Drizzle leaves columns unqualified in a select's sql, which a correlated subquery would capture).
            uncovered: sql<number | null>`case
              when jsonb_array_length(${plans.gaps}) > 0
                and not exists (select 1 from plan_steps ps where ps.plan_id = plans.id)
              then jsonb_array_length(${plans.gaps}) end`.as("uncovered"),
            createdAt: at(plans.createdAt),
          })
          .from(plans)
          .where(pendingPlan),
        db
          .select({
            kind: kind("JOB_DRAFT"),
            urgency: urgency("JOB_DRAFT"),
            id: sql<string>`${jobDrafts.id}`.as("id"),
            title: sql<string>`coalesce(${jobDrafts.issueTitle}, ${jobDrafts.text})`.as("title"),
            number: sql<number | null>`${jobDrafts.issueNumber}`.as("number"),
            expiresAt: noExpiry,
            uncovered: notPlan,
            createdAt: at(jobDrafts.createdAt),
          })
          .from(jobDrafts)
          .where(pendingDraft),
        db
          .select({
            kind: kind("OPPORTUNITY"),
            urgency: urgency("OPPORTUNITY"),
            id: sql<string>`${researchOpportunities.id}`.as("id"),
            title: sql<string>`${researchOpportunities.title}`.as("title"),
            number: noNumber,
            expiresAt: noExpiry,
            uncovered: notPlan,
            createdAt: at(researchOpportunities.createdAt),
          })
          .from(researchOpportunities)
          .where(openOpportunity),
      )
        .orderBy(sql`urgency desc`, sql`created_at desc`, sql`id desc`)
        .limit(limit),
  };
}

type DecisionRow = Awaited<ReturnType<ReturnType<typeof decisionSources>["top"]>>[number];

export type DecisionItem = {
  ref: HomeRef;
  title: string;
  expiresAt: string | null;
  createdAt: string;
  // A plan with no steps, only gaps: how many parts wait to be started as new jobs (it can't be approved).
  // null for everything else.
  uncovered: number | null;
};

/** What a plan without steps asks of the owner, after its goal on Home and in Talk. */
export const uncoveredAsk = (n: number) =>
  `${n} not covered — start ${n === 1 ? "it" : "them"} as ${n === 1 ? "a new job" : "new jobs"}`;

/**
 * A push approval's title is the PR title, which already starts with "#N: " (issue-to-pr.ts), so the number is
 * shown once: "#N <title>".
 */
function decisionItem(r: DecisionRow): DecisionItem {
  const title =
    r.number === null ? r.title : `#${r.number} ${r.title.replace(new RegExp(`^#${r.number}:?\\s+`), "")}`;
  return {
    ref: { kind: r.kind, id: r.id },
    title: cut(title, 300),
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: (r.createdAt as Date).toISOString(), // mapped by the timestamp column it reads
    uncovered: r.kind === "PLAN" ? r.uncovered : null,
  };
}

/** What waits on the owner in one project: the same counts and order as Home's "Waiting on you". */
export async function waitingOnYou(
  db: Db,
  ownerId: string,
  projectId: string,
  limit: number,
  now = new Date(),
): Promise<{ counts: Omit<HomeDecisions, "top">; items: DecisionItem[] }> {
  const d = decisionSources(db, ownerId, await homeScope(db, ownerId, projectId), now);
  const [rows, [counts]] = await Promise.all([
    d.top(limit),
    db.select(d.counts).from(user).where(eq(user.id, ownerId)),
  ]);
  return {
    counts: counts ?? { approvals: 0, plans: 0, jobDrafts: 0, opportunities: 0, incidents: 0 },
    items: rows.map(decisionItem),
  };
}

export async function homeSummary(
  db: Db,
  ownerId: string,
  tz: string,
  q: HomeQuery,
  now = new Date(),
): Promise<HomeSummary> {
  const scope = await homeScope(db, ownerId, q.projectId);
  const today = localDate(now, tz);
  const weekFrom = addDays(today, 1 - DAYS);
  const prevFrom = addDays(weekFrom, -DAYS);
  const weekStart = localMidnight(weekFrom, tz);
  const todayStart = localMidnight(today, tz);
  const end = localMidnight(today, tz, 1);
  const scopedJobIds = db.select({ id: jobs.id }).from(jobs).where(scope.jobs);
  const inWindow = (c: AnyPgColumn) => and(gte(c, weekStart), lt(c, end));

  // Per job of the last 14 local days: its local day, job → first approval, and the latest NEXUS-run verification
  // (the same rule as job-history.ts: the latest approval's copy when there is one, else the runner's test event).
  const firstApproval = db
    .select({ at: sql`min(${approvals.createdAt})`.as("first_at") })
    .from(approvals)
    .where(eq(approvals.jobId, jobs.id))
    .as("first_approval");
  const latest = db
    .select({
      id: approvals.id,
      tests: sql<string | null>`${approvals.action}->'verification'->>'status'`.as("approval_tests"),
    })
    .from(approvals)
    .where(eq(approvals.jobId, jobs.id))
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(1)
    .as("latest_approval");
  const tested = db
    .select({ status: sql<string | null>`${runEvents.payload}->>'status'`.as("event_tests") })
    .from(runEvents)
    .where(and(eq(runEvents.jobId, jobs.id), eq(runEvents.type, "test.completed"), notBaselineRun))
    .orderBy(desc(runEvents.sequence))
    .limit(1)
    .as("test_event");

  const stage = db
    .select({ stage: runEvents.stage })
    .from(runEvents)
    .where(and(eq(runEvents.jobId, jobs.id), isNotNull(runEvents.stage)))
    .orderBy(desc(runEvents.sequence))
    .limit(1)
    .as("latest_stage");
  // The 8 newest open jobs for Execution plus each agent's newest working and newest waiting one.
  const open = db
    .select({
      id: jobs.id,
      agent: jobs.agent,
      status: jobs.status,
      createdAt: jobs.createdAt,
      issueNumber: sql<number | null>`(${jobs.issueSnapshot}->>'issueNumber')::int`.as("issue_number"),
      issueTitle: sql<string | null>`${jobs.issueSnapshot}->>'title'`.as("issue_title"),
      preset: sql<string | null>`${jobs.request}->>'preset'`.as("preset"),
      stage: stage.stage,
      rank: sql`row_number() over (order by ${jobs.createdAt} desc, ${jobs.id} desc)`.as("rank"),
      agentRank: sql`row_number() over (partition by ${jobs.agent}, ${inArray(jobs.status, [...NEEDS_YOU])}
        order by ${jobs.createdAt} desc, ${jobs.id} desc)`.as("agent_rank"),
    })
    .from(jobs)
    .leftJoinLateral(stage, sql`true`)
    .where(and(scope.jobs, inArray(jobs.status, [...ACTIVE, ...NEEDS_YOU])))
    .as("open_jobs");

  const d = decisionSources(db, ownerId, scope, now);

  const [jobRows, openRows, [dive], stepRows, topRows, [counts], spendRows] = await Promise.all([
    db
      .select({
        agent: jobs.agent,
        day: sql<string>`to_char(${jobs.createdAt} at time zone ${tz}::text, 'YYYY-MM-DD')`,
        reviewMinutes: sql`extract(epoch from ${firstApproval.at} - ${jobs.createdAt}) / 60`.mapWith(Number),
        tests: sql<
          string | null
        >`case when ${latest.id} is not null then ${latest.tests} else ${tested.status} end`,
        costUsd: jobs.estimatedCostUsd,
      })
      .from(jobs)
      .leftJoinLateral(firstApproval, sql`true`)
      .leftJoinLateral(latest, sql`true`)
      .leftJoinLateral(tested, sql`true`)
      .where(and(scope.jobs, gte(jobs.createdAt, localMidnight(prevFrom, tz)), lt(jobs.createdAt, end))),
    db
      .select()
      .from(open)
      .where(or(lte(open.rank, MAX_EXECUTION), eq(open.agentRank, 1)))
      .orderBy(desc(open.createdAt), desc(open.id)),
    db
      .select({ id: researchDeepDives.id, question: researchDeepDives.question })
      .from(researchDeepDives)
      .where(and(scope.of(researchDeepDives), eq(researchDeepDives.status, "RUNNING")))
      .orderBy(desc(researchDeepDives.id))
      .limit(1),
    db
      .selectDistinctOn([planSteps.agent], {
        agent: planSteps.agent,
        planId: planSteps.planId,
        title: planSteps.title,
      })
      .from(planSteps)
      .innerJoin(plans, eq(plans.id, planSteps.planId))
      .where(and(scope.of(planSteps), eq(plans.ownerId, ownerId), eq(planSteps.status, "RUNNING")))
      .orderBy(planSteps.agent, sql`${planSteps.startedAt} desc nulls last`),
    d.top(MAX_TOP),
    // The owner's own row only carries the scalar counts.
    db
      .select({
        ...d.counts,
        newestPush: sql<number | null>`(select (${approvals.action}->>'issueNumber')::int from ${approvals}
          where ${d.where.pendingApproval} order by ${approvals.createdAt} desc limit 1)`,
        pullRequests: db.$count(
          approvals,
          and(
            eq(approvals.status, "EXECUTED"),
            isNotNull(approvals.result),
            inWindow(approvals.decidedAt),
            inArray(approvals.jobId, scopedJobIds),
          ),
        ),
        // Both rows change only on their own flows after the issue exists, so updated_at is when GitHub confirmed it.
        draftIssues: db.$count(
          jobDrafts,
          and(
            scope.of(jobDrafts),
            eq(jobDrafts.ownerId, ownerId),
            isNotNull(jobDrafts.createdIssueNumber),
            inWindow(jobDrafts.updatedAt),
          ),
        ),
        opportunityIssues: db.$count(
          researchOpportunities,
          and(
            scope.of(researchOpportunities),
            isNotNull(researchOpportunities.issue),
            inWindow(researchOpportunities.updatedAt),
          ),
        ),
        deepDives: db.$count(
          researchDeepDives,
          and(
            scope.of(researchDeepDives),
            eq(researchDeepDives.status, "COMPLETED"),
            inWindow(researchDeepDives.finishedAt),
          ),
        ),
      })
      .from(user)
      .where(eq(user.id, ownerId)),
    db
      .select({
        source: aiSpend.source,
        week: sql`coalesce(sum(coalesce(${aiSpend.costUsd}, ${aiSpend.reservedUsd})), 0)`.mapWith(Number),
        today: sql`coalesce(sum(coalesce(${aiSpend.costUsd}, ${aiSpend.reservedUsd}))
          filter (where ${gte(aiSpend.createdAt, todayStart)}), 0)`.mapWith(Number),
      })
      .from(aiSpend)
      .where(and(scope.of(aiSpend), inWindow(aiSpend.createdAt)))
      .groupBy(aiSpend.source),
  ]);

  // ── KPIs ──
  const days = Array.from({ length: 2 * DAYS }, (_, i) => addDays(prevFrom, i));
  const byDay = new Map(days.map((d) => [d, { runs: 0, review: [] as number[], passed: 0, failed: 0 }]));
  const jobCostToday = new Map<AgentKey, number>();
  let jobSpendWeek = 0;
  for (const r of jobRows) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.runs++;
    if (r.reviewMinutes !== null) d.review.push(Math.max(0, r.reviewMinutes));
    const tests = JobTests.safeParse(r.tests).data;
    if (tests === "passed") d.passed++;
    if (tests === "failed") d.failed++;
    if (r.day >= weekFrom) jobSpendWeek += micros(r.costUsd ?? 0);
    if (r.day === today) jobCostToday.set(r.agent, (jobCostToday.get(r.agent) ?? 0) + micros(r.costUsd ?? 0));
  }
  const week = days.slice(DAYS).map((d) => byDay.get(d)!);
  const prev = days.slice(0, DAYS).map((d) => byDay.get(d)!);
  const sum = (ds: typeof week, f: (d: (typeof week)[number]) => number) => ds.reduce((n, d) => n + f(d), 0);
  const passRate = (ds: typeof week) =>
    ratio(
      sum(ds, (d) => d.passed),
      sum(ds, (d) => d.failed),
    );
  const passedThisWeek = sum(week, (d) => d.passed);

  const decisions: Omit<HomeDecisions, "top"> = {
    approvals: counts?.approvals ?? 0,
    plans: counts?.plans ?? 0,
    jobDrafts: counts?.jobDrafts ?? 0,
    opportunities: counts?.opportunities ?? 0,
    incidents: counts?.incidents ?? 0,
  };
  const waiting =
    decisions.approvals +
    decisions.plans +
    decisions.jobDrafts +
    decisions.opportunities +
    decisions.incidents;

  const kpis: HomeKpi[] = [
    {
      key: "REVIEW_READY_MEDIAN",
      label: "Issue → review-ready",
      value: median(week.flatMap((d) => d.review)),
      unit: "minutes",
      previous: median(prev.flatMap((d) => d.review)),
      better: "DOWN",
      series: week.map((d) => median(d.review)),
      source: "jobs + approvals · 7 days",
    },
    {
      key: "TESTS_PASS_RATE",
      label: "Tests passing",
      value: passRate(week),
      unit: "ratio",
      previous: passRate(prev),
      better: "UP",
      series: week.map((d) => ratio(d.passed, d.failed)),
      source: "NEXUS test runs · 7 days",
    },
    {
      // A day without runs is a real 0, not missing data. Previous = the same weekday last week.
      key: "RUNS_TODAY",
      label: "Runs today",
      value: week.at(-1)!.runs,
      unit: "count",
      previous: prev.at(-1)!.runs,
      better: "UP",
      series: week.map((d) => d.runs),
      source: "jobs · today",
    },
    {
      // Only "now" is honest: job drafts and opportunities keep no status history, so what waited at an earlier
      // day's end can't be rebuilt. Earlier days and the previous window stay null.
      key: "WAITING_ON_YOU",
      label: "Waiting on you",
      value: waiting,
      unit: "count",
      previous: null,
      better: "DOWN",
      series: [...Array<null>(DAYS - 1).fill(null), waiting],
      source: "approvals, plans, drafts, opportunities, incidents · now",
    },
  ];

  // ── Agents and execution ──
  const isWaiting = (s: JobStatus) => NEEDS_YOU.includes(s);
  const doingJob = (j: (typeof openRows)[number]) =>
    cut(
      `${jobTitle(j)} · ${isWaiting(j.status) ? STATUS_WORD[j.status] : (j.stage ?? STATUS_WORD[j.status])}`,
      200,
    );
  const spendToday = new Map<AgentKey, number>();
  for (const s of spendRows)
    spendToday.set(SPEND_AGENT[s.source], (spendToday.get(SPEND_AGENT[s.source]) ?? 0) + micros(s.today));

  const agents = AgentKey.options.map((agent): HomeAgentActivity => {
    const costTodayUsd = ((jobCostToday.get(agent) ?? 0) + (spendToday.get(agent) ?? 0)) / 1e6;
    const mine = openRows.filter((j) => j.agent === agent);
    const working = mine.find((j) => !isWaiting(j.status));
    if (working)
      return {
        agent,
        state: "WORKING",
        doing: doingJob(working),
        ref: { kind: "JOB", id: working.id },
        costTodayUsd,
      };
    if (agent === "AI_RESEARCHER" && dive)
      return {
        agent,
        state: "WORKING",
        doing: `Deep dive · ${cut(dive.question, 80)}`,
        ref: { kind: "DEEP_DIVE", id: dive.id },
        costTodayUsd,
      };
    const step = stepRows.find((s) => s.agent === agent);
    if (step)
      return {
        agent,
        state: "WORKING",
        doing: cut(`Plan step · ${step.title}`, 200),
        ref: { kind: "PLAN", id: step.planId },
        costTodayUsd,
      };
    const waitingJob = mine.find((j) => isWaiting(j.status));
    if (waitingJob)
      return {
        agent,
        state: "WAITING_ON_YOU",
        doing: doingJob(waitingJob),
        ref: { kind: "JOB", id: waitingJob.id },
        costTodayUsd,
      };
    return { agent, state: "IDLE", doing: null, ref: null, costTodayUsd };
  });

  const execution: HomeExecution[] = openRows
    .filter((j) => Number(j.rank) <= MAX_EXECUTION)
    .map((j) => ({
      jobId: j.id,
      title: cut(jobTitle(j), 300),
      agent: j.agent,
      status: j.status,
      stage: (j.stage as RunStage | null) ?? null,
      needsYou: isWaiting(j.status),
      createdAt: j.createdAt.toISOString(),
    }));

  // ── Results ──
  const spendWeek = jobSpendWeek + spendRows.reduce((n, s) => n + micros(s.week), 0);
  const issues = (counts?.draftIssues ?? 0) + (counts?.opportunityIssues ?? 0);
  const results: HomeResult[] = [
    {
      kind: "PULL_REQUESTS",
      value: counts?.pullRequests ?? 0,
      label: "draft PRs GitHub confirmed",
      source: "GitHub · 7 days",
    },
    { kind: "ISSUES_CREATED", value: issues, label: "issues GitHub confirmed", source: "GitHub · 7 days" },
    {
      kind: "TESTS_VERIFIED",
      value: passedThisWeek,
      label: "runs with passing tests",
      source: "NEXUS test runs · 7 days",
    },
    {
      kind: "DEEP_DIVES",
      value: counts?.deepDives ?? 0,
      label: "deep dives completed",
      source: "research · 7 days",
    },
    {
      kind: "AI_SPEND",
      value: spendWeek / 1e6,
      label: "AI spend, estimated",
      source: "NEXUS estimates · 7 days",
    },
  ];

  // ── Headline ──
  const runsToday = week.at(-1)!.runs;
  const passedToday = week.at(-1)!.passed;
  const sources = [
    jobRows.length + openRows.length,
    decisions.approvals + (counts?.pullRequests ?? 0),
    sum(week, (d) => d.passed + d.failed),
    decisions.plans + stepRows.length,
    decisions.jobDrafts + (counts?.draftIssues ?? 0),
    decisions.opportunities + (counts?.opportunityIssues ?? 0),
    decisions.incidents,
    (dive ? 1 : 0) + (counts?.deepDives ?? 0),
    spendRows.length,
  ].filter((n) => n > 0).length;
  const headline: HomeHeadline = {
    segments: headlineSegments({
      decisions,
      waiting,
      newestPush: counts?.newestPush ?? null,
      runsToday,
      passedToday,
      quiet: sources === 0,
    }),
    sources,
    decisionsWaiting: waiting,
  };

  return {
    date: today,
    time: new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now),
    timezone: tz,
    headline,
    decisions: {
      ...decisions,
      // A plan with only gaps says what it needs (it has nothing to approve); its drawer holds the gap buttons.
      top: topRows.map(decisionItem).map(({ ref, title, expiresAt, uncovered }) => ({
        ref,
        title: uncovered === null ? title : `${cut(title, 240)} · ${uncoveredAsk(uncovered)}`,
        expiresAt,
      })),
    },
    kpis,
    agents,
    execution,
    results,
    asOf: now.toISOString(),
  };
}

type Segment = HomeHeadline["segments"][number];
const plain = (text: string): Segment => ({ text, emphasis: false });
const bold = (text: string): Segment => ({ text, emphasis: true });

function headlineSegments(f: {
  decisions: Omit<HomeDecisions, "top">;
  waiting: number;
  newestPush: number | null;
  runsToday: number;
  passedToday: number;
  quiet: boolean;
}): Segment[] {
  const { approvals: a, plans: p, jobDrafts: d, opportunities: o, incidents: i } = f.decisions;
  if (f.waiting > 0) {
    const kinds = [
      [i, plural(i, "incident open", "incidents open")],
      [a, a === 1 && f.newestPush !== null ? `a push for #${f.newestPush}` : plural(a, "push", "pushes")],
      [p, plural(p, "plan", "plans")],
      [d, plural(d, "job draft", "job drafts")],
      [o, plural(o, "opportunity", "opportunities")],
    ] as const;
    const [first, second, ...rest] = kinds.filter(([n]) => n > 0).map(([n, phrase]) => ({ n, phrase }));
    const intro = plain(`${f.waiting} ${f.waiting === 1 ? "thing is" : "things are"} ready for you: `);
    if (!second) return [intro, bold(first!.phrase), plain(".")];
    if (rest.length === 0)
      return [intro, bold(first!.phrase), plain(" and "), bold(second.phrase), plain(".")];
    const more = rest.reduce((n, k) => n + k.n, 0);
    return [intro, bold(first!.phrase), plain(", "), bold(second.phrase), plain(` and ${more} more.`)];
  }
  if (f.runsToday > 0)
    return [
      plain("Nothing needs you right now. "),
      bold(plural(f.runsToday, "run today", "runs today")),
      plain(f.passedToday > 0 ? `, ${f.passedToday} with passing tests.` : "."),
    ];
  if (f.quiet)
    return [
      plain("A quiet start. "),
      bold("Describe a job in plain words"),
      plain(" and the Developer drafts it."),
    ];
  return [plain("Nothing needs you right now. "), bold("No runs yet today"), plain(".")];
}
