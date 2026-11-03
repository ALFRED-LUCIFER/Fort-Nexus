import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  JOB_STATUS_GROUPS,
  JobStatus,
  JobStatusGroup,
  type AgentKey,
  type AgentPerformance,
  type AgentPerformanceRow,
  type ApprovalStatus,
  type JobHistoryList,
  type Verification,
  type WorkspaceList,
} from "@nexus/contracts";
import { createDb, type Db } from "../src/db/index.ts";
import { aiSpend, approvals, jobs, projects, runEvents, user, workspaces } from "../src/db/schema.ts";
import { localDate } from "../src/research/schedule.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// Jobs wave A: GET /v1/jobs/history and GET /v1/agents/performance over seeded source records, in a non-UTC owner
// timezone (Asia/Kolkata, UTC+5:30, no DST), with a decoy project and a decoy owner (NFR-CNV-05).

const TZ = "Asia/Kolkata";
const OFFSET_MS = 5.5 * 3_600_000;
const MIN = 60_000;

let t: TestApp;
let db: Db;
let pool: pg.Pool;
let cookie: string;
let ownerId: string;
let devWorkspace: string;
let decoyOwnerProject: string;
let decoyOwnerJob: string;

const get = (url: string, headers: Record<string, string> = { cookie }) =>
  t.app.inject({ method: "GET", url, headers });
const qs = (q: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(q).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
  ).toString();
async function history(q: Record<string, string | number | undefined> = {}) {
  const res = await get(`/v1/jobs/history?${qs({ limit: 100, ...q })}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<JobHistoryList>();
}
const ids = async (q: Record<string, string | number | undefined>) =>
  (await history(q)).items.map((i) => i.job.id);
async function performance(q: Record<string, string | number | undefined> = {}) {
  const res = await get(`/v1/agents/performance?${qs(q)}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<AgentPerformance>();
}
const row = (p: AgentPerformance, agent: AgentKey) => p.items.find((r) => r.agent === agent)!;

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

const REPOS = { web: { id: "101", fullName: "acme/web" }, api: { id: "202", fullName: "acme/api" } };

type Seed = {
  projectId: string;
  initiatorId?: string;
  repo?: (typeof REPOS)[keyof typeof REPOS];
  agent?: AgentKey;
  status?: JobStatus;
  createdAt?: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  estimatedCostUsd?: number | null;
};
async function seedJob(s: Seed) {
  const projectId = s.projectId;
  const request = s.repo
    ? {
        jobType: "DEV_ISSUE_TO_PR" as const,
        repositoryId: s.repo.id,
        issueNumber: 7,
        projectId,
        budget: { maxWallClockMinutes: 45, maxTurns: 60, maxCostUsd: 5 },
      }
    : { jobType: "RUNNER_DIAGNOSTIC" as const, preset: "host-info" as const, projectId };
  const [job] = await db
    .insert(jobs)
    .values({
      initiatorId: s.initiatorId ?? ownerId,
      projectId,
      jobType: request.jobType,
      agent: s.agent ?? (s.repo ? "DEVELOPER" : "DEVOPS"),
      status: s.status ?? "COMPLETED",
      riskTier: s.repo ? "R1" : "R0",
      request,
      requestHash: randomBytes(32).toString("hex"),
      idempotencyKey: `seed-${randomUUID()}`,
      issueSnapshot: s.repo
        ? {
            repositoryId: s.repo.id,
            fullName: s.repo.fullName,
            issueNumber: 7,
            title: "Fix cart totals",
            body: "",
            acceptanceCriteria: [],
            htmlUrl: `https://github.com/${s.repo.fullName}/issues/7`,
            issueUpdatedAt: "2026-10-01T00:00:00.000Z",
            baseBranch: "main",
            baseSha: "a".repeat(40),
          }
        : null,
      estimatedCostUsd: s.estimatedCostUsd ?? null,
      startedAt: s.startedAt ?? null,
      finishedAt: s.finishedAt ?? null,
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
  job: { id: string; projectId: string; createdAt: Date },
  status: ApprovalStatus,
  o: { afterMinutes?: number; tests?: Verification["status"]; pr?: number } = {},
) {
  const createdAt = new Date(job.createdAt.getTime() + (o.afterMinutes ?? 5) * MIN);
  const [a] = await db
    .insert(approvals)
    .values({
      jobId: job.id,
      projectId: job.projectId,
      riskTier: "R2",
      status,
      action: {
        type: "github.push_draft_pr",
        repositoryId: REPOS.web.id,
        repositoryFullName: REPOS.web.fullName,
        issueNumber: 7,
        baseBranch: "main",
        baseSha: "a".repeat(40),
        headBranch: `nexus/7-${job.id.slice(0, 8)}`,
        title: "Fix cart totals",
        body: "",
        changesetSha256: "b".repeat(64),
        files: [{ path: "src/cart.ts", change: "modified" }],
        stats: { added: 1, removed: 1 },
        verification: verification(o.tests ?? "passed"),
      },
      actionHash: randomBytes(32).toString("hex"),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 60 * MIN),
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

const seedTestEvent = (jobId: string, sequence: number, payload: Record<string, unknown>) =>
  db.insert(runEvents).values({
    jobId,
    sequence,
    occurredAt: new Date(),
    type: "test.completed",
    stage: "test",
    actor: "runner:seed",
    payload,
  });

const seedSpend = (
  scope: { workspaceId: string; projectId: string },
  source: "DEEP_DIVE" | "JOB_DRAFT",
  reservedUsd: number,
  costUsd: number | null,
  createdAt = new Date(),
) => db.insert(aiSpend).values({ ...scope, source, sourceId: randomUUID(), reservedUsd, costUsd, createdAt });

/** Local midnight of `date` in TZ, as an instant. */
const midnight = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - OFFSET_MS);

beforeAll(async () => {
  t = await createTestApp({ OWNER_TIMEZONE: TZ });
  ({ db, pool } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  const ws = (await get("/v1/workspaces")).json<WorkspaceList>();
  devWorkspace = ws.items.find((w) => w.mode === "DEV")!.id;
  ownerId = (await pool.query(`select owner_id from workspaces where id = $1`, [devWorkspace])).rows[0]
    .owner_id as string;

  // Another owner's project, job, approval and spend: never listed, counted or reachable.
  const decoyOwner = `decoy-${randomUUID()}`;
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
    repo: REPOS.web,
    agent: "FINANCIAL_ANALYST",
    estimatedCostUsd: 40,
  });
  decoyOwnerJob = dj.id;
  await seedApproval(dj, "EXECUTED", { pr: 99 });
  await seedSpend({ workspaceId: dws!.id, projectId: dp!.id }, "DEEP_DIVE", 50, 50);
});
afterAll(async () => {
  await t?.app.close();
  await pool?.end();
});

describe("auth and validation", () => {
  it("401 without a session on both endpoints", async () => {
    for (const url of ["/v1/jobs/history", "/v1/agents/performance"]) {
      const res = await get(url, {});
      expect(res.statusCode).toBe(401);
    }
  });

  it("404 for an unknown project or another owner's; 400 for bad filters", async () => {
    for (const projectId of [randomUUID(), decoyOwnerProject]) {
      expect((await get(`/v1/jobs/history?projectId=${projectId}`)).statusCode).toBe(404);
      expect((await get(`/v1/agents/performance?projectId=${projectId}`)).statusCode).toBe(404);
    }
    for (const q of ["status=DONE", "agent=ROBOT", "repositoryId=abc", "from=2026-13-01", "limit=0"])
      expect((await get(`/v1/jobs/history?${q}`)).statusCode, q).toBe(400);
    expect((await get(`/v1/jobs/history?from=2026-03-02&to=2026-03-01`)).statusCode).toBe(400);
    expect((await get(`/v1/agents/performance?days=14`)).statusCode).toBe(400);
  });
});

describe("GET /v1/jobs/history", () => {
  it("items: repository from the snapshot, duration, tests from NEXUS's verification, PR only when EXECUTED", async () => {
    const projectId = await newProject();
    const t0 = new Date("2026-10-01T10:00:00Z");
    const base = { projectId, repo: REPOS.web };

    const done = await seedJob({ ...base, startedAt: t0, finishedAt: new Date(t0.getTime() + 90_000) });
    await seedTestEvent(done.id, 1, verification("failed")); // the approval's copy wins
    const merged = await seedApproval(done, "EXECUTED", { tests: "passed", pr: 12 });

    const running = await seedJob({ ...base, status: "VERIFYING", startedAt: t0 });
    await seedTestEvent(running.id, 1, verification("failed"));
    await seedTestEvent(running.id, 2, verification("error")); // the latest event wins

    const bogus = await seedJob({ ...base, status: "VERIFYING" });
    await seedTestEvent(bogus.id, 1, { status: "all green" }); // not a Verification status

    const approved = await seedJob({ ...base, status: "AWAITING_APPROVAL" });
    const approvedA = await seedApproval(approved, "APPROVED", { tests: "not_configured" });

    const failedPush = await seedJob({ ...base, status: "AWAITING_APPROVAL" });
    await seedApproval(failedPush, "FAILED", { pr: 13 }); // a result on anything but EXECUTED is never a PR

    // An earlier EXECUTED approval keeps its PR; the latest approval is the newer pending one.
    const twice = await seedJob({ ...base, status: "AWAITING_APPROVAL" });
    await seedApproval(twice, "EXECUTED", { afterMinutes: 5, tests: "passed", pr: 14 });
    const newer = await seedApproval(twice, "PENDING", { afterMinutes: 9, tests: "failed" });

    const diag = await seedJob({ projectId, status: "RUNNING", startedAt: t0 });

    const items = new Map((await history({ projectId })).items.map((i) => [i.job.id, i]));
    expect(items.size).toBe(7);
    expect(items.get(done.id)).toMatchObject({
      job: { id: done.id, projectId, agent: "DEVELOPER", issue: { fullName: "acme/web", issueNumber: 7 } },
      repositoryId: "101",
      repositoryFullName: "acme/web",
      durationMs: 90_000,
      tests: "passed",
      pullRequest: { number: 12, url: "https://github.com/acme/web/pull/12" },
      approval: { id: merged.id, status: "EXECUTED" },
    });
    expect(items.get(running.id)).toMatchObject({ durationMs: null, tests: "error", approval: null });
    expect(items.get(bogus.id)!.tests).toBeNull();
    expect(items.get(approved.id)).toMatchObject({
      tests: "not_configured",
      pullRequest: null,
      approval: { id: approvedA.id, status: "APPROVED" },
    });
    expect(items.get(failedPush.id)).toMatchObject({ pullRequest: null, approval: { status: "FAILED" } });
    expect(items.get(twice.id)).toMatchObject({
      tests: "failed",
      pullRequest: { number: 14 },
      approval: { id: newer.id, status: "PENDING" },
    });
    expect(items.get(diag.id)).toMatchObject({
      job: { jobType: "RUNNER_DIAGNOSTIC", agent: "DEVOPS", issue: null },
      repositoryId: null,
      repositoryFullName: null,
      durationMs: null,
      tests: null,
      pullRequest: null,
      approval: null,
    });
  });

  it("filters by repository, agent and status group; each status is in exactly one group", async () => {
    const projectId = await newProject();
    const web = await seedJob({ projectId, repo: REPOS.web });
    const api = await seedJob({ projectId, repo: REPOS.api });
    const qa = await seedJob({ projectId, repo: REPOS.api, agent: "QA" });
    const diag = await seedJob({ projectId });
    expect(await ids({ projectId, repositoryId: "101" })).toEqual([web.id]);
    expect(await ids({ projectId, repositoryId: "202" })).toEqual([qa.id, api.id]);
    expect(await ids({ projectId, agent: "QA" })).toEqual([qa.id]);
    expect(await ids({ projectId, agent: "DEVOPS" })).toEqual([diag.id]);
    expect(await ids({ projectId, repositoryId: "202", agent: "DEVELOPER" })).toEqual([api.id]);

    const statuses = await newProject();
    const byStatus = new Map<string, JobStatus>();
    for (const status of JobStatus.options)
      byStatus.set((await seedJob({ projectId: statuses, status })).id, status);
    const seen: JobStatus[] = [];
    for (const group of JobStatusGroup.options) {
      const got = (await ids({ projectId: statuses, status: group })).map((id) => byStatus.get(id)!);
      expect(got.toSorted(), group).toEqual([...JOB_STATUS_GROUPS[group]].sort());
      seen.push(...got);
    }
    expect(seen.toSorted()).toEqual([...JobStatus.options].sort());
  });

  it("from / to are inclusive local dates in the owner's timezone", async () => {
    const projectId = await newProject();
    const at = (iso: string) => seedJob({ projectId, createdAt: new Date(iso) });
    // Asia/Kolkata: 1 March starts at 28 Feb 18:30 UTC and ends at 1 March 18:30 UTC.
    const lateFeb28 = await at("2026-02-28T18:29:00Z");
    const earlyMar1 = await at("2026-02-28T18:31:00Z");
    const lateMar1 = await at("2026-03-01T18:29:00Z");
    const earlyMar2 = await at("2026-03-01T18:31:00Z");
    expect(await ids({ projectId, from: "2026-03-01", to: "2026-03-01" })).toEqual([
      lateMar1.id,
      earlyMar1.id,
    ]);
    expect(await ids({ projectId, from: "2026-03-01" })).toEqual([earlyMar2.id, lateMar1.id, earlyMar1.id]);
    expect(await ids({ projectId, to: "2026-03-01" })).toEqual([lateMar1.id, earlyMar1.id, lateFeb28.id]);
    expect(await ids({ projectId, from: "2026-03-02", to: "2026-03-02" })).toEqual([earlyMar2.id]);
  });

  it("pages newest first by id with a cursor, without gaps or repeats", async () => {
    const projectId = await newProject();
    const seeded: string[] = [];
    for (let i = 0; i < 5; i++) seeded.unshift((await seedJob({ projectId })).id);
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await history({ projectId, limit: 2, cursor });
      pages.push(page.items.map((i) => i.job.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toEqual(seeded);
  });

  it("a decoy project never leaks into a project; All lists every own project and never another owner's", async () => {
    const a = await newProject();
    const b = await newProject();
    const inA = await seedJob({ projectId: a, repo: REPOS.web });
    const inB = await seedJob({ projectId: b, repo: REPOS.web });
    expect(await ids({ projectId: a })).toEqual([inA.id]);
    expect(await ids({ projectId: b, repositoryId: "101" })).toEqual([inB.id]);

    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await history({ cursor });
      all.push(...page.items.map((i) => i.job.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(all).toEqual(expect.arrayContaining([inA.id, inB.id]));
    expect(all).not.toContain(decoyOwnerJob);
    expect(await ids({ agent: "FINANCIAL_ANALYST" })).toEqual([]);
    const { rows } = await pool.query(`select count(*)::int as n from jobs where initiator_id = $1`, [
      ownerId,
    ]);
    expect(all).toHaveLength(rows[0].n as number);
  });
});

describe("GET /v1/agents/performance", () => {
  const zero = (agent: AgentKey): AgentPerformanceRow => ({
    agent,
    jobs: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    successRate: null,
    pullRequests: 0,
    costUsd: 0,
    costPerPullRequestUsd: null,
    medianMinutesToReviewReady: null,
    approvals: { approved: 0, denied: 0, expired: 0, pending: 0 },
  });

  it("per-agent numbers from source records on a seeded mix, every agent in order, zeros included", async () => {
    const now = new Date();
    const to = localDate(now, TZ);
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    const start = midnight(from);
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

    const projectId = await newProject();
    const decoy = await newProject();
    const scope = { workspaceId: devWorkspace, projectId };
    const dev = (status: JobStatus, createdAt: Date, cost: number | null = null) =>
      seedJob({ projectId, repo: REPOS.web, status, createdAt, estimatedCostUsd: cost });

    const d1 = await dev("COMPLETED", hoursAgo(5), 1.5);
    await seedApproval(d1, "EXECUTED", { afterMinutes: 30, pr: 21 });
    const d2 = await dev("FAILED", hoursAgo(5), 0.5);
    await seedApproval(d2, "DENIED", { afterMinutes: 10 });
    await dev("REJECTED", hoursAgo(4));
    const d4 = await dev("CANCELLED", hoursAgo(4));
    await seedApproval(d4, "EXPIRED", { afterMinutes: 20 });
    const d5 = await dev("AWAITING_APPROVAL", hoursAgo(3));
    await seedApproval(d5, "FAILED", { afterMinutes: 40 }); // the owner said yes; the push failed
    await seedApproval(d5, "PENDING", { afterMinutes: 60 });
    await dev("RUNNING", hoursAgo(2), 0.25);
    await dev("QUEUED", new Date(start.getTime() + MIN)); // just inside the window
    const old = await dev("COMPLETED", new Date(start.getTime() - MIN), 9); // just before it
    await seedApproval(old, "EXECUTED", { pr: 22 });

    await seedSpend(scope, "JOB_DRAFT", 0.25, 0.1, hoursAgo(1));
    await seedSpend(scope, "JOB_DRAFT", 0.25, null, hoursAgo(1)); // unsettled: the reservation counts
    await seedSpend(scope, "JOB_DRAFT", 5, 5, new Date(start.getTime() - MIN));
    await seedSpend(scope, "DEEP_DIVE", 1, 0.4, hoursAgo(1));

    await seedJob({ projectId, status: "COMPLETED", createdAt: hoursAgo(1) });
    await seedJob({ projectId, status: "CANCELLED", createdAt: hoursAgo(1) });
    await seedJob({ projectId, repo: REPOS.web, agent: "QA", status: "FAILED", createdAt: hoursAgo(1) });

    // The decoy project's records count only for itself.
    const dj = await seedJob({
      projectId: decoy,
      repo: REPOS.web,
      estimatedCostUsd: 3,
      createdAt: hoursAgo(1),
    });
    await seedApproval(dj, "EXECUTED", { pr: 23 });
    await seedSpend({ workspaceId: devWorkspace, projectId: decoy }, "JOB_DRAFT", 2, 2, hoursAgo(1));

    const p = await performance({ projectId });
    expect(p).toMatchObject({ days: 7, from, to });
    expect(Date.parse(p.asOf)).toBeGreaterThanOrEqual(now.getTime());
    expect(p.items.map((r) => r.agent)).toEqual([
      "CHIEF_OF_STAFF",
      "DEVELOPER",
      "QA",
      "DEVOPS",
      "PRODUCT",
      "AI_RESEARCHER",
      "FINANCIAL_ANALYST",
    ]);
    const developer = row(p, "DEVELOPER");
    expect(developer).toMatchObject({
      jobs: 7,
      succeeded: 1,
      failed: 2,
      cancelled: 1,
      pullRequests: 1,
      approvals: { approved: 2, denied: 1, expired: 1, pending: 1 },
      medianMinutesToReviewReady: 25, // first approvals at 10, 20, 30 and 40 minutes
    });
    expect(developer.successRate).toBeCloseTo(1 / 3, 9);
    expect(developer.costUsd).toBeCloseTo(2.6, 6); // 1.5 + 0.5 + 0.25 jobs, 0.1 + 0.25 drafts
    expect(developer.costPerPullRequestUsd).toBeCloseTo(2.6, 6);
    expect(row(p, "AI_RESEARCHER")).toEqual({ ...zero("AI_RESEARCHER"), costUsd: 0.4 });
    expect(row(p, "DEVOPS")).toMatchObject({ jobs: 2, succeeded: 1, cancelled: 1, successRate: 1 });
    expect(row(p, "QA")).toMatchObject({ jobs: 1, failed: 1, successRate: 0, costPerPullRequestUsd: null });
    for (const agent of ["CHIEF_OF_STAFF", "PRODUCT", "FINANCIAL_ANALYST"] as const)
      expect(row(p, agent)).toEqual(zero(agent));

    const d = await performance({ projectId: decoy });
    expect(row(d, "DEVELOPER")).toMatchObject({
      jobs: 1,
      pullRequests: 1,
      costUsd: 5,
      costPerPullRequestUsd: 5,
    });
    expect(row(d, "AI_RESEARCHER").costUsd).toBe(0);

    const month = await performance({ projectId, days: 30 });
    expect(month.days).toBe(30);
    expect(row(month, "DEVELOPER")).toMatchObject({ jobs: 8, pullRequests: 2 });
    expect(row(month, "DEVELOPER").costUsd).toBeCloseTo(2.6 + 9 + 5, 6);
  });

  it("All aggregates exactly the owner's projects and never another owner's", async () => {
    const ws = (await get("/v1/workspaces")).json<WorkspaceList>();
    const mine = ws.items.flatMap((w) => w.projects.map((p) => p.id));
    const all = await performance({ days: 30 });
    const each = await Promise.all(mine.map((projectId) => performance({ projectId, days: 30 })));
    for (const agent of all.items.map((r) => r.agent)) {
      const sum = (f: (r: AgentPerformanceRow) => number) => each.reduce((n, p) => n + f(row(p, agent)), 0);
      const r = row(all, agent);
      expect(r.jobs, agent).toBe(sum((x) => x.jobs));
      expect(r.pullRequests, agent).toBe(sum((x) => x.pullRequests));
      expect(r.approvals.approved, agent).toBe(sum((x) => x.approvals.approved));
      expect(r.costUsd, agent).toBeCloseTo(
        sum((x) => x.costUsd),
        6,
      );
    }
    expect(row(all, "DEVELOPER").jobs).toBeGreaterThan(0);
    // The decoy owner's FINANCIAL_ANALYST job and $50 deep dive are invisible.
    expect(row(all, "FINANCIAL_ANALYST")).toEqual(zero("FINANCIAL_ANALYST"));
    expect(row(all, "AI_RESEARCHER").costUsd).toBeLessThan(50);
  });
});
