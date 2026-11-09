// A real API with the GitHub fake, one paired runner and issue jobs driven through the real routes: the common
// ground of the self-healing tests (keep fixing, feedback, the Developer profile).
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { expect, vi } from "vitest";
import type { Job, LeaseResponse, Verification } from "@nexus/contracts";
import { createDb, type Db } from "../../src/db/index.ts";
import { projectRepositories } from "../../src/db/schema.ts";
import { BASE_SHA, b64, fakeGithub } from "./fake-github.ts";
import { createTestApp, homeProjectId, ownerSession, type TestApp } from "./owner-session.ts";

export const FILES = [
  { change: "modified", path: "src/cart.ts", mode: "100644", contentBase64: b64("export const x = 1;\n") },
  { change: "deleted", path: "old.txt" },
];
export const PASSED: Verification = {
  status: "passed",
  reason: null,
  source: "package.json",
  install: ["npm", "ci"],
  test: ["npm", "test"],
  exitCode: 0,
  durationMs: 1000,
  outputTail: "ok",
};
export const FAILED: Verification = { ...PASSED, status: "failed", exitCode: 1, outputTail: "1 failed" };
export const NOT_CONFIGURED: Verification = {
  ...PASSED,
  status: "not_configured",
  source: null,
  install: null,
  test: null,
  exitCode: null,
};

type Opts = { body?: unknown; key?: string; origin?: string | null; cookie?: string };

export async function issueRunKit(env: Record<string, string> = {}) {
  const t: TestApp = await createTestApp({ RUNNER_LEASE_POLL_MS: "200", ...env });
  const { db, pool: sql } = createDb(t.databaseUrl);
  const cookie = await ownerSession(t);
  const projectId = await homeProjectId(t, cookie);
  await db.insert(projectRepositories).values({ projectId, repositoryId: "101" });
  let gh = fakeGithub();
  let runnerToken = "";

  const owner = (method: "GET" | "POST" | "PUT", url: string, o: Opts = {}) =>
    t.app.inject({
      method,
      url,
      headers: {
        cookie: o.cookie ?? cookie,
        ...(o.origin === null ? {} : { origin: o.origin ?? t.config.publicOrigin }),
        ...(o.key ? { "idempotency-key": o.key } : {}),
      },
      ...(o.body === undefined ? {} : { payload: o.body as object }),
    });
  const runner = (url: string, body?: unknown, token = runnerToken) =>
    t.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { payload: body as object }),
    });
  const job = async (id: string) => (await owner("GET", `/v1/jobs/${id}`)).json() as Job;
  const pair = async () => {
    if (runnerToken) return runnerToken; // registration is rate limited: one runner per file
    const code = (await owner("POST", "/v1/runners/pair")).json().code as string;
    const reg = await t.app.inject({
      method: "POST",
      url: "/v1/runner/register",
      payload: { code, name: "home", os: "darwin", version: "0.0.0" },
    });
    runnerToken = reg.json().token as string;
    return runnerToken;
  };

  /** Starts clean: no queued or leased jobs left over, and a fresh GitHub fake. */
  const reset = async () => {
    vi.restoreAllMocks();
    gh = fakeGithub();
    const queued = (await owner("GET", "/v1/jobs?status=QUEUED&limit=100")).json().items as Job[];
    for (const j of queued) await owner("POST", `/v1/jobs/${j.id}/cancel`);
    await sql.query(
      `update jobs set status = 'FAILED', lease_expires_at = null where status in ('PREPARING', 'RUNNING', 'VERIFYING')`,
    );
  };

  const createIssueJob = (body: Record<string, unknown> = {}, key = randomUUID()) =>
    owner("POST", "/v1/jobs", {
      key,
      body: { jobType: "DEV_ISSUE_TO_PR", repositoryId: "101", issueNumber: 42, projectId, ...body },
    });
  const lease = async () => {
    await pair();
    const res = await runner("/v1/runner/lease");
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as LeaseResponse;
  };
  /** A new issue job, leased and RUNNING. */
  const runningJob = async () => {
    await pair();
    const created = await createIssueJob();
    expect(created.statusCode, created.body).toBe(202);
    const l = await lease();
    expect(l.jobId).toBe(created.json().jobId);
    const run = await runner(`/v1/runner/jobs/${l.jobId}/events`, {
      batchId: randomUUID(),
      fencingToken: l.fencingToken,
      events: [],
      transition: { to: "RUNNING" },
    });
    expect(run.statusCode).toBe(200);
    return l;
  };
  const changeset = (l: LeaseResponse, over: Record<string, unknown> = {}) => ({
    fencingToken: l.fencingToken,
    baseSha: BASE_SHA,
    files: FILES,
    stats: { added: 3, removed: 1 },
    agentSummary: "Rounded totals.",
    verification: PASSED,
    integrity: { clean: true, problems: [] },
    ...over,
  });
  const upload = (l: LeaseResponse, over: Record<string, unknown> = {}) =>
    runner(`/v1/runner/jobs/${l.jobId}/changeset`, changeset(l, over));
  /** A job that stopped with a stored changeset whose tests did not pass. */
  const stoppedJob = async (verification: Verification = FAILED) => {
    const l = await runningJob();
    expect((await upload(l, { verification })).statusCode).toBe(200);
    return l.jobId;
  };

  return {
    t,
    app: t.app,
    db: db as Db,
    sql: sql as pg.Pool,
    cookie,
    projectId,
    get gh() {
      return gh;
    },
    owner,
    runner,
    job,
    pair,
    reset,
    createIssueJob,
    lease,
    runningJob,
    changeset,
    upload,
    stoppedJob,
    close: async () => {
      await t.app.close();
      await sql.end();
    },
  };
}
