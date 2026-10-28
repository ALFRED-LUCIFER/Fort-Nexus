import { and, desc, eq, gte, notInArray, or } from "drizzle-orm";
import {
  CreateJobRequest,
  GITHUB_SETUP_COMMAND,
  TERMINAL_JOB_STATUSES,
  isTerminal,
  type Basis,
  type Intent,
  type MetricProvenance,
  type ProposedAction,
  type SourceRef,
} from "@nexus/contracts";
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
import { searchFindings } from "../research/service.ts";
import type { GithubCatalog } from "../github/catalog.ts";
import { ownerActor, type JobRow } from "../jobs.ts";
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
};

const CAPABILITIES =
  "From Talk I can tell you how a run is going, list your recent runs, propose starting a run for a GitHub issue, and report sales, failed payments, revenue (gross, refunds, net) or top products, and search research findings.";
const RECENT_RUNS = 5;
const FOLLOW_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

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
    case "START_ISSUE_RUN":
      return proposeIssueRun(intent, ctx);
    case "BUSINESS_METRIC":
      return businessMetric(intent, ctx);
    case "RESEARCH_SEARCH":
      return researchSearch(intent, ctx);
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

async function listRuns(intent: Intent, ctx: ToolContext): Promise<Reply> {
  const rows = await ctx.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.initiatorId, ctx.ownerId), eq(jobs.projectId, ctx.projectId)))
    .orderBy(desc(jobs.id))
    .limit(RECENT_RUNS);
  if (rows.length === 0)
    return { intent, text: "This project has no runs yet.", basis: "OBSERVED", sources: [] };
  return {
    intent,
    text: [
      `Your ${rows.length} most recent ${rows.length === 1 ? "run" : "runs"}:`,
      ...rows.map((j) => `• ${runName(j)}: ${words(j.status).toLowerCase()}`),
    ].join("\n"),
    basis: "OBSERVED",
    sources: rows.map(jobSource),
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
