import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentKey,
  HomeResultKind,
  HomeSummary,
  type ApprovalStatus,
  type HomeKpiKey,
  type JobStatus,
  type OpportunityStatus,
  type PlanStatus,
  type RunStage,
  type Verification,
  type WorkspaceList,
} from "@nexus/contracts";
import { createDb, type Db } from "../src/db/index.ts";
import { aiSpend, approvals, jobs, projects, runEvents, user, workspaces } from "../src/db/schema.ts";
import { homeSummary } from "../src/home.ts";
import { jobDrafts, type JobDraftRowStatus } from "../src/job-drafts/schema.ts";
import { planSteps, plans } from "../src/plans/schema.ts";
import { incidents, monitoredApps } from "../src/monitoring/schema.ts";
import { researchDeepDives } from "../src/research/deep/schema.ts";
import { researchOpportunities } from "../src/research/opportunities/schema.ts";
import { localDate } from "../src/research/schedule.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// Cofounder wave A: GET /v1/home over seeded source records in a non-UTC owner timezone (Asia/Kolkata, UTC+5:30,
// no DST), with a decoy project and a decoy owner (NFR-CNV-05). Windowed numbers use a fixed `now`; the reaper runs
// on the real clock, so pending approvals always expire in the real future.

const TZ = "Asia/Kolkata";
const MIN = 60_000;
// 13:30 on Tuesday 10 March 2026 in Kolkata; that local day starts at 2026-03-09T18:30Z.
const NOW = new Date("2026-03-10T08:00:00Z");
const utc = (iso: string) => new Date(`${iso}Z`);
const LATER = () => new Date(Date.now() + 24 * 60 * MIN);

let t: TestApp;
let db: Db;
let pool: pg.Pool;
let cookie: string;
let ownerId: string;
let devWorkspace: string;
let decoyOwner: string;
let decoyOwnerProject: string;
let decoyOwnerJob: string;

const get = (url: string, headers: Record<string, string> = { cookie }) =>
  t.app.inject({ method: "GET", url, headers });
async function home(projectId?: string) {
  const res = await get(`/v1/home${projectId ? `?projectId=${projectId}` : ""}`);
  expect(res.statusCode, res.body).toBe(200);
  return HomeSummary.parse(res.json());
}
/** At the fixed NOW, checked against the contract like the route's serializer does. */
const at = async (projectId?: string, now = NOW) =>
  HomeSummary.parse(await homeSummary(db, ownerId, TZ, { projectId }, now));
const kpi = (h: HomeSummary, key: HomeKpiKey) => h.kpis.find((k) => k.key === key)!;
const agent = (h: HomeSummary, key: AgentKey) => h.agents.find((a) => a.agent === key)!;
const result = (h: HomeSummary, kind: HomeResultKind) => h.results.find((r) => r.kind === kind)!.value;
const text = (h: HomeSummary) => h.headline.segments.map((s) => s.text).join("");
const emphasised = (h: HomeSummary) => h.headline.segments.filter((s) => s.emphasis).map((s) => s.text);

async function newProject() {
  const slug = `p-${randomBytes(4).toString("hex")}`;
  const res = await t.app.inject({
    method: "POST",
    url: `/v1/workspaces/${devWorkspace}/projects`,
    headers: { cookie, origin: t.config.publicOrigin },
    payload: { name: slug, slug },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}
const scopeOf = (projectId: string, workspaceId = devWorkspace) => ({ workspaceId, projectId });

type JobSeed = {
  projectId: string;
  initiatorId?: string;
  diagnostic?: boolean;
  agent?: AgentKey;
  status?: JobStatus;
  createdAt?: Date;
  estimatedCostUsd?: number | null;
  issueNumber?: number;
  title?: string;
};
async function seedJob(s: JobSeed) {
  const { projectId } = s;
  const issueNumber = s.issueNumber ?? 7;
  const request = s.diagnostic
    ? { jobType: "RUNNER_DIAGNOSTIC" as const, preset: "host-info" as const, projectId }
    : {
        jobType: "DEV_ISSUE_TO_PR" as const,
        repositoryId: "101",
        issueNumber,
        projectId,
        budget: { maxWallClockMinutes: 45, maxTurns: 60, maxCostUsd: 5 },
      };
  const [job] = await db
    .insert(jobs)
    .values({
      initiatorId: s.initiatorId ?? ownerId,
      projectId,
      jobType: request.jobType,
      agent: s.agent ?? (s.diagnostic ? "DEVOPS" : "DEVELOPER"),
      status: s.status ?? "COMPLETED",
      riskTier: s.diagnostic ? "R0" : "R1",
      request,
      requestHash: randomBytes(32).toString("hex"),
      idempotencyKey: `seed-${randomUUID()}`,
      issueSnapshot: s.diagnostic
        ? null
        : {
            repositoryId: "101",
            fullName: "acme/web",
            issueNumber,
            title: s.title ?? "Fix cart totals",
            body: "",
            acceptanceCriteria: [],
            htmlUrl: `https://github.com/acme/web/issues/${issueNumber}`,
            issueUpdatedAt: "2026-01-01T00:00:00.000Z",
            baseBranch: "main",
            baseSha: "a".repeat(40),
          },
      estimatedCostUsd: s.estimatedCostUsd ?? null,
      ...(s.createdAt ? { createdAt: s.createdAt } : {}),
    })
    .returning();
  return job!;
}

const verification = (status: Verification["status"]): Verification => ({
  status,
  reason: null,
  source: "package.json",
  install: null,
  test: ["pnpm", "test"],
  exitCode: status === "passed" ? 0 : 1,
  durationMs: 1000,
  outputTail: "",
});

async function seedApproval(
  job: { id: string; projectId: string; createdAt: Date; issueSnapshot: { issueNumber: number } | null },
  status: ApprovalStatus,
  o: {
    afterMinutes?: number;
    tests?: Verification["status"];
    pr?: number;
    decidedAt?: Date;
    expiresAt?: Date;
  } = {},
) {
  const createdAt = new Date(job.createdAt.getTime() + (o.afterMinutes ?? 5) * MIN);
  const issueNumber = job.issueSnapshot?.issueNumber ?? 7;
  const [a] = await db
    .insert(approvals)
    .values({
      jobId: job.id,
      projectId: job.projectId,
      riskTier: "R2",
      status,
      action: {
        type: "github.push_draft_pr",
        repositoryId: "101",
        repositoryFullName: "acme/web",
        issueNumber,
        baseBranch: "main",
        baseSha: "a".repeat(40),
        headBranch: `nexus/${issueNumber}-${job.id.slice(0, 8)}`,
        // The PR title as issue-to-pr.ts builds it: Home must not show the number twice.
        title: `#${issueNumber}: Fix cart totals`,
        body: "",
        changesetSha256: "b".repeat(64),
        files: [{ path: "src/cart.ts", change: "modified" }],
        stats: { added: 1, removed: 1 },
        verification: verification(o.tests ?? "passed"),
      },
      actionHash: randomBytes(32).toString("hex"),
      createdAt,
      // PENDING ones expire in the real future so the running reaper leaves them alone.
      expiresAt: o.expiresAt ?? (status === "PENDING" ? LATER() : new Date(createdAt.getTime() + 60 * MIN)),
      decidedAt: o.decidedAt ?? (status === "PENDING" ? null : createdAt),
      result: o.pr
        ? {
            pullRequestNumber: o.pr,
            pullRequestUrl: `https://github.com/acme/web/pull/${o.pr}`,
            headSha: "c".repeat(40),
          }
        : null,
    })
    .returning();
  return a!;
}

const seedEvent = (
  jobId: string,
  sequence: number,
  e: {
    type?: "test.completed" | "agent.message";
    stage?: RunStage | null;
    payload?: Record<string, unknown>;
  },
) =>
  db.insert(runEvents).values({
    jobId,
    sequence,
    occurredAt: new Date(),
    type: e.type ?? "agent.message",
    stage: e.stage ?? null,
    actor: "runner:seed",
    payload: e.payload ?? {},
  });
const seedTests = (jobId: string, sequence: number, status: Verification["status"]) =>
  seedEvent(jobId, sequence, { type: "test.completed", stage: "test", payload: verification(status) });

const seedSpend = (
  scope: { workspaceId: string; projectId: string },
  source: "DEEP_DIVE" | "JOB_DRAFT",
  reservedUsd: number,
  costUsd: number | null,
  createdAt: Date,
) => db.insert(aiSpend).values({ ...scope, source, sourceId: randomUUID(), reservedUsd, costUsd, createdAt });

async function seedPlan(
  projectId: string,
  o: {
    status?: PlanStatus;
    hashed?: boolean;
    goal?: string;
    createdAt?: Date;
    owner?: string;
    ws?: string;
  } = {},
) {
  const [p] = await db
    .insert(plans)
    .values({
      ...scopeOf(projectId, o.ws),
      ownerId: o.owner ?? ownerId,
      goal: o.goal ?? "Ship the CSV export",
      status: o.status ?? "DRAFT",
      planHash: o.hashed === false ? null : randomBytes(32).toString("hex"),
      idempotencyKey: randomUUID(),
      requestHash: "0".repeat(64),
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    })
    .returning();
  return p!;
}

async function seedDraft(
  projectId: string,
  o: {
    status?: JobDraftRowStatus;
    text?: string;
    issueTitle?: string | null;
    issueNumber?: number | null;
    createdIssueNumber?: number | null;
    createdAt?: Date;
    updatedAt?: Date;
    owner?: string;
    ws?: string;
  } = {},
) {
  const [d] = await db
    .insert(jobDrafts)
    .values({
      ...scopeOf(projectId, o.ws),
      ownerId: o.owner ?? ownerId,
      idempotencyKey: randomUUID(),
      requestHash: "0".repeat(64),
      status: o.status ?? "READY",
      text: o.text ?? "add a csv export to the orders page",
      issueTitle: o.issueTitle === undefined ? "Add CSV export" : o.issueTitle,
      issueNumber: o.issueNumber ?? null,
      budget: { maxWallClockMinutes: 45, maxTurns: 60, maxCostUsd: 5 },
      createdIssueNumber: o.createdIssueNumber ?? null,
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      ...(o.updatedAt ? { updatedAt: o.updatedAt } : {}),
    })
    .returning();
  return d!;
}

async function seedDive(
  projectId: string,
  o: {
    status?: "RUNNING" | "COMPLETED" | "FAILED";
    question?: string;
    finishedAt?: Date | null;
    ws?: string;
  } = {},
) {
  const id = randomUUID();
  const [d] = await db
    .insert(researchDeepDives)
    .values({
      id,
      ...scopeOf(projectId, o.ws),
      ownerId,
      idempotencyKey: id,
      requestHash: "0".repeat(64),
      correlationId: id,
      question: o.question ?? "What do small shops struggle with at month end?",
      depth: "STANDARD",
      findingIds: [],
      status: o.status ?? "COMPLETED",
      limits: { maxCostUsd: 2, maxTurns: 30, maxSearches: 10, maxFetches: 16 },
      searchEnabled: true,
      model: "claude-opus-5-5",
      startedAt: new Date(),
      finishedAt: o.finishedAt ?? null,
    })
    .returning();
  return d!;
}

async function seedOpportunity(
  projectId: string,
  o: {
    status?: OpportunityStatus;
    title?: string;
    issue?: number;
    createdAt?: Date;
    updatedAt?: Date;
    ws?: string;
  } = {},
) {
  const dive = await seedDive(projectId, { ws: o.ws });
  const [r] = await db
    .insert(researchOpportunities)
    .values({
      ...scopeOf(projectId, o.ws),
      deepDiveId: dive.id,
      kind: "OPPORTUNITY",
      title: o.title ?? "Payout matching for small shops",
      problem: "",
      targetUsers: "",
      impactEstimate: "",
      confidence: "MEDIUM",
      evidence: [],
      verifiedClaims: 0,
      validationSteps: [],
      agents: ["AI_RESEARCHER"],
      status: o.status ?? "OPEN",
      issue: o.issue
        ? {
            repositoryFullName: "acme/web",
            number: o.issue,
            url: `https://github.com/acme/web/issues/${o.issue}`,
          }
        : null,
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      ...(o.updatedAt ? { updatedAt: o.updatedAt } : {}),
    })
    .returning();
  return r!;
}

beforeAll(async () => {
  t = await createTestApp({ OWNER_TIMEZONE: TZ });
  ({ db, pool } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  const ws = (await get("/v1/workspaces")).json<WorkspaceList>();
  devWorkspace = ws.items.find((w) => w.mode === "DEV")!.id;
  ownerId = (await pool.query(`select owner_id from workspaces where id = $1`, [devWorkspace])).rows[0]
    .owner_id as string;

  // Another owner's records of every kind: never counted, listed or reachable.
  decoyOwner = `decoy-${randomUUID()}`;
  await db.insert(user).values({ id: decoyOwner, name: "Decoy", email: `${decoyOwner}@example.com` });
  const [dws] = await db
    .insert(workspaces)
    .values({ ownerId: decoyOwner, mode: "DEV", name: "Dev" })
    .returning();
  const [dp] = await db
    .insert(projects)
    .values({ workspaceId: dws!.id, slug: "home", name: "Home" })
    .returning();
  decoyOwnerProject = dp!.id;
  const dj = await seedJob({
    projectId: dp!.id,
    initiatorId: decoyOwner,
    agent: "FINANCIAL_ANALYST",
    status: "RUNNING",
    estimatedCostUsd: 40,
    createdAt: NOW,
  });
  decoyOwnerJob = dj.id;
  await seedApproval(dj, "PENDING");
  await seedPlan(dp!.id, { owner: decoyOwner, ws: dws!.id });
  await seedDraft(dp!.id, { owner: decoyOwner, ws: dws!.id });
  await seedOpportunity(dp!.id, { ws: dws!.id });
  await seedSpend({ workspaceId: dws!.id, projectId: dp!.id }, "DEEP_DIVE", 50, 50, NOW);
});
afterAll(async () => {
  await t?.app.close();
  await pool?.end();
});

describe("auth and validation", () => {
  it("401 without a session; 404 for an unknown or another owner's project; 400 for a bad id", async () => {
    expect((await get("/v1/home", {})).statusCode).toBe(401);
    for (const projectId of [randomUUID(), decoyOwnerProject])
      expect((await get(`/v1/home?projectId=${projectId}`)).statusCode).toBe(404);
    expect((await get("/v1/home?projectId=nope")).statusCode).toBe(400);
  });
});

describe("GET /v1/home", () => {
  it("an empty project: quiet headline, null KPIs, idle agents, every result at zero", async () => {
    const before = new Date();
    const h = await home(await newProject());
    expect(h.date).toBe(localDate(before, TZ));
    expect(h.timezone).toBe(TZ);
    expect(h.time).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    expect(Date.parse(h.asOf)).toBeGreaterThanOrEqual(before.getTime());
    expect(text(h)).toBe("A quiet start. Describe a job in plain words and the Developer drafts it.");
    expect(emphasised(h)).toEqual(["Describe a job in plain words"]);
    expect(h.headline).toMatchObject({ sources: 0, decisionsWaiting: 0 });
    expect(h.decisions).toEqual({
      approvals: 0,
      plans: 0,
      jobDrafts: 0,
      opportunities: 0,
      incidents: 0,
      top: [],
    });
    expect(h.kpis.map((k) => [k.key, k.value, k.previous])).toEqual([
      ["REVIEW_READY_MEDIAN", null, null],
      ["TESTS_PASS_RATE", null, null],
      ["RUNS_TODAY", 0, 0],
      ["WAITING_ON_YOU", 0, null],
    ]);
    expect(kpi(h, "REVIEW_READY_MEDIAN").series).toEqual(Array(7).fill(null));
    expect(kpi(h, "RUNS_TODAY").series).toEqual(Array(7).fill(0));
    expect(h.agents).toEqual(
      AgentKey.options.map((a) => ({ agent: a, state: "IDLE", doing: null, ref: null, costTodayUsd: 0 })),
    );
    expect(h.execution).toEqual([]);
    expect(h.results.map((r) => [r.kind, r.value])).toEqual(HomeResultKind.options.map((k) => [k, 0]));
  });

  it("KPIs per local day in the owner's timezone, with null days and the previous 7 days", async () => {
    const projectId = await newProject();
    const job = (iso: string, o: Partial<JobSeed> = {}) => seedJob({ projectId, createdAt: utc(iso), ...o });

    // This week = local 4–10 March; previous = 25 Feb – 3 March.
    const j1 = await job("2026-03-10T02:00:00", { status: "AWAITING_APPROVAL", estimatedCostUsd: 1.25 });
    await seedApproval(j1, "DENIED", { afterMinutes: 10, tests: "passed" }); // first approval: 10 min
    await seedApproval(j1, "PENDING", { afterMinutes: 50, tests: "failed" }); // latest verification: failed
    const j2 = await job("2026-03-09T18:31:00"); // 00:01 on 10 March
    await seedApproval(j2, "EXECUTED", { afterMinutes: 30, pr: 31, decidedAt: utc("2026-03-10T03:00:00") });
    const j3 = await job("2026-03-09T18:29:00"); // 23:59 on 9 March; tested by the runner, no approval
    await seedTests(j3.id, 1, "passed");
    const j4 = await job("2026-03-07T10:00:00", { estimatedCostUsd: 0.5 });
    await seedApproval(j4, "APPROVED", { afterMinutes: 40, tests: "not_configured" });
    const j5 = await job("2026-03-03T18:31:00"); // 00:01 on 4 March, the first day of the week
    await seedTests(j5.id, 1, "failed");
    await seedTests(j5.id, 2, "passed"); // the latest event wins
    const j6 = await job("2026-03-03T18:29:00", { estimatedCostUsd: 9 }); // 23:59 on 3 March: previous week
    await seedApproval(j6, "APPROVED", { afterMinutes: 60, tests: "failed" });
    const j7 = await job("2026-02-25T00:00:00");
    await seedApproval(j7, "EXECUTED", { afterMinutes: 20, pr: 32, decidedAt: utc("2026-02-25T01:00:00") });
    const j8 = await job("2026-02-24T18:29:00"); // 23:59 on 24 Feb: outside both windows
    await seedApproval(j8, "APPROVED", { afterMinutes: 1, tests: "passed" });
    const j9 = await job("2026-03-08T05:00:00");
    await seedTests(j9.id, 1, "error"); // neither passed nor failed

    const scope = scopeOf(projectId);
    await seedSpend(scope, "JOB_DRAFT", 0.25, 0.2, utc("2026-03-10T03:00:00"));
    await seedSpend(scope, "JOB_DRAFT", 0.3, null, utc("2026-03-08T03:00:00")); // unsettled: the reservation
    await seedSpend(scope, "DEEP_DIVE", 1, 0.4, utc("2026-03-09T18:30:00")); // today's first instant
    await seedSpend(scope, "DEEP_DIVE", 5, 5, utc("2026-03-03T18:29:00")); // previous week

    const h = await at(projectId);
    expect(h).toMatchObject({ date: "2026-03-10", time: "13:30", timezone: TZ });
    expect(kpi(h, "REVIEW_READY_MEDIAN")).toEqual({
      key: "REVIEW_READY_MEDIAN",
      label: "Issue → review-ready",
      value: 30, // 40, 10, 30
      unit: "minutes",
      previous: 40, // 60, 20
      better: "DOWN",
      series: [null, null, null, 40, null, null, 20],
      source: "jobs + approvals · 7 days",
    });
    expect(kpi(h, "TESTS_PASS_RATE")).toMatchObject({
      value: 0.75, // j5, j3, j2 passed; j1 failed
      previous: 0.5,
      better: "UP",
      unit: "ratio",
      series: [1, null, null, null, null, 1, 0.5],
      source: "NEXUS test runs · 7 days",
    });
    expect(kpi(h, "RUNS_TODAY")).toMatchObject({
      value: 2,
      previous: 1, // the same weekday last week (j6)
      unit: "count",
      series: [1, 0, 0, 1, 1, 1, 2],
    });
    expect(kpi(h, "WAITING_ON_YOU")).toMatchObject({
      value: 1,
      previous: null,
      better: "DOWN",
      series: [null, null, null, null, null, null, 1],
    });

    expect(result(h, "PULL_REQUESTS")).toBe(1); // j2; j7's PR is from the previous week
    expect(result(h, "TESTS_VERIFIED")).toBe(3);
    expect(result(h, "AI_SPEND")).toBeCloseTo(1.25 + 0.5 + 0.2 + 0.3 + 0.4, 6);
    expect(agent(h, "DEVELOPER").costTodayUsd).toBeCloseTo(1.25 + 0.2, 6);
    expect(agent(h, "AI_RESEARCHER").costTodayUsd).toBeCloseTo(0.4, 6);

    // A minute before local midnight the 00:01 job and today's spend are tomorrow's.
    const lastMinuteOf9th = await at(projectId, utc("2026-03-09T18:29:30"));
    expect(lastMinuteOf9th.date).toBe("2026-03-09");
    expect(kpi(lastMinuteOf9th, "RUNS_TODAY")).toMatchObject({ value: 1, series: [1, 1, 0, 0, 1, 1, 1] });
    expect(agent(lastMinuteOf9th, "AI_RESEARCHER").costTodayUsd).toBe(0);
  });

  it("agent states and doing text, execution stages and the 8-job cap", async () => {
    const projectId = await newProject();
    const base = NOW.getTime() - 120 * MIN;
    const job = (minute: number, o: Partial<JobSeed>) =>
      seedJob({ projectId, createdAt: new Date(base + minute * MIN), ...o });

    // The Developer's only working job is the oldest open one: outside the 8 shown, still its state.
    const running = await job(0, { status: "RUNNING", issueNumber: 42, title: "cart rounding" });
    await seedEvent(running.id, 1, { stage: "plan" });
    await seedEvent(running.id, 2, { stage: "implement" });
    await seedEvent(running.id, 3, { stage: "test" });
    await seedEvent(running.id, 4, { stage: null }); // a stageless event keeps the last stage
    const waiting = await job(1, { status: "AWAITING_APPROVAL", issueNumber: 43, title: "Totals" });
    await seedEvent(waiting.id, 1, { stage: "review" });
    const qa = await job(2, {
      status: "BLOCKED_NEEDS_INFO",
      agent: "QA",
      issueNumber: 44,
      title: "Flaky test",
    });
    const fillers = [];
    for (let i = 0; i < 7; i++) fillers.push(await job(10 + i, { status: "QUEUED", diagnostic: true }));
    await job(30, { status: "COMPLETED", agent: "CHIEF_OF_STAFF" });
    await job(31, { status: "FAILED", agent: "PRODUCT" });

    const question = `Why ${"really ".repeat(15)}do shops churn?`;
    const dive = await seedDive(projectId, { status: "RUNNING", question });
    // A research-run step whose run doesn't exist: the plan executor leaves it waiting.
    const plan = await seedPlan(projectId, { status: "RUNNING", goal: "Write the PRD" });
    await db.insert(planSteps).values({
      ...scopeOf(projectId),
      planId: plan.id,
      index: 0,
      title: "Draft the PRD",
      agent: "PRODUCT",
      action: { type: "research.run", watchlistId: randomUUID() },
      dependsOn: [],
      status: "RUNNING",
      researchRunId: randomUUID(),
      startedAt: NOW,
    });

    const h = await at(projectId);
    expect(agent(h, "DEVELOPER")).toMatchObject({
      state: "WORKING",
      doing: "#42 cart rounding · test",
      ref: { kind: "JOB", id: running.id },
    });
    expect(agent(h, "QA")).toMatchObject({
      state: "WAITING_ON_YOU",
      doing: "#44 Flaky test · needs info",
      ref: { kind: "JOB", id: qa.id },
    });
    expect(agent(h, "DEVOPS")).toMatchObject({
      state: "WORKING",
      doing: "Runner diagnostic · host-info · queued",
      ref: { kind: "JOB", id: fillers.at(-1)!.id },
    });
    const researcher = agent(h, "AI_RESEARCHER");
    expect(researcher).toMatchObject({ state: "WORKING", ref: { kind: "DEEP_DIVE", id: dive.id } });
    expect(researcher.doing).toBe(`Deep dive · ${question.slice(0, 79).trimEnd()}…`);
    expect(agent(h, "PRODUCT")).toMatchObject({
      state: "WORKING",
      doing: "Plan step · Draft the PRD",
      ref: { kind: "PLAN", id: plan.id },
    });
    for (const a of ["CHIEF_OF_STAFF", "FINANCIAL_ANALYST"] as const)
      expect(agent(h, a)).toMatchObject({ state: "IDLE", doing: null, ref: null });

    expect(h.execution.map((e) => e.jobId)).toEqual([...fillers.map((f) => f.id).reverse(), qa.id]);
    expect(h.execution.at(-1)).toEqual({
      jobId: qa.id,
      title: "#44 Flaky test",
      agent: "QA",
      status: "BLOCKED_NEEDS_INFO",
      stage: null,
      needsYou: true,
      createdAt: qa.createdAt.toISOString(),
    });
    expect(h.execution[0]).toMatchObject({
      title: "Runner diagnostic · host-info",
      stage: null,
      needsYou: false,
    });

    // Fewer open jobs: the stage is the latest one reported; waiting jobs say why in `doing`.
    for (const f of fillers) await db.update(jobs).set({ status: "COMPLETED" }).where(eq(jobs.id, f.id));
    await db.update(jobs).set({ status: "COMPLETED" }).where(eq(jobs.id, running.id));
    const h2 = await at(projectId);
    expect(h2.execution.map((e) => [e.jobId, e.stage, e.needsYou])).toEqual([
      [qa.id, null, true],
      [waiting.id, "review", true],
    ]);
    expect(agent(h2, "DEVELOPER")).toMatchObject({
      state: "WAITING_ON_YOU",
      doing: "#43 Totals · waiting for your approval",
      ref: { kind: "JOB", id: waiting.id },
    });
    expect(agent(h2, "DEVOPS").state).toBe("IDLE");
  });

  it("decisions: counts by kind, the 5 newest with titles and expiry, and the headline", async () => {
    const projectId = await newProject();
    const minute = (m: number) => new Date(NOW.getTime() - (60 - m) * MIN);

    const pushJob = await seedJob({
      projectId,
      status: "AWAITING_APPROVAL",
      issueNumber: 42,
      createdAt: minute(0),
    });
    const push = await seedApproval(pushJob, "PENDING", { afterMinutes: 1 }); // created at minute 1
    const expiredJob = await seedJob({ projectId, status: "AWAITING_APPROVAL", createdAt: minute(0) });
    await seedApproval(expiredJob, "PENDING", { afterMinutes: 2, expiresAt: new Date(NOW.getTime() - MIN) });
    const decided = await seedJob({ projectId, createdAt: minute(0) });
    await seedApproval(decided, "DENIED", { afterMinutes: 3 });

    const plan = await seedPlan(projectId, { goal: "Ship the CSV export", createdAt: minute(4) });
    await seedPlan(projectId, { hashed: false, createdAt: minute(5) }); // still drafting: never shown
    await seedPlan(projectId, { status: "APPROVED", createdAt: minute(6) });
    const ready = await seedDraft(projectId, { issueTitle: "Add CSV export", createdAt: minute(7) });
    const needsRepo = await seedDraft(projectId, {
      status: "NEEDS_REPO",
      issueTitle: null,
      text: "fix the flaky login test",
      createdAt: minute(8),
    });
    const existing = await seedDraft(projectId, {
      issueTitle: "Totals are wrong",
      issueNumber: 12,
      createdAt: minute(9),
    });
    await seedDraft(projectId, { status: "DRAFTING", createdAt: minute(10) });
    await seedDraft(projectId, { status: "STARTED", createdAt: minute(11) });
    const opp = await seedOpportunity(projectId, { title: "Payout matching", createdAt: minute(12) });
    await seedOpportunity(projectId, { status: "DISMISSED", createdAt: minute(13) });

    const h = await at(projectId);
    expect(h.decisions).toMatchObject({ approvals: 1, plans: 1, jobDrafts: 3, opportunities: 1 });
    expect(h.decisions.top).toEqual([
      { ref: { kind: "OPPORTUNITY", id: opp.id }, title: "Payout matching", expiresAt: null },
      { ref: { kind: "JOB_DRAFT", id: existing.id }, title: "#12 Totals are wrong", expiresAt: null },
      { ref: { kind: "JOB_DRAFT", id: needsRepo.id }, title: "fix the flaky login test", expiresAt: null },
      { ref: { kind: "JOB_DRAFT", id: ready.id }, title: "Add CSV export", expiresAt: null },
      { ref: { kind: "PLAN", id: plan.id }, title: "Ship the CSV export", expiresAt: null },
    ]);
    expect(h.headline.decisionsWaiting).toBe(6);
    expect(kpi(h, "WAITING_ON_YOU").value).toBe(6);
    expect(text(h)).toBe("6 things are ready for you: a push for #42, 1 plan and 4 more.");
    expect(emphasised(h)).toEqual(["a push for #42", "1 plan"]);
    // jobs, approvals, tests (the approvals' verification), plans, drafts, opportunities; no deep dive finished
    expect(h.headline.sources).toBe(6);

    // The push is the newest once the rest is decided; a push opens through its run.
    await db.update(jobDrafts).set({ status: "DISCARDED" }).where(eq(jobDrafts.projectId, projectId));
    await db.update(plans).set({ status: "DENIED" }).where(eq(plans.id, plan.id));
    const h2 = await at(projectId);
    expect(h2.decisions.top).toEqual([
      { ref: { kind: "OPPORTUNITY", id: opp.id }, title: "Payout matching", expiresAt: null },
      {
        ref: { kind: "JOB", id: pushJob.id },
        title: "#42 Fix cart totals",
        expiresAt: push.expiresAt.toISOString(),
      },
    ]);
    expect(text(h2)).toBe("2 things are ready for you: a push for #42 and 1 opportunity.");
    expect(emphasised(h2)).toEqual(["a push for #42", "1 opportunity"]);
  });

  it("open incidents come first in Waiting on you and count as decisions; resolved, acknowledged and other projects' do not", async () => {
    const projectId = await newProject();
    const other = await newProject();
    const seedIncident = async (
      pid: string,
      o: { status?: "OPEN" | "ACKNOWLEDGED" | "RESOLVED"; severity?: "SEV1" | "SEV2" | "SEV3" },
    ) => {
      const [app] = await db
        .insert(monitoredApps)
        .values({
          ...scopeOf(pid),
          name: "checkout-api",
          environment: "PROD",
          healthUrl: "https://example.test/health",
          intervalSeconds: 60,
          timeoutMs: 2000,
          failureThreshold: 1,
          createdBy: "test",
          nextCheckAt: new Date("2100-01-01T00:00:00Z"),
        })
        .returning();
      const [i] = await db
        .insert(incidents)
        .values({
          ...scopeOf(pid),
          appId: app!.id,
          fingerprint: `fp-${randomUUID()}`,
          severity: o.severity ?? "SEV2",
          status: o.status ?? "OPEN",
          title: "checkout-api (PROD) health check failing",
          openedAt: new Date(NOW.getTime() - 60 * MIN),
        })
        .returning();
      return i!;
    };
    const open = await seedIncident(projectId, { severity: "SEV1" });
    await seedIncident(projectId, { status: "RESOLVED" });
    await seedIncident(projectId, { status: "ACKNOWLEDGED" });
    await seedIncident(other, {});
    // A newer opportunity still sorts after the (older) incident.
    const opp = await seedOpportunity(projectId, { title: "Payout matching", createdAt: NOW });

    const h = await at(projectId);
    expect(h.decisions).toMatchObject({ incidents: 1, opportunities: 1 });
    expect(h.decisions.top).toEqual([
      {
        ref: { kind: "INCIDENT", id: open.id },
        title: "SEV1 · checkout-api (PROD) health check failing",
        expiresAt: null,
      },
      { ref: { kind: "OPPORTUNITY", id: opp.id }, title: "Payout matching", expiresAt: null },
    ]);
    expect(h.headline.decisionsWaiting).toBe(2);
    expect(kpi(h, "WAITING_ON_YOU").value).toBe(2);
    expect(text(h)).toBe("2 things are ready for you: 1 incident open and 1 opportunity.");

    // The other project sees only its own; the route serializes the same contract.
    const ho = await at(other);
    expect(ho.decisions.incidents).toBe(1);
    expect(ho.decisions.top.map((x) => x.ref.id)).not.toContain(open.id);
    expect((await home(projectId)).decisions.top[0]!.ref.kind).toBe("INCIDENT");

    // Resolving it removes it.
    await db.update(incidents).set({ status: "RESOLVED" }).where(eq(incidents.id, open.id));
    expect((await at(projectId)).decisions.incidents).toBe(0);
  });

  it("headline without decisions: runs today with passing tests, or no runs yet today", async () => {
    const projectId = await newProject();
    const old = await seedJob({ projectId, createdAt: utc("2026-03-07T10:00:00") });
    await seedTests(old.id, 1, "passed");
    let h = await at(projectId);
    expect(text(h)).toBe("Nothing needs you right now. No runs yet today.");
    expect(emphasised(h)).toEqual(["No runs yet today"]);

    const today = (m: number) => utc(`2026-03-10T0${m}:00:00`);
    const a = await seedJob({ projectId, createdAt: today(1) });
    await seedTests(a.id, 1, "passed");
    const b = await seedJob({ projectId, createdAt: today(2) });
    await seedApproval(b, "APPROVED", { tests: "passed" });
    await seedJob({ projectId, createdAt: today(3), status: "FAILED" });
    h = await at(projectId);
    expect(text(h)).toBe("Nothing needs you right now. 3 runs today, 2 with passing tests.");
    expect(emphasised(h)).toEqual(["3 runs today"]);

    const solo = await newProject();
    await seedJob({ projectId: solo, createdAt: today(1), status: "FAILED" });
    expect(text(await at(solo))).toBe("Nothing needs you right now. 1 run today.");

    const two = await newProject();
    for (const n of [5, 6]) {
      const j = await seedJob({
        projectId: two,
        status: "AWAITING_APPROVAL",
        issueNumber: n,
        createdAt: today(1),
      });
      await seedApproval(j, "PENDING");
    }
    expect(text(await at(two))).toBe("2 things are ready for you: 2 pushes.");
  });

  it("results over the last 7 local days, from GitHub-confirmed and finished records only", async () => {
    const projectId = await newProject();
    const inWeek = utc("2026-03-05T10:00:00");
    const before = utc("2026-03-03T18:29:00"); // 23:59 on 3 March

    const j = await seedJob({ projectId, createdAt: before });
    await seedApproval(j, "EXECUTED", { pr: 1, decidedAt: inWeek }); // decided this week: counts
    await seedApproval(j, "EXECUTED", { pr: 2, decidedAt: before });
    await seedApproval(j, "FAILED", { pr: 3, decidedAt: inWeek }); // a result on a failed push is no PR
    await seedApproval(j, "EXECUTED", { decidedAt: inWeek }); // no GitHub result

    await seedDraft(projectId, { status: "STARTED", createdIssueNumber: 50, updatedAt: inWeek });
    await seedDraft(projectId, { status: "STARTED", createdIssueNumber: 51, updatedAt: before });
    await seedDraft(projectId, { status: "STARTED", updatedAt: inWeek }); // an existing issue: nothing created
    await seedOpportunity(projectId, { status: "ISSUE_CREATED", issue: 60, updatedAt: inWeek });
    await seedOpportunity(projectId, { status: "ISSUE_CREATED", issue: 61, updatedAt: before });

    await seedDive(projectId, { status: "COMPLETED", finishedAt: inWeek });
    await seedDive(projectId, { status: "COMPLETED", finishedAt: before });
    await seedDive(projectId, { status: "FAILED", finishedAt: inWeek });

    const h = await at(projectId);
    expect(h.results).toEqual([
      { kind: "PULL_REQUESTS", value: 1, label: "draft PRs GitHub confirmed", source: "GitHub · 7 days" },
      { kind: "ISSUES_CREATED", value: 2, label: "issues GitHub confirmed", source: "GitHub · 7 days" },
      {
        kind: "TESTS_VERIFIED",
        value: 0,
        label: "runs with passing tests",
        source: "NEXUS test runs · 7 days",
      },
      { kind: "DEEP_DIVES", value: 1, label: "deep dives completed", source: "research · 7 days" },
      { kind: "AI_SPEND", value: 0, label: "AI spend, estimated", source: "NEXUS estimates · 7 days" },
    ]);
  });

  it("a decoy project never leaks in; All covers exactly the owner's projects", async () => {
    const a = await newProject();
    const b = await newProject();
    const inA = await seedJob({ projectId: a, status: "RUNNING", agent: "QA", createdAt: NOW });
    await seedApproval(
      await seedJob({ projectId: b, status: "AWAITING_APPROVAL", createdAt: NOW }),
      "PENDING",
    );
    await seedPlan(b);
    await seedOpportunity(b);
    await seedSpend(scopeOf(b), "JOB_DRAFT", 1, 1, NOW);

    const ha = await at(a);
    expect(ha.decisions).toMatchObject({ approvals: 0, plans: 0, jobDrafts: 0, opportunities: 0, top: [] });
    expect(ha.execution.map((e) => e.jobId)).toEqual([inA.id]);
    expect(agent(ha, "DEVELOPER").state).toBe("IDLE");
    expect(agent(ha, "DEVELOPER").costTodayUsd).toBe(0);
    expect(result(ha, "AI_SPEND")).toBe(0);

    const hb = await at(b);
    expect(hb.decisions).toMatchObject({ approvals: 1, plans: 1, opportunities: 1 });
    expect(agent(hb, "QA").state).toBe("IDLE");

    // All = the sum of the owner's projects; the decoy owner's running job, approval, plan, draft, opportunity
    // and $50 spend are invisible.
    const ws = (await get("/v1/workspaces")).json<WorkspaceList>();
    const mine = ws.items.flatMap((w) => w.projects.map((p) => p.id));
    const all = await at();
    const each = await Promise.all(mine.map((p) => at(p)));
    const total = (f: (h: HomeSummary) => number) => each.reduce((n, h) => n + f(h), 0);
    for (const k of ["approvals", "plans", "jobDrafts", "opportunities", "incidents"] as const)
      expect(all.decisions[k], k).toBe(total((h) => h.decisions[k]));
    for (const kind of HomeResultKind.options)
      expect(result(all, kind), kind).toBeCloseTo(
        total((h) => result(h, kind)),
        6,
      );
    expect(kpi(all, "RUNS_TODAY").value).toBe(total((h) => kpi(h, "RUNS_TODAY").value!));
    expect(all.execution.map((e) => e.jobId)).not.toContain(decoyOwnerJob);
    expect(agent(all, "FINANCIAL_ANALYST").state).toBe("IDLE");
    expect(agent(all, "AI_RESEARCHER").costTodayUsd).toBeLessThan(50);
    const { rows } = await pool.query(
      `select count(*)::int as n from jobs where initiator_id = $1 and status = 'RUNNING'`,
      [decoyOwner],
    );
    expect(rows[0].n).toBe(1);

    // Through the route as well (its serializer checks the contract).
    const viaRoute = await home();
    expect(viaRoute.execution.map((e) => e.jobId)).not.toContain(decoyOwnerJob);
    expect(agent(viaRoute, "FINANCIAL_ANALYST").state).toBe("IDLE");
    expect((await home(b)).decisions.approvals).toBe(1);
  });
});
