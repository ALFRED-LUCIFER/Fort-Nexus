import { and, desc, eq, gte, inArray, notInArray, or, sql } from "drizzle-orm";
import {
  CreateDeepDiveRequest,
  CreateJobRequest,
  DEEP_DIVE_DEPTH_LIMITS,
  GITHUB_SETUP_COMMAND,
  JOB_STATUS_GROUPS,
  TERMINAL_JOB_STATUSES,
  isTerminal,
  type Basis,
  type HomeRef,
  type Intent,
  type JobStatus,
  type JobStatusGroup,
  type MetricProvenance,
  type ProposedAction,
  type SourceRef,
} from "@nexus/contracts";
import { resolveAgentProfile } from "../agents/service.ts";
import { listConnectors } from "../business/connectors.ts";
import {
  getPaymentFailures,
  getRevenueSummary,
  getSalesSummary,
  getTopProducts,
} from "../business/metrics.ts";
import type { Db } from "../db/index.ts";
import { approvals, jobs, runEvents } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { waitingOnYou, type DecisionItem } from "../home.ts";
import { localDate } from "../research/schedule.ts";
import { searchFindings } from "../research/service.ts";
import type { GithubCatalog } from "../github/catalog.ts";
import { ownerActor, type JobRow } from "../jobs.ts";
import { profileBlock } from "../plans/service.ts";
import { boundRepositoryIds } from "../workspaces.ts";

// FR-CWV-07 / FR-CXR-04: every reply is built here from records NEXUS read itself, with sources and a basis.
// The model's intent picks the tool; it never supplies a fact.

export type Reply = {
  text: string;
  basis: Basis;
  sources: SourceRef[];
  /** The intent actually answered (the server may turn an ambiguous RUN_STATUS into CLARIFY). */
  intent: Intent;
  /** A job verified by this reply; becomes the thread subject (FR-CWV-04). */
  subjectJobId?: string;
  proposal?: ProposedAction;
};

export type ToolContext = {
  db: Db;
  github: GithubCatalog | null;
  ownerId: string;
  /** The thread's project: every tool sees only its records (FR-CXR-01, NFR-CNV-05). */
  projectId: string;
  subjectJobId: string | null;
  connectorsDir: string;
  correlationId: string;
  /** The owner's timezone (config): "today" and clock times are the owner's. */
  timezone: string;
};

const CAPABILITIES =
  "From Talk I can tell you what's waiting on you, how a run is going, list your recent, running, failed or today's runs, propose starting a run for a GitHub issue, report sales, failed payments, revenue (gross, refunds, net) or top products, search research findings, and propose a deep dive by the AI researcher.";
const RECENT_RUNS = 5;
const FOLLOW_UP_WINDOW_MS = 24 * 60 * 60 * 1000;
const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const WAITING_ITEMS = 8;

// Words that report an outcome. A reply may use them only when it carries the source event (FR-CWV-07).
const OUTCOME_CLAIM = /\b(done|sent|merged|opened|deployed|completed|created|pushed|shipped|finished)\b/i;

/** Model-written text (clarifying questions, refusal reasons) is shown only when it claims no outcome. */
export const withoutClaims = (modelText: string, fallback: string) =>
  OUTCOME_CLAIM.test(modelText) ? fallback : modelText;

const iso = (d: Date) => d.toISOString();
const shortId = (id: string) => id.slice(-8);
const words = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replaceAll("_", " ");

const describe = (j: JobRow) => {
  if (j.issueSnapshot) return `#${j.issueSnapshot.issueNumber} on ${j.issueSnapshot.fullName}`;
  return j.request.jobType === "RUNNER_DIAGNOSTIC"
    ? `diagnostic ${j.request.preset}`
    : `issue #${j.request.issueNumber}`;
};
const runName = (j: JobRow) => `Run ${shortId(j.id)} (${describe(j)})`;

const jobSource = (j: JobRow): SourceRef => ({
  kind: "JOB",
  id: j.id,
  label: `run ${shortId(j.id)} · ${words(j.status)}`,
  asOf: iso(j.updatedAt),
});

export async function answer(intent: Intent, ctx: ToolContext): Promise<Reply> {
  switch (intent.kind) {
    case "RUN_STATUS":
      return runStatus(intent, ctx);
    case "LIST_RUNS":
      return listRuns(intent, ctx);
    case "WAITING_ON_YOU":
      return waiting(intent, ctx);
    case "START_ISSUE_RUN":
      return proposeIssueRun(intent, ctx);
    case "BUSINESS_METRIC":
      return businessMetric(intent, ctx);
    case "RESEARCH_SEARCH":
      return researchSearch(intent, ctx);
    case "RESEARCH_DEEP_DIVE":
      return proposeDeepDive(intent, ctx);
    case "CLARIFY":
      return {
        intent,
        text: withoutClaims(intent.question, "Which run or issue do you mean?"),
        basis: "NONE",
        sources: [],
      };
    case "UNSUPPORTED":
      return {
        intent,
        text: `I can't do that from Talk. ${CAPABILITIES}`,
        basis: "NONE",
        sources: [],
      };
  }
}

async function findJob(ctx: ToolContext, jobId: string) {
  const [job] = await ctx.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.initiatorId, ctx.ownerId), eq(jobs.projectId, ctx.projectId)));
  return job ?? null;
}

async function runStatus(intent: Extract<Intent, { kind: "RUN_STATUS" }>, ctx: ToolContext): Promise<Reply> {
  const jobId = intent.jobId ?? ctx.subjectJobId;
  if (jobId) {
    const job = await findJob(ctx, jobId);
    if (!job)
      return {
        intent,
        text: `I can't find a run ${shortId(jobId)} of yours in this project.`,
        basis: "NONE",
        sources: [],
      };
    return { ...(await jobStatus(job, ctx)), intent, subjectJobId: job.id };
  }
  // FR-CXR-07: no explicit run and no subject → only exactly one recent active or failed run is a safe antecedent.
  const candidates = await ctx.db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.initiatorId, ctx.ownerId),
        eq(jobs.projectId, ctx.projectId),
        gte(jobs.updatedAt, new Date(Date.now() - FOLLOW_UP_WINDOW_MS)),
        or(notInArray(jobs.status, [...TERMINAL_JOB_STATUSES]), eq(jobs.status, "FAILED")),
      ),
    )
    .orderBy(desc(jobs.id))
    .limit(RECENT_RUNS);
  if (candidates.length === 1)
    return { ...(await jobStatus(candidates[0]!, ctx)), intent, subjectJobId: candidates[0]!.id };
  const question =
    candidates.length === 0
      ? "No run is active or failed in the last 24 hours. Which run do you mean?"
      : `${candidates.length} runs are active or failed in the last 24 hours: ${candidates.map(runName).join(", ")}. Which one do you mean?`;
  return {
    intent: { kind: "CLARIFY", question },
    text: question,
    basis: candidates.length === 0 ? "NONE" : "OBSERVED",
    sources: candidates.map(jobSource),
  };
}

/** The run's state in words, from its row, its newest failure event and its newest approval. */
async function jobStatus(job: JobRow, ctx: ToolContext): Promise<Omit<Reply, "intent">> {
  const sources: SourceRef[] = [jobSource(job)];
  const name = runName(job);
  const [approval] = await ctx.db
    .select()
    .from(approvals)
    .where(eq(approvals.jobId, job.id))
    .orderBy(desc(approvals.id))
    .limit(1);
  const approvalSource = (a: NonNullable<typeof approval>): SourceRef => ({
    kind: "APPROVAL",
    id: a.id,
    label: `push approval · ${words(a.status)}`,
    asOf: iso(a.decidedAt ?? a.createdAt),
  });

  if (job.status === "COMPLETED") {
    const pr = approval?.status === "EXECUTED" ? approval.result : null;
    if (job.outcome === "PR_CREATED" && approval && pr) {
      sources.push(approvalSource(approval), {
        kind: "PULL_REQUEST",
        id: String(pr.pullRequestNumber),
        label: `draft PR #${pr.pullRequestNumber}`,
        asOf: iso(approval.decidedAt ?? approval.createdAt),
        url: pr.pullRequestUrl,
      });
      return {
        text: `${name} completed and draft PR #${pr.pullRequestNumber} is open on GitHub, waiting for your review. It isn't merged.`,
        basis: "OBSERVED",
        sources,
      };
    }
    if (job.outcome === "APPROVAL_DENIED")
      return {
        text: `${name} ended without a push: you denied it. Nothing was pushed.`,
        basis: "OBSERVED",
        sources,
      };
    return {
      text: `${name} completed${job.outcome ? ` with outcome ${words(job.outcome).toLowerCase()}` : ""}.`,
      basis: "OBSERVED",
      sources,
    };
  }
  if (job.status === "FAILED") {
    const [failed] = await ctx.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.jobId, job.id), eq(runEvents.type, "job.failed")))
      .orderBy(desc(runEvents.sequence))
      .limit(1);
    const reason = typeof failed?.payload.reason === "string" ? failed.payload.reason : null;
    if (failed)
      sources.push({
        kind: "RUN_EVENT",
        id: failed.id,
        label: `job.failed${reason ? ` · ${reason}` : ""}`,
        asOf: iso(failed.occurredAt),
      });
    return {
      text: `${name} failed${reason ? ` (${reason})` : ""}. No pull request came out of it. Open the run for the details.`,
      basis: "OBSERVED",
      sources,
    };
  }
  if (job.status === "AWAITING_APPROVAL" && approval) {
    sources.push(approvalSource(approval));
    return {
      text:
        approval.status === "PENDING"
          ? `${name} is waiting for your approval to push ${approval.action.headBranch} and open a draft PR. Nothing has been pushed yet.`
          : `${name} has your approval and NEXUS is pushing to GitHub. There is no pull request until GitHub confirms one.`,
      basis: "PENDING",
      sources,
    };
  }
  if (!isTerminal(job.status))
    return {
      text: `${name} is ${words(job.status).toLowerCase()}.${job.issueSnapshot ? " No pull request exists for it yet." : ""}`,
      basis: "PENDING",
      sources,
    };
  return { text: `${name} is ${words(job.status).toLowerCase()}.`, basis: "OBSERVED", sources };
}

const GROUP_WORD: Record<JobStatusGroup, string> = {
  SUCCEEDED: "completed",
  FAILED: "failed",
  ACTIVE: "in progress",
  NEEDS_YOU: "waiting on you",
  CANCELLED: "cancelled",
};
const groupOf = (s: JobStatus) =>
  (Object.keys(JOB_STATUS_GROUPS) as JobStatusGroup[]).find((g) => JOB_STATUS_GROUPS[g].includes(s))!;
const runLine = (j: JobRow) => `• ${runName(j)}: ${words(j.status).toLowerCase()}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const newest = (n: number) =>
  n === RECENT_RUNS ? `The ${RECENT_RUNS} newest runs` : plural(n, "run", "runs");

async function listRuns(intent: Extract<Intent, { kind: "LIST_RUNS" }>, ctx: ToolContext): Promise<Reply> {
  if (intent.period === "TODAY") return todaysRuns(intent, ctx);
  if (intent.status === "FAILED") return failedRuns(intent, ctx);
  const active = intent.status === "ACTIVE";
  const rows = await ctx.db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.initiatorId, ctx.ownerId),
        eq(jobs.projectId, ctx.projectId),
        active ? inArray(jobs.status, [...JOB_STATUS_GROUPS.ACTIVE]) : undefined,
      ),
    )
    .orderBy(desc(jobs.id))
    .limit(RECENT_RUNS);
  if (rows.length === 0)
    return {
      intent,
      text: active ? "No run is in progress in this project." : "This project has no runs yet.",
      basis: "OBSERVED",
      sources: [],
    };
  const heading = active
    ? `${newest(rows.length)} in progress:`
    : `Your ${rows.length} most recent ${rows.length === 1 ? "run" : "runs"}:`;
  return {
    intent,
    text: [heading, ...rows.map(runLine)].join("\n"),
    basis: "OBSERVED",
    sources: rows.map(jobSource),
  };
}

/** Today in the owner's timezone: how many runs started, by outcome, and the newest few. */
async function todaysRuns(intent: Intent, ctx: ToolContext): Promise<Reply> {
  const today = localDate(new Date(), ctx.timezone);
  const since = sql`(${today}::date::timestamp at time zone ${ctx.timezone}::text)`;
  const where = and(
    eq(jobs.initiatorId, ctx.ownerId),
    eq(jobs.projectId, ctx.projectId),
    gte(jobs.createdAt, since),
  );
  const [byStatus, rows] = await Promise.all([
    ctx.db
      .select({ status: jobs.status, n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(where)
      .groupBy(jobs.status),
    ctx.db.select().from(jobs).where(where).orderBy(desc(jobs.id)).limit(RECENT_RUNS),
  ]);
  const total = byStatus.reduce((n, r) => n + r.n, 0);
  if (total === 0)
    return {
      intent,
      text: `No runs started today (${today}) in this project.`,
      basis: "OBSERVED",
      sources: [],
    };
  const groups = new Map<JobStatusGroup, number>();
  for (const r of byStatus) groups.set(groupOf(r.status), (groups.get(groupOf(r.status)) ?? 0) + r.n);
  const split = (Object.keys(GROUP_WORD) as JobStatusGroup[])
    .filter((g) => groups.has(g))
    .map((g) => `${groups.get(g)} ${GROUP_WORD[g]}`)
    .join(", ");
  return {
    intent,
    text: [
      `Today (${today}): ${plural(total, "run", "runs")} started: ${split}.`,
      ...(total > rows.length ? [`The newest ${rows.length}:`] : []),
      ...rows.map(runLine),
    ].join("\n"),
    basis: "OBSERVED",
    sources: rows.map(jobSource),
  };
}

/** Runs that ended failed, rejected or expired in the last 7 days, each with its job.failed reason when it has one. */
async function failedRuns(intent: Intent, ctx: ToolContext): Promise<Reply> {
  const rows = await ctx.db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.initiatorId, ctx.ownerId),
        eq(jobs.projectId, ctx.projectId),
        inArray(jobs.status, [...JOB_STATUS_GROUPS.FAILED]),
        gte(jobs.updatedAt, new Date(Date.now() - FAILED_WINDOW_MS)),
      ),
    )
    .orderBy(desc(jobs.updatedAt), desc(jobs.id))
    .limit(RECENT_RUNS);
  if (rows.length === 0)
    return {
      intent,
      text: "No run failed in this project in the last 7 days.",
      basis: "OBSERVED",
      sources: [],
    };
  const failures = await ctx.db
    .selectDistinctOn([runEvents.jobId])
    .from(runEvents)
    .where(
      and(
        inArray(
          runEvents.jobId,
          rows.map((j) => j.id),
        ),
        eq(runEvents.type, "job.failed"),
      ),
    )
    .orderBy(runEvents.jobId, desc(runEvents.sequence));
  const failureOf = new Map(failures.map((e) => [e.jobId, e]));
  const sources: SourceRef[] = [];
  const lines = rows.map((j) => {
    sources.push(jobSource(j));
    const e = failureOf.get(j.id);
    const reason = typeof e?.payload.reason === "string" ? e.payload.reason : null;
    if (e)
      sources.push({
        kind: "RUN_EVENT",
        id: e.id,
        label: `job.failed${reason ? ` · ${reason}` : ""}`,
        asOf: iso(e.occurredAt),
      });
    return `${runLine(j)}${reason ? ` (${reason})` : ""}`;
  });
  return {
    intent,
    text: [
      `${newest(rows.length)} that failed in the last 7 days. No pull request came out of them:`,
      ...lines,
    ].join("\n"),
    basis: "OBSERVED",
    sources,
  };
}

const DECISION: Record<HomeRef["kind"], { word: string; source: SourceRef["kind"] }> = {
  INCIDENT: { word: "Open incident", source: "INCIDENT" },
  JOB: { word: "Push approval", source: "JOB" },
  PLAN: { word: "Plan to approve", source: "PLAN" },
  JOB_DRAFT: { word: "Job draft to review", source: "JOB_DRAFT" },
  OPPORTUNITY: { word: "Opportunity", source: "OPPORTUNITY" },
  DEEP_DIVE: { word: "Deep dive", source: "DEEP_DIVE" },
};

/**
 * "What's waiting on me?": the records behind Home's "Waiting on you" (same queries, same order), then the runs still
 * in progress, so "what's running and what's waiting" is answered in one reply.
 */
async function waiting(intent: Intent, ctx: ToolContext): Promise<Reply> {
  const { counts, items } = await waitingOnYou(ctx.db, ctx.ownerId, ctx.projectId, WAITING_ITEMS);
  const total = counts.approvals + counts.plans + counts.jobDrafts + counts.opportunities + counts.incidents;
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: ctx.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const decisionLine = (d: DecisionItem) =>
    `• ${DECISION[d.ref.kind].word}: ${cut(d.title, 160)}${d.expiresAt ? ` (expires ${clock.format(new Date(d.expiresAt))})` : ""}`;
  const decisionSource = (d: DecisionItem): SourceRef => ({
    kind: DECISION[d.ref.kind].source,
    id: d.ref.id,
    label: d.ref.kind === "JOB" ? `push approval · ${cut(d.title, 100)}` : cut(d.title, 120),
    asOf: d.createdAt,
  });
  // A run whose push approval is listed above isn't repeated below.
  const listed = new Set(items.filter((d) => d.ref.kind === "JOB").map((d) => d.ref.id));
  const runs = (
    await ctx.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.initiatorId, ctx.ownerId),
          eq(jobs.projectId, ctx.projectId),
          notInArray(jobs.status, [...TERMINAL_JOB_STATUSES]),
        ),
      )
      .orderBy(desc(jobs.id))
      .limit(RECENT_RUNS + listed.size)
  )
    .filter((j) => !listed.has(j.id))
    .slice(0, RECENT_RUNS);

  const text = [
    total === 0
      ? "Nothing is waiting on you in this project."
      : `${total === 1 ? "1 thing is" : `${total} things are`} waiting on you in this project:`,
    ...items.map(decisionLine),
    ...(total > items.length ? [`…and ${total - items.length} more on Home.`] : []),
    runs.length === 0 ? "No run is in progress." : "Runs in progress:",
    ...runs.map(runLine),
  ];
  return {
    intent,
    text: text.join("\n"),
    basis: "OBSERVED",
    sources: [...items.map(decisionSource), ...runs.map(jobSource)],
  };
}

async function proposeIssueRun(
  intent: Extract<Intent, { kind: "START_ISSUE_RUN" }>,
  ctx: ToolContext,
): Promise<Reply> {
  const none = (text: string): Reply => ({ intent, text, basis: "NONE", sources: [] });
  if (!ctx.github)
    return none(
      `GitHub isn't set up, so I can't start issue runs. On the home machine run \`${GITHUB_SETUP_COMMAND}\`.`,
    );
  const name = intent.repositoryFullName.toLowerCase();
  try {
    const repo = (await ctx.github.repositories()).items.find((r) => r.fullName.toLowerCase() === name);
    if (!repo)
      return none(`${intent.repositoryFullName} isn't a repository the NEXUS GitHub app can access.`);
    // Only Dev projects bind repositories, so this also turns away a Business project's thread.
    if (!(await boundRepositoryIds(ctx.db, ctx.ownerId, ctx.projectId)).has(repo.id))
      return none(
        `${repo.fullName} isn't bound to this project, so I won't start a run for it here. Bind it in Settings → Workspaces.`,
      );
    const { issue } = await ctx.github.issue(repo.id, intent.issueNumber);
    if (issue.state === "closed")
      return none(`Issue #${issue.number} on ${repo.fullName} is closed, so I won't start a run for it.`);
    const request = CreateJobRequest.parse({
      jobType: "DEV_ISSUE_TO_PR",
      projectId: ctx.projectId,
      repositoryId: repo.id,
      issueNumber: issue.number,
    });
    const b = request.jobType === "DEV_ISSUE_TO_PR" ? request.budget : null;
    const preview = [
      `Start a coding run for ${repo.fullName} issue #${issue.number}: "${issue.title.slice(0, 120)}".`,
      `NEXUS queues a DEV_ISSUE_TO_PR job on your home runner${b ? ` (at most ${b.maxWallClockMinutes} min, ${b.maxTurns} turns, $${b.maxCostUsd})` : ""}.`,
      "It edits in a sandbox only. Pushing a branch and opening a draft PR needs a separate approval.",
    ].join(" ");
    return {
      intent,
      text: `I can start a run for ${repo.fullName} #${issue.number}. Nothing starts until you confirm it on screen.`,
      basis: "PENDING",
      sources: [],
      proposal: { type: "jobs.create", request, preview },
    };
  } catch (err) {
    // Catalog errors are written for the owner and carry no secrets.
    if (err instanceof HttpError) return none(err.message);
    throw err;
  }
}

/**
 * PRD §10.1 RESEARCH_DEEP_DIVE: an R1 proposal (it spends budget), bounded by the AI researcher's effective profile.
 * The preview is built here from the request and the server's limits; the dive starts only on the owner's approval.
 */
async function proposeDeepDive(
  intent: Extract<Intent, { kind: "RESEARCH_DEEP_DIVE" }>,
  ctx: ToolContext,
): Promise<Reply> {
  const none = (text: string): Reply => ({ intent, text, basis: "NONE", sources: [] });
  const profile = await resolveAgentProfile(ctx.db, ctx.ownerId, ctx.projectId, "AI_RESEARCHER");
  // The cap is the profile's: Talk has no owner-typed cap, and the dive takes the lower of the two anyway.
  const parsed = CreateDeepDiveRequest.safeParse({
    projectId: ctx.projectId,
    question: intent.question.replace(/\s+/g, " "),
    depth: intent.depth,
    findingIds: [],
    maxCostUsd: profile.settings.maxCostUsdPerTask,
  });
  if (!parsed.success)
    return none("What exactly should the deep dive find out? Ask it as one complete question.");
  const request = parsed.data;
  const { question, depth, findingIds, maxCostUsd } = request;
  const blocked = profileBlock(profile, {
    type: "research.deep_dive",
    request: { question, depth, findingIds, maxCostUsd },
  });
  if (blocked)
    return none(`I can't propose a deep dive here: the ${blocked}. Change it in Agents → AI researcher.`);
  const limits = DEEP_DIVE_DEPTH_LIMITS[depth];
  const preview = [
    `Deep dive (${depth.toLowerCase()}) by the AI researcher: "${question}".`,
    `At most ${limits.maxSearches} web searches, ${limits.maxFetches} page reads, ${profile.settings.maxTurns} model turns and $${maxCostUsd}, reserved against today's budget when it starts.`,
    "It reads the public web; writes nothing outside NEXUS.",
    "Its report labels each claim by the evidence NEXUS found on the pages it read.",
  ].join(" ");
  return {
    intent,
    text: "I can have the AI researcher run that deep dive. Nothing starts until you confirm it on screen.",
    basis: "PENDING",
    sources: [],
    proposal: { type: "research.deep_dive", request, preview },
  };
}

// One typed gateway tool per metric (FR-BIZ-02..05); the label names it in the reply.
const METRIC_TOOLS = {
  SALES_SUMMARY: { label: "Sales", run: getSalesSummary },
  PAYMENT_FAILURES: { label: "Failed payments", run: getPaymentFailures },
  REVENUE: { label: "Revenue", run: getRevenueSummary },
  TOP_PRODUCTS: { label: "Top products", run: getTopProducts },
} as const;

type MetricResult = Awaited<ReturnType<(typeof METRIC_TOOLS)[keyof typeof METRIC_TOOLS]["run"]>>["current"];

const metricSource = (p: MetricProvenance): SourceRef => ({
  kind: "METRIC",
  id: `${p.connectorId}:${p.dataset}:${p.from}`,
  label: `${p.connectorName} · ${p.dataset} · ${words(p.environment)}`,
  asOf: p.queriedAt,
});

// DATA-G02: an unavailable metric is said to be unavailable; only the gateway's own numbers are ever quoted.
function metricLine(label: string, r: MetricResult): { text: string; sources: SourceRef[] } {
  if (r.status === "UNAVAILABLE") return { text: `${label}: unavailable (${r.message}).`, sources: [] };
  const p = r.provenance;
  const window = `${p.from} to ${p.to} (${p.timezone}${p.partial ? ", partial: the day isn't over" : ""})`;
  let figures: string;
  if ("paidOrders" in r) figures = `${r.paidOrders} paid orders, gross sales ${r.grossSales} ${r.currency}`;
  else if ("netSales" in r)
    figures = `gross sales ${r.grossSales} ${r.currency}, refunds ${r.refunds} ${r.currency}, net sales ${r.netSales} ${r.currency}. Formula: ${r.formula}`;
  else if ("items" in r)
    figures =
      (r.items.length > 0
        ? r.items.map((i) => `${i.product} ${i.revenue} ${r.currency} (${i.quantity} sold)`).join(", ")
        : "no products sold in paid orders") + `. Formula: ${p.formula}`;
  else
    figures =
      `${r.failed} failed of ${r.attempts} payment attempts` +
      (r.failureRate === null ? "" : ` (${(r.failureRate * 100).toFixed(1)}%)`) +
      (r.byReason.length > 0
        ? `; top reasons: ${r.byReason
            .slice(0, 3)
            .map((g) => `${g.reason} ${g.count}`)
            .join(", ")}`
        : "");
  return {
    text: `${label}, ${window}: ${figures}.`,
    sources: [metricSource(p), ...("refundsProvenance" in r ? [metricSource(r.refundsProvenance)] : [])],
  };
}

async function businessMetric(
  intent: Extract<Intent, { kind: "BUSINESS_METRIC" }>,
  ctx: ToolContext,
): Promise<Reply> {
  const none = (text: string): Reply => ({ intent, text, basis: "NONE", sources: [] });
  // A Dev project has no connectors, so it gets the same honest "no source" answer (DATA-G02).
  const scope = {
    db: ctx.db,
    connectorsDir: ctx.connectorsDir,
    actor: ownerActor(ctx.ownerId),
    correlationId: ctx.correlationId,
    ownerId: ctx.ownerId,
    projectId: ctx.projectId,
  };
  const usable = (await listConnectors(scope)).filter((c) => c.hasDictionary && c.status !== "DISABLED");
  if (usable.length === 0)
    return none(
      "No business source with a metric dictionary is connected to this project, so I have no figures to report.",
    );
  // FR-CXR-07: never guess between sources.
  if (usable.length > 1)
    return none(
      `Several business sources are connected (${usable.map((c) => c.name).join(", ")}). Open the Business drawer to pick one.`,
    );
  const query = { connectorId: usable[0]!.id, day: intent.day, compare: intent.compare };
  const tool = METRIC_TOOLS[intent.metric];
  let res: { current: MetricResult; previous: MetricResult | null };
  try {
    res = await tool.run(scope, query);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 400)
      return none(`I can't report that day: ${err.message}`);
    throw err;
  }
  const lines = [metricLine(`${tool.label} ${intent.day}`, res.current)];
  if (res.previous) lines.push(metricLine("Previous day, same window", res.previous));
  const sources = lines.flatMap((l) => l.sources);
  return {
    intent,
    text: lines.map((l) => l.text).join(" "),
    basis: sources.length > 0 ? "OBSERVED" : "NONE",
    sources,
  };
}

const RESEARCH_HITS = 5;

// FR-RES-06: an UNVERIFIED finding is relayed as the publisher's claim, never as established fact (RES-G03).
async function researchSearch(
  intent: Extract<Intent, { kind: "RESEARCH_SEARCH" }>,
  ctx: ToolContext,
): Promise<Reply> {
  const { items } = await searchFindings(ctx.db, ctx.ownerId, {
    projectId: ctx.projectId,
    q: intent.query.trim() || undefined,
    limit: RESEARCH_HITS,
  });
  if (items.length === 0)
    return { intent, text: `No research findings match "${intent.query}".`, basis: "NONE", sources: [] };
  const lines = items.map((f) => {
    const by = f.sources[0]!.publisher;
    return f.label === "UNVERIFIED"
      ? `${by} claims: "${f.title}" (unverified, score ${f.score}).`
      : `"${f.title}" (${words(f.label)}, ${by}, score ${f.score}).`;
  });
  return {
    intent,
    text: `Newest matching findings (scores are triage aids): ${lines.join(" ")}`,
    basis: "OBSERVED",
    sources: items.map((f) => ({
      kind: "FINDING",
      id: f.id,
      label: `${words(f.label)} · ${f.sources[0]!.publisher}`,
      asOf: f.sources
        .map((s) => s.fetchedAt)
        .sort()
        .at(-1)!,
      url: f.canonicalUrl,
    })),
  };
}
