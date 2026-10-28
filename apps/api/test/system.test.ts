import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { IssueSnapshot, Job, LeaseResponse, SystemControls } from "@nexus/contracts";
import { buildApp } from "../src/app.ts";
import { createDb, type Db } from "../src/db/index.ts";
import { approvals, jobs, projectRepositories } from "../src/db/schema.ts";
import { createJob } from "../src/jobs.ts";
import { getSystemControls, leaseRequest } from "../src/system.ts";
import { createTestApp, homeProjectId, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// projectId is the owner's "home" project, filled in once the owner exists (beforeAll).
const NODE_VERSION = { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version", projectId: "" };
const issueJob = (maxCostUsd: number) => ({
  jobType: "DEV_ISSUE_TO_PR" as const,
  projectId: NODE_VERSION.projectId,
  repositoryId: "101",
  issueNumber: 42,
  budget: { maxWallClockMinutes: 45, maxTurns: 60, maxCostUsd },
});
const SNAPSHOT: IssueSnapshot = {
  repositoryId: "101",
  fullName: "acme/web",
  issueNumber: 42,
  title: "Fix cart totals",
  body: "",
  acceptanceCriteria: [],
  htmlUrl: "https://github.com/acme/web/issues/42",
  issueUpdatedAt: "2026-10-27T10:00:00.000Z",
  baseBranch: "main",
  baseSha: "a".repeat(40),
};

let t: TestApp;
let app: FastifyInstance;
let db: Db;
let sql: pg.Pool;
let cookie: string;
let ownerId: string;

type Method = "GET" | "POST" | "PUT" | "DELETE";
const owner = (method: Method, url: string, body?: unknown, c: string = cookie, a: FastifyInstance = app) =>
  a.inject({
    method,
    url,
    headers: { cookie: c, origin: t.config.publicOrigin },
    ...(body === undefined ? {} : { payload: body as object }),
  });
const runner = (token: string, url: string, body?: unknown) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });
const create = (body: unknown = NODE_VERSION) =>
  app.inject({
    method: "POST",
    url: "/v1/jobs",
    headers: { cookie, origin: t.config.publicOrigin, "idempotency-key": randomUUID() },
    payload: body as object,
  });
const stop = (engaged: boolean) => owner("PUT", "/v1/system/emergency-stop", { engaged });
const system = async () => (await owner("GET", "/v1/system")).json() as SystemControls;
const audits = async (action: string) =>
  (await sql.query(`select * from audit_records where action = $1 order by occurred_at`, [action])).rows;
const ev = (type: string, payload: Record<string, unknown> = {}) => ({
  occurredAt: new Date().toISOString(),
  type,
  payload,
});

async function pairRunner() {
  const pair = await owner("POST", "/v1/runners/pair");
  const reg = await app.inject({
    method: "POST",
    url: "/v1/runner/register",
    payload: { code: pair.json().code, name: "home", os: "darwin", version: "0.0.0" },
  });
  return reg.json() as { runnerId: string; token: string };
}

async function leaseRunning(token: string) {
  const res = await runner(token, "/v1/runner/lease");
  expect(res.statusCode).toBe(200);
  const l = res.json() as LeaseResponse;
  const append = (body: Record<string, unknown>) =>
    runner(token, `/v1/runner/jobs/${l.jobId}/events`, {
      batchId: randomUUID(),
      fencingToken: l.fencingToken,
      events: [],
      ...body,
    });
  await append({ transition: { to: "RUNNING" } });
  return { l, append };
}

/** An issue job without GitHub: createJob with a pinned snapshot, as the route does after pinning. */
const createIssueJob = (maxCostUsd: number) =>
  createJob(db, {
    ownerId,
    idempotencyKey: randomUUID(),
    body: issueJob(maxCostUsd),
    correlationId: randomUUID(),
    timezone: t.config.ownerTimezone,
    pinIssue: async () => SNAPSHOT,
  });

const leasedBudget = async (j: Awaited<ReturnType<typeof createIssueJob>>) => {
  const r = await leaseRequest(db, j, "Asia/Dubai");
  return r?.jobType === "DEV_ISSUE_TO_PR" ? r.budget : r;
};

/** Today's spend = `usd`, booked on one fresh job created now. */
async function spendToday(usd: number) {
  await sql.query(`update jobs set estimated_cost_usd = null`);
  const id = (await create()).json().jobId as string;
  await sql.query(`update jobs set estimated_cost_usd = $2, status = 'COMPLETED' where id = $1`, [id, usd]);
}

beforeAll(async () => {
  t = await createTestApp({ RUNNER_LEASE_POLL_MS: "300" });
  app = t.app;
  ({ db, pool: sql } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  ownerId = (await owner("GET", "/v1/me")).json().id;
  NODE_VERSION.projectId = await homeProjectId(t, cookie);
  await db.insert(projectRepositories).values({ projectId: NODE_VERSION.projectId, repositoryId: "101" });
});

afterAll(async () => {
  await app?.close();
  await sql?.end();
});

// Leases take the oldest eligible job: start every test released, at the default cap, with no queue.
beforeEach(async () => {
  await stop(false);
  await sql.query(`update system_controls set daily_budget_usd = 20`);
  await sql.query(`update jobs set status = 'CANCELLED' where status = 'QUEUED'`);
});

describe("emergency stop", () => {
  it("cancels queued work, stops active runs via heartbeat, blocks leases and creates, and releases explicitly", async () => {
    expect((await system()).emergencyStop).toEqual({ engaged: false, changedAt: null });
    const { token } = await pairRunner();
    await create();
    const { l: active, append } = await leaseRunning(token);
    const queued = (await create()).json().jobId as string;

    const engaged = await stop(true);
    expect(engaged.statusCode).toBe(200);
    expect((engaged.json() as SystemControls).emergencyStop.engaged).toBe(true);

    const cancelled = await db.select().from(jobs).where(eq(jobs.id, queued));
    expect(cancelled[0]!.status).toBe("CANCELLED");
    const last = await sql.query(`select type, payload from run_events where job_id = $1 order by sequence`, [
      queued,
    ]);
    expect(last.rows.map((r) => r.type).slice(-2)).toEqual(["job.cancelled", "job.state.changed"]);
    expect(last.rows.at(-2).payload).toEqual({ terminated: false, reason: "EMERGENCY_STOP" });

    const hb = await runner(token, "/v1/runner/heartbeat", { activeJobIds: [active.jobId] });
    expect(hb.json()).toEqual({ cancelJobIds: [active.jobId] });

    const refused = await create();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("EMERGENCY_STOP");
    const issueRefused = await create(issueJob(1)); // refused before GitHub is ever asked
    expect(issueRefused.json().error.code).toBe("EMERGENCY_STOP");
    expect((await runner(token, "/v1/runner/lease")).statusCode).toBe(204);

    // Engaging twice changes nothing and records nothing.
    expect((await stop(true)).statusCode).toBe(200);
    const [engage, ...more] = await audits("system.emergency_stop.engage");
    expect(more).toHaveLength(0);
    expect(engage).toMatchObject({
      actor: `user:${ownerId}`,
      resource_type: "system",
      correlation_id: engaged.headers["x-request-id"],
      metadata: { cancelledJobIds: [queued], cancelRequestedJobIds: [active.jobId] },
    });
    const jobAudit = await sql.query(
      `select action, metadata from audit_records where resource_id = $1 and metadata->>'reason' = 'EMERGENCY_STOP'`,
      [queued],
    );
    expect(jobAudit.rows).toEqual([{ action: "job.cancel", metadata: { reason: "EMERGENCY_STOP" } }]);

    // The runner confirms; only then is the run cancelled.
    const confirmed = await append({
      events: [ev("job.cancelled", { terminated: true })],
      transition: { to: "CANCELLED" },
    });
    expect(confirmed.json().status).toBe("CANCELLED");

    const released = await stop(false);
    expect((released.json() as SystemControls).emergencyStop.engaged).toBe(false);
    expect(await audits("system.emergency_stop.release")).toHaveLength(1);
    const next = await create();
    expect(next.statusCode).toBe(202);
    const leased = await runner(token, "/v1/runner/lease");
    expect(leased.json()).toMatchObject({ jobId: next.json().jobId });
  });

  it("refuses to execute an approval while engaged and leaves it pending", async () => {
    const job = await createIssueJob(1);
    await sql.query(`update jobs set status = 'AWAITING_APPROVAL' where id = $1`, [job.id]);
    const [approval] = await db
      .insert(approvals)
      .values({
        jobId: job.id,
        projectId: job.projectId,
        riskTier: "R2",
        status: "PENDING",
        action: { type: "github.push_draft_pr" } as never, // never executed in this test
        actionHash: "f".repeat(64),
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    await stop(true);
    const res = await owner("POST", `/v1/approvals/${approval!.id}/decision`, {
      decision: "approve",
      actionHash: "f".repeat(64),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("EMERGENCY_STOP");
    const [after] = await db.select().from(approvals).where(eq(approvals.id, approval!.id));
    expect(after!.status).toBe("PENDING");
    expect(await audits("approval.approve")).toHaveLength(0);
  });

  it("survives an API restart", async () => {
    await stop(true);
    const again = await buildApp(t.config);
    try {
      await again.ready();
      const res = await owner("GET", "/v1/system", undefined, cookie, again);
      expect((res.json() as SystemControls).emergencyStop.engaged).toBe(true);
    } finally {
      await again.close();
    }
  });

  it("validates the request and needs a session and a trusted Origin", async () => {
    expect((await owner("PUT", "/v1/system/emergency-stop", { engaged: "yes" })).statusCode).toBe(400);
    expect((await owner("PUT", "/v1/system/emergency-stop", { engaged: true, x: 1 })).statusCode).toBe(400);
    const noOrigin = await app.inject({
      method: "PUT",
      url: "/v1/system/emergency-stop",
      headers: { cookie },
      payload: { engaged: true },
    });
    expect(noOrigin.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/system" })).statusCode).toBe(401);
    expect((await system()).emergencyStop.engaged).toBe(false);
  });
});

describe("daily budget", () => {
  it("sums the runner's summary-event cost estimates once per batch", async () => {
    await sql.query(`update jobs set estimated_cost_usd = null`);
    const { token } = await pairRunner();
    const id = (await create()).json().jobId as string;
    const { append } = await leaseRunning(token);
    const summary = (estimatedCostUsd: unknown) => ev("agent.message", { kind: "summary", estimatedCostUsd });
    const batch = {
      batchId: randomUUID(),
      fencingToken: (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!.fencingToken,
      events: [
        summary(0.25),
        summary(-1),
        summary("9"),
        ev("agent.message", { kind: "text", estimatedCostUsd: 5 }),
      ],
    };
    await runner(token, `/v1/runner/jobs/${id}/events`, batch);
    await runner(token, `/v1/runner/jobs/${id}/events`, batch); // retried batch: not counted twice
    await append({ events: [summary(0.5), summary(Number.MAX_VALUE)] });

    const job = (await owner("GET", `/v1/jobs/${id}`)).json() as Job;
    expect(job.estimatedCostUsd).toBe(0.75);
    expect((await system()).budget).toMatchObject({ dailyCapUsd: 20, spentTodayUsd: 0.75, exhausted: false });
  });

  it("counts jobs created since midnight in the owner's timezone", async () => {
    await sql.query(`update jobs set estimated_cost_usd = null`);
    const at = async (createdAt: string, usd: number) => {
      const id = (await create()).json().jobId as string;
      await sql.query(
        `update jobs set created_at = $2, estimated_cost_usd = $3, status = 'COMPLETED' where id = $1`,
        [id, createdAt, usd],
      );
    };
    await at("2026-03-09T19:59:59Z", 3); // 23:59:59 the day before in Dubai
    await at("2026-03-09T20:00:00Z", 2); // 00:00 in Dubai
    await at("2026-03-10T19:00:00Z", 1.5);
    await at("2026-03-10T20:00:00Z", 7); // the next Dubai day
    const now = new Date("2026-03-10T19:30:00Z"); // 23:30 in Dubai

    const dubai = (await getSystemControls(db, "Asia/Dubai", now)).budget;
    expect(dubai).toMatchObject({
      spentTodayUsd: 3.5,
      resetsAt: "2026-03-10T20:00:00.000Z",
      timezone: "Asia/Dubai",
    });
    const utc = (await getSystemControls(db, "UTC", now)).budget;
    expect(utc).toMatchObject({ spentTodayUsd: 8.5, resetsAt: "2026-03-11T00:00:00.000Z" });
    // DST start in Vienna: that day is 23 hours long, and midnight is 22:00 UTC.
    const vienna = await getSystemControls(db, "Europe/Vienna", new Date("2026-03-29T12:00:00Z"));
    expect(vienna.budget.resetsAt).toBe("2026-03-29T22:00:00.000Z");
  });

  it("refuses an issue run that doesn't fit today's cap and lowers the leased cost cap to what is left", async () => {
    const set = await owner("PUT", "/v1/system/budget", { dailyCapUsd: 6 });
    expect((set.json() as SystemControls).budget.dailyCapUsd).toBe(6);
    expect((await audits("system.budget.set")).at(-1)).toMatchObject({
      metadata: { fromUsd: 20, toUsd: 6 },
      correlation_id: set.headers["x-request-id"],
    });
    await spendToday(2);

    const over = await create(issueJob(5)); // 2 + 5 > 6, refused before GitHub is asked
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toMatchObject({
      code: "BUDGET_EXHAUSTED",
      details: { dailyCapUsd: 6, spentTodayUsd: 2, remainingUsd: 4, requestedMaxCostUsd: 5 },
    });
    expect(over.json().error.message).toMatch(/\$4\.00 of \$6\.00 is left/);
    expect((await create()).statusCode).toBe(202); // diagnostics cost nothing and are never budget-blocked

    const fits = await createIssueJob(4); // exactly the remainder
    expect(fits.status).toBe("QUEUED");
    expect(await leasedBudget(fits)).toEqual(issueJob(4).budget);
    await spendToday(4.766);
    expect(await leasedBudget(fits)).toMatchObject({ maxCostUsd: 1.23 });
    await spendToday(5.999);
    expect(await leaseRequest(db, fits, "Asia/Dubai")).toBeNull();
    expect((await system()).budget.exhausted).toBe(false);
    await spendToday(6);
    expect((await system()).budget.exhausted).toBe(true);
  });

  it("fails an issue run at lease time when nothing is left", async () => {
    const job = await createIssueJob(1);
    await spendToday(20);
    const { token } = await pairRunner();
    expect((await runner(token, "/v1/runner/lease")).statusCode).toBe(204);
    const [after] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after!.status).toBe("FAILED");
    const failed = await sql.query(
      `select payload from run_events where job_id = $1 and type = 'job.failed'`,
      [job.id],
    );
    expect(failed.rows[0].payload).toMatchObject({ reason: "BUDGET_EXHAUSTED" });
  });

  it("validates the cap", async () => {
    for (const body of [
      { dailyCapUsd: 0 },
      { dailyCapUsd: 1001 },
      { dailyCapUsd: "5" },
      { dailyCapUsd: 0.004 },
      {},
    ])
      expect((await owner("PUT", "/v1/system/budget", body)).statusCode).toBe(400);
    expect((await owner("PUT", "/v1/system/budget", { dailyCapUsd: 12.345 })).json().budget.dailyCapUsd).toBe(
      12.35,
    );
  });
});

describe("sessions", () => {
  it("lists the owner's sessions, revokes another one, and signs out when revoking the current one", async () => {
    const a = await ownerSession(t);
    const b = await ownerSession(t);
    expect((await owner("GET", "/v1/me", undefined, a)).json()).not.toHaveProperty("sessionId");

    const list = (await owner("GET", "/v1/sessions", undefined, a)).json().items as {
      id: string;
      current: boolean;
    }[];
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/token/i);
    const current = list.find((s) => s.current)!.id;
    const bId = (await owner("GET", "/v1/sessions", undefined, b))
      .json()
      .items.find((s: { current: boolean }) => s.current).id as string;

    expect(
      (await app.inject({ method: "DELETE", url: `/v1/sessions/${bId}`, headers: { cookie: a } })).statusCode,
    ).toBe(403); // no Origin
    const revoked = await owner("DELETE", `/v1/sessions/${bId}`, undefined, a);
    expect(revoked.statusCode).toBe(204);
    expect((await owner("GET", "/v1/runners", undefined, b)).statusCode).toBe(401);
    expect((await owner("GET", "/v1/runners", undefined, a)).statusCode).toBe(200);
    expect((await owner("DELETE", `/v1/sessions/${bId}`, undefined, a)).statusCode).toBe(404);
    expect((await owner("DELETE", "/v1/sessions/not%20an%20id", undefined, a)).statusCode).toBe(400);

    const self = await owner("DELETE", `/v1/sessions/${current}`, undefined, a);
    expect(self.statusCode).toBe(204);
    expect(String(self.headers["set-cookie"])).toMatch(/session_token=;/);
    expect((await owner("GET", "/v1/me", undefined, a)).statusCode).toBe(401);
    expect((await owner("GET", "/v1/me")).statusCode).toBe(200); // the test's own session is untouched

    const records = await audits("session.revoke");
    expect(records.map((r) => [r.resource_id, r.metadata.current])).toEqual([
      [bId, false],
      [current, true],
    ]);
  });
});
