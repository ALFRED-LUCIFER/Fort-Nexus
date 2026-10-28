import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  AppendEventsRequest,
  IssueSnapshot,
  Notification,
  NotificationList,
  Verification,
} from "@nexus/contracts";
import { createDb, type Db } from "../src/db/index.ts";
import { projectRepositories } from "../src/db/schema.ts";
import { HttpError } from "../src/errors.ts";
import type { GithubCatalog } from "../src/github/catalog.ts";
import { createExecutor, decideApproval, expireApprovals, uploadChangeset } from "../src/issue-to-pr.ts";
import {
  appendRunnerEvents,
  createJob,
  reapExpiredLeases,
  stateChanged,
  tryLease,
  type JobRow,
} from "../src/jobs.ts";
import { notifyForJobEvents } from "../src/notifications.ts";
import { authenticateRunner, type RunnerRow } from "../src/runners.ts";
import { createTestApp, homeProjectId, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// FR-NTF-01/02/04/05/06: one notification per verified event, fact-based text, deduplicated under retry/replay.
// Runs are driven through the production functions (jobs, issue-to-pr); GitHub is a stub catalog.

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
const V = (status: Verification["status"], over: Partial<Verification> = {}): Verification => ({
  status,
  reason: null,
  source: status === "not_configured" ? null : "package.json",
  install: null,
  test: status === "not_configured" ? null : ["npm", "test"],
  exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
  durationMs: 1000,
  outputTail: "",
  ...over,
});
const PR = {
  pullRequestNumber: 7,
  pullRequestUrl: "https://github.com/acme/web/pull/7",
  headSha: "c".repeat(40),
};

let t: TestApp;
let app: FastifyInstance;
let db: Db;
let sql: pg.Pool;
let cookie: string;
let ownerId: string;
let home: string;
let runner: RunnerRow;
let runnerToken: string;
const github = { pushDraftPr: async () => ({ ...PR, adopted: false }) };

type Method = "GET" | "POST" | "PUT" | "PATCH";
const owner = (method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method,
    url,
    headers: { cookie, origin: t.config.publicOrigin, ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });
const list = async (q = "") => {
  const res = await owner("GET", `/v1/notifications${q}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as NotificationList;
};
const forJob = async (jobId: string) =>
  (await list("?limit=100")).items.filter((n) => n.subject.jobId === jobId);

async function diagnostic(projectId = home) {
  const res = await owner(
    "POST",
    "/v1/jobs",
    { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version", projectId },
    { "idempotency-key": randomUUID() },
  );
  expect(res.statusCode, res.body).toBe(202);
  return running();
}

const issueJob = () =>
  createJob(db, {
    ownerId,
    idempotencyKey: randomUUID(),
    body: {
      jobType: "DEV_ISSUE_TO_PR",
      projectId: home,
      repositoryId: "101",
      issueNumber: 42,
      budget: { maxWallClockMinutes: 45, maxTurns: 60, maxCostUsd: 5 },
    },
    correlationId: randomUUID(),
    timezone: t.config.ownerTimezone,
    pinIssue: async () => SNAPSHOT,
  });

/** Leases the oldest queued job and moves it to RUNNING; `append` sends a runner batch (retry = same batch). */
async function running() {
  const job = (await tryLease(db, runner)) as JobRow;
  expect(job).toBeTruthy();
  const batch = (b: Omit<AppendEventsRequest, "batchId" | "fencingToken">): AppendEventsRequest => ({
    batchId: randomUUID(),
    fencingToken: job.fencingToken,
    ...b,
  });
  const append = (b: AppendEventsRequest) => appendRunnerEvents(db, runner, job.id, b);
  await append(batch({ events: [], transition: { to: "RUNNING" } }));
  return { job, batch, append };
}

/** RUNNING → VERIFYING → COMPLETED; returns the final batch (to retry it). */
async function succeed({ batch, append }: Awaited<ReturnType<typeof running>>) {
  await append(batch({ events: [], transition: { to: "VERIFYING" } }));
  const done = batch({ events: [], transition: { to: "COMPLETED", outcome: "COMMAND_SUCCEEDED" } });
  await append(done);
  return done;
}

const failWith = (reason: string, outcome?: "TIMED_OUT" | "BUDGET_EXCEEDED") => ({
  events: [
    { occurredAt: new Date().toISOString(), type: "job.failed" as const, stage: null, payload: { reason } },
  ],
  transition: { to: "FAILED" as const, ...(outcome ? { outcome } : { outcome: "COMMAND_FAILED" as const }) },
});

async function pendingApproval(verification: Verification) {
  await issueJob();
  const { job } = await running();
  const up = await uploadChangeset(db, runner, job.id, {
    fencingToken: job.fencingToken,
    baseSha: SNAPSHOT.baseSha,
    files: [
      { change: "modified", path: "src/cart.ts", mode: "100644", contentBase64: "eA==" },
      { change: "deleted", path: "old.ts" },
    ],
    stats: { added: 3, removed: 1 },
    agentSummary: "All tests pass and the PR is open.", // agent narration: never in a notification
    verification,
  });
  return { job, ...up };
}
const decide = (approvalId: string, actionHash: string, decision: "approve" | "deny") =>
  decideApproval(db, { ownerId, approvalId, body: { decision, actionHash }, correlationId: randomUUID() });

beforeAll(async () => {
  t = await createTestApp({ RUNNER_LEASE_POLL_MS: "0" });
  app = t.app;
  ({ db, pool: sql } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  ownerId = (await owner("GET", "/v1/me")).json().id;
  home = await homeProjectId(t, cookie);
  await db.insert(projectRepositories).values({ projectId: home, repositoryId: "101" });
  const pair = await owner("POST", "/v1/runners/pair");
  const reg = await app.inject({
    method: "POST",
    url: "/v1/runner/register",
    payload: { code: pair.json().code, name: "home", os: "darwin", version: "0.0.0" },
  });
  runnerToken = reg.json().token as string;
  runner = (await authenticateRunner(db, runnerToken))!;
});
afterAll(async () => {
  await app?.close();
  await sql?.end();
});
// Leases take the oldest queued job and the runner has one slot: start each test with neither (no events written).
beforeEach(async () => {
  await sql.query(
    `update jobs set status = 'FAILED', lease_expires_at = null where status in ('QUEUED', 'PREPARING', 'RUNNING', 'VERIFYING')`,
  );
});

describe("job notifications", () => {
  it("COMPLETED → exactly one TASK_DONE, even when the final batch is retried and the event replayed", async () => {
    const run = await diagnostic();
    const { job, append } = run;
    await append(await succeed(run)); // the runner's retry of the final batch
    await db.transaction((tx) =>
      notifyForJobEvents(tx, job.id, [
        stateChanged("VERIFYING", "COMPLETED", { outcome: "COMMAND_SUCCEEDED" }),
      ]),
    );
    const notes = await forJob(job.id);
    expect(notes).toEqual([
      {
        id: expect.any(String),
        projectId: home,
        category: "TASK_DONE",
        title: "Finished · node-version diagnostic",
        body: "The command succeeded. Open the run for its output.",
        subject: { jobId: job.id, approvalId: null },
        status: "UNREAD",
        createdAt: expect.any(String),
      },
    ]);
  });

  it.each([
    ["timeout", "TIMED_OUT", "Run timed out", /ran past its time limit\. Start it again/],
    ["budget_exceeded", "BUDGET_EXCEEDED", "Run stopped at its budget", /reached this run's budget\. Narrow/],
    ["sandbox_unavailable", undefined, "Run failed", /^Docker isn't reachable.*Start Docker/],
    ["<img src=x>", undefined, "Run failed", /^The run failed\. Open the run/], // never echoes a non-code
  ] as const)(
    "FAILED (%s) → one TASK_FAILED with the reason and the next step",
    async (reason, outcome, head, body) => {
      const { job, batch, append } = await diagnostic();
      await append(batch(failWith(reason, outcome)));
      const [n, ...rest] = await forJob(job.id);
      expect(rest).toEqual([]);
      expect(n).toMatchObject({ category: "TASK_FAILED", title: `${head} · node-version diagnostic` });
      expect(n!.body).toMatch(body);
    },
  );

  it("RECOVERY_REQUIRED → TASK_FAILED once, though the reaper runs again", async () => {
    const { job } = await diagnostic();
    await sql.query(`update jobs set lease_expires_at = now() - interval '1 minute' where id = $1`, [job.id]);
    expect(await reapExpiredLeases(db)).toBe(1);
    await reapExpiredLeases(db);
    const notes = await forJob(job.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      category: "TASK_FAILED",
      title: "Run needs recovery · node-version diagnostic",
      body: expect.stringMatching(/stopped reporting.*never retries on its own/),
    });
  });

  it("CANCELLED by the owner → no notification (queued, or confirmed by the runner)", async () => {
    const queued = await owner(
      "POST",
      "/v1/jobs",
      { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version", projectId: home },
      { "idempotency-key": randomUUID() },
    );
    const queuedId = queued.json().jobId as string;
    expect((await owner("POST", `/v1/jobs/${queuedId}/cancel`)).statusCode).toBe(202);
    const { job, batch, append } = await diagnostic();
    expect((await owner("POST", `/v1/jobs/${job.id}/cancel`)).statusCode).toBe(202);
    await append(batch({ events: [], transition: { to: "CANCELLED" } }));
    expect(await forJob(queuedId)).toEqual([]);
    expect(await forJob(job.id)).toEqual([]);
  });
});

describe("issue run notifications (tests + PR facts)", () => {
  it.each([
    ["passed", V("passed"), "Tests passed (run by NEXUS in the sandbox)."],
    ["failed", V("failed"), "Tests FAILED with exit code 1 (run by NEXUS in the sandbox)."],
    ["not verified", V("not_configured"), "Tests not verified by NEXUS."],
    [
      "couldn't run",
      V("error", { reason: "Docker is not reachable on the runner host" }),
      "Tests couldn't run: Docker is not reachable on the runner host.",
    ],
  ])(
    "approval requested, tests %s → APPROVAL_REQUIRED 'ready for review', no PR claimed",
    async (_, v, tests) => {
      const { job, approvalId } = await pendingApproval(v);
      expect(await forJob(job.id)).toEqual([
        expect.objectContaining({
          category: "APPROVAL_REQUIRED",
          title: "Ready for review · acme/web#42",
          body: `${tests} +3 −1 in 2 files. No PR yet: approve the push to open a draft PR.`,
          subject: { jobId: job.id, approvalId },
          projectId: home,
        }),
      ]);
    },
  );

  it("EXECUTED → TASK_DONE 'Draft PR #n opened' from GitHub's answer, once, though execution is reconciled again", async () => {
    const { job, approvalId, actionHash } = await pendingApproval(V("passed"));
    await decide(approvalId, actionHash, "approve");
    const executor = createExecutor(db, github as unknown as GithubCatalog, app.log);
    expect(await executor.execute(approvalId)).toMatchObject({ status: "EXECUTED" });
    await executor.execute(approvalId);
    const done = (await forJob(job.id)).filter((n) => n.category === "TASK_DONE");
    expect(done).toEqual([
      expect.objectContaining({
        title: "Draft PR #7 opened · acme/web#42",
        body: "Tests passed (run by NEXUS in the sandbox). Review it on GitHub; NEXUS never merges.",
        subject: { jobId: job.id, approvalId },
      }),
    ]);
  });

  it("denied → TASK_DONE that says nothing was pushed and no PR exists", async () => {
    const { job, approvalId, actionHash } = await pendingApproval(V("failed"));
    await decide(approvalId, actionHash, "deny");
    const done = (await forJob(job.id)).find((n) => n.category === "TASK_DONE");
    expect(done).toMatchObject({
      title: "Push denied · acme/web#42",
      body: "You denied the push, so nothing was pushed and no PR exists. Tests FAILED with exit code 1 (run by NEXUS in the sandbox).",
    });
    expect(done!.title).not.toMatch(/PR #/);
  });

  it("push failed → TASK_FAILED, never a PR claim", async () => {
    const { job, approvalId, actionHash } = await pendingApproval(V("passed"));
    await decide(approvalId, actionHash, "approve");
    const broken = {
      pushDraftPr: async () => {
        throw new HttpError(409, "CONFLICT", "The branch already exists with other commits");
      },
    };
    await createExecutor(db, broken as unknown as GithubCatalog, app.log).execute(approvalId);
    const notes = await forJob(job.id);
    expect(notes.map((n) => n.category)).toEqual(["TASK_FAILED", "APPROVAL_REQUIRED"]);
    expect(notes[0]).toMatchObject({
      title: "Run failed · acme/web#42",
      body: expect.stringMatching(/nothing was merged/),
    });
  });

  it("approval expired → one INFORMATIONAL, and the EXPIRED job adds no second notice", async () => {
    const { job, approvalId } = await pendingApproval(V("passed"));
    await sql.query(`update approvals set expires_at = now() - interval '1 second' where id = $1`, [
      approvalId,
    ]);
    expect(await expireApprovals(db)).toBe(1);
    const notes = await forJob(job.id);
    expect(notes.map((n) => [n.category, n.title])).toEqual([
      ["INFORMATIONAL", "Approval expired · acme/web#42"],
      ["APPROVAL_REQUIRED", "Ready for review · acme/web#42"],
    ]);
    expect(notes[0]!.subject).toEqual({ jobId: job.id, approvalId });
  });
});

describe("security notices", () => {
  const security = async () => (await list("?category=SECURITY_CRITICAL&limit=100")).items;

  it("emergency stop engaged/released → SECURITY_CRITICAL, owner-wide; repeating a state adds nothing", async () => {
    const before = (await security()).length;
    await owner(
      "POST",
      "/v1/jobs",
      { jobType: "RUNNER_DIAGNOSTIC", preset: "host-info", projectId: home },
      {
        "idempotency-key": randomUUID(),
      },
    );
    expect((await owner("PUT", "/v1/system/emergency-stop", { engaged: true })).statusCode).toBe(200);
    await owner("PUT", "/v1/system/emergency-stop", { engaged: true });
    expect((await owner("PUT", "/v1/system/emergency-stop", { engaged: false })).statusCode).toBe(200);
    const after = await security();
    const notes = after.slice(0, after.length - before); // newest first
    expect(notes.map((n) => [n.title, n.projectId, n.subject])).toEqual([
      ["Emergency stop released", null, { jobId: null, approvalId: null }],
      ["Emergency stop engaged", null, { jobId: null, approvalId: null }],
    ]);
    expect(notes[1]!.body).toMatch(/^Queued runs cancelled: 1\. Running runs asked to stop: 0\./);
  });

  it("runner revoked → SECURITY_CRITICAL once", async () => {
    const pair = await owner("POST", "/v1/runners/pair");
    const reg = await app.inject({
      method: "POST",
      url: "/v1/runner/register",
      payload: { code: pair.json().code, name: "old-laptop", os: "linux", version: "0.0.0" },
    });
    const id = reg.json().runnerId as string;
    await owner("POST", `/v1/runners/${id}/revoke`);
    await owner("POST", `/v1/runners/${id}/revoke`);
    const notes = (await security()).filter((n) => n.title === 'Runner "old-laptop" revoked');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.projectId).toBeNull();
  });
});

describe("GET /v1/notifications and POST /v1/notifications/:id/status", () => {
  it("filters by project (owner-wide notices stay visible), never shows another owner's", async () => {
    const devWs = (await owner("GET", "/v1/workspaces"))
      .json()
      .items.find((w: { mode: string }) => w.mode === "DEV");
    const created = await owner("POST", `/v1/workspaces/${devWs.id}/projects`, {
      name: "Decoy",
      slug: `decoy-${Date.now()}`,
    });
    expect(created.statusCode, created.body).toBe(201);
    const decoy = created.json().id as string;
    const inDecoy = await diagnostic(decoy);
    await succeed(inDecoy);
    const inHome = await diagnostic();
    await succeed(inHome);
    // Another account's notification in the same database.
    await sql.query(
      `insert into "user" (id, name, email) values ('decoy-user', 'Decoy', 'decoy@example.com')`,
    );
    const other = await sql.query(
      `insert into notifications (owner_id, project_id, category, title, body, dedup_key)
       values ('decoy-user', $1, 'TASK_DONE', 'not yours', 'x', $2) returning id`,
      [home, `decoy:${randomUUID()}`],
    );

    const ofHome = (await list(`?projectId=${home}&limit=100`)).items;
    const ofDecoy = (await list(`?projectId=${decoy}&limit=100`)).items;
    const all = (await list("?limit=100")).items;
    expect(ofHome.some((n) => n.subject.jobId === inHome.job.id)).toBe(true);
    expect(ofHome.some((n) => n.subject.jobId === inDecoy.job.id)).toBe(false);
    expect(ofDecoy.filter((n) => n.projectId !== null).map((n) => n.subject.jobId)).toEqual([inDecoy.job.id]);
    expect(ofDecoy.some((n) => n.category === "SECURITY_CRITICAL")).toBe(true);
    expect(all.some((n) => n.title === "not yours")).toBe(false);
    expect(
      (await owner("POST", `/v1/notifications/${other.rows[0].id}/status`, { status: "READ" })).statusCode,
    ).toBe(404);
  });

  it("READ then ACKNOWLEDGED, never back; unreadCount follows; bad input is 400/404", async () => {
    const { job, batch, append } = await diagnostic();
    await append(batch(failWith("timeout", "TIMED_OUT")));
    const [n] = await forJob(job.id);
    const unread = (await list()).unreadCount;
    expect((await list("?status=UNREAD&limit=100")).items.map((x) => x.id)).toContain(n!.id);
    const set = (status: string, id = n!.id) => owner("POST", `/v1/notifications/${id}/status`, { status });

    const read = await set("READ");
    expect(read.statusCode).toBe(200);
    expect((read.json() as Notification).status).toBe("READ");
    expect((await list()).unreadCount).toBe(unread - 1);
    expect((await set("ACKNOWLEDGED")).json().status).toBe("ACKNOWLEDGED");
    expect((await set("READ")).json().status).toBe("ACKNOWLEDGED");
    const audited = await sql.query(
      `select action from audit_records where resource_type = 'notification' and resource_id = $1 order by occurred_at`,
      [n!.id],
    );
    expect(audited.rows.map((r: { action: string }) => r.action)).toEqual([
      "notification.read",
      "notification.acknowledged",
    ]);

    expect((await set("UNREAD")).statusCode).toBe(400);
    expect((await set("READ", randomUUID())).statusCode).toBe(404);
    expect((await owner("GET", "/v1/notifications?category=NOPE")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/notifications" })).statusCode).toBe(401);
    const csrf = await app.inject({
      method: "POST",
      url: `/v1/notifications/${n!.id}/status`,
      headers: { cookie, origin: "https://evil.example" },
      payload: { status: "READ" },
    });
    expect(csrf.statusCode).toBe(403);
  });
});
