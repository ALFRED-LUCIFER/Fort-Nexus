import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "@nexus/contracts";
import { createDb } from "../src/db/index.ts";
import { createTestApp, homeProjectId, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// FR-RUN-06: POST /v1/jobs/:id/retry. A rerun is a new job linked to the original; the original is never changed.
// The issue-run half (a fresh pin from GitHub) is in issue-to-pr.test.ts, next to the GitHub fake.

let t: TestApp;
let sql: pg.Pool;
let cookie: string;
let projectId: string;

const owner = (method: "GET" | "POST" | "PUT", url: string, o: { key?: string; body?: unknown } = {}) =>
  t.app.inject({
    method,
    url,
    headers: {
      cookie,
      origin: t.config.publicOrigin,
      ...(o.key ? { "idempotency-key": o.key } : {}),
    },
    ...(o.body === undefined ? {} : { payload: o.body as object }),
  });

const rerun = (id: string, key: string = randomUUID()) => owner("POST", `/v1/jobs/${id}/retry`, { key });
const getJob = async (id: string) => (await owner("GET", `/v1/jobs/${id}`)).json() as Job;
const create = async (extra: Record<string, unknown> = {}) => {
  const res = await owner("POST", "/v1/jobs", {
    key: randomUUID(),
    body: { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version", projectId, ...extra },
  });
  expect(res.statusCode, res.body).toBe(202);
  return res.json().jobId as string;
};
/** A job the owner cancelled while it was queued. */
const finished = async (extra: Record<string, unknown> = {}) => {
  const id = await create(extra);
  expect((await owner("POST", `/v1/jobs/${id}/cancel`)).statusCode).toBe(202);
  return id;
};
const rerunsOf = async (id: string) =>
  (await sql.query(`select id from jobs where retry_of_job_id = $1`, [id])).rows.map(
    (r: { id: string }) => r.id,
  );

beforeAll(async () => {
  t = await createTestApp();
  ({ pool: sql } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  projectId = await homeProjectId(t, cookie);
});
afterAll(async () => {
  await t?.app.close();
  await sql?.end();
});

describe("run again", () => {
  it("queues a new job linked to the original, keeps its agent and leaves the original as it was", async () => {
    const id = await finished();
    // Not the job type's default, so the assertion below can only pass if the original's agent is carried over.
    await sql.query(`update jobs set agent = 'DEVELOPER' where id = $1`, [id]);
    const before = await getJob(id);

    const res = await rerun(id);
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json() as { jobId: string; status: string; streamUrl: string };
    expect(body).toEqual({
      jobId: expect.any(String) as string,
      status: "QUEUED",
      streamUrl: `/v1/jobs/${body.jobId}/events`,
    });
    expect(body.jobId).not.toBe(id);

    expect(await getJob(body.jobId)).toMatchObject({
      status: "QUEUED",
      retryOfJobId: id,
      agent: "DEVELOPER",
      request: before.request,
    });
    expect(await getJob(id)).toEqual(before);
  });

  it("records the rerun in the audit trail and the run's own events", async () => {
    const id = await finished();
    const res = await rerun(id);
    const newId = res.json().jobId as string;

    const audits = await sql.query(
      `select * from audit_records where action = 'job.retry' and resource_id = $1`,
      [newId],
    );
    expect(audits.rowCount).toBe(1);
    expect(audits.rows[0].correlation_id).toBe(res.headers["x-request-id"]);
    expect(audits.rows[0].metadata).toMatchObject({ retryOfJobId: id, projectId });

    const created = await sql.query(
      `select payload from run_events where job_id = $1 and type = 'job.created'`,
      [newId],
    );
    expect(created.rows[0].payload).toMatchObject({ retryOfJobId: id });
    // A normal create stays recorded as one.
    const plain = await create();
    const logged = await sql.query(`select action from audit_records where resource_id = $1`, [plain]);
    expect(logged.rows.map((r: { action: string }) => r.action)).toEqual(["job.create"]);
  });

  it("needs a valid Idempotency-Key and a job id", async () => {
    const id = await finished();
    for (const res of [
      await owner("POST", `/v1/jobs/${id}/retry`),
      await owner("POST", `/v1/jobs/${id}/retry`, { key: "short" }),
      await rerun("not-a-uuid"),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
    }
    expect(await rerunsOf(id)).toEqual([]);
  });

  it("is 404 for an unknown job and for another owner's", async () => {
    expect((await rerun(randomUUID())).statusCode).toBe(404);

    const decoy = `decoy-${randomUUID()}`;
    await sql.query(`insert into "user" (id, name, email) values ($1, 'Decoy', $2)`, [
      decoy,
      `${decoy}@example.com`,
    ]);
    const id = await finished();
    await sql.query(`update jobs set initiator_id = $2 where id = $1`, [id, decoy]);

    const res = await rerun(id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(await rerunsOf(id)).toEqual([]);
  });

  it("refuses a job that hasn't finished, with a clear 409", async () => {
    const id = await create();
    for (const status of ["QUEUED", "RUNNING", "AWAITING_APPROVAL", "BLOCKED"]) {
      await sql.query(`update jobs set status = $2 where id = $1`, [id, status]);
      const res = await rerun(id);
      expect(res.statusCode, status).toBe(409);
      expect(res.json().error.message).toContain(status);
    }
    await sql.query(`update jobs set status = 'QUEUED' where id = $1`, [id]);
    await owner("POST", `/v1/jobs/${id}/cancel`);
    expect(await rerunsOf(id)).toEqual([]);
  });

  it("refuses RECOVERY_REQUIRED: it must be reconciled first", async () => {
    const id = await finished();
    await sql.query(`update jobs set status = 'RECOVERY_REQUIRED' where id = $1`, [id]);
    const res = await rerun(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "CONFLICT", details: { status: "RECOVERY_REQUIRED" } });
    expect(res.json().error.message).toMatch(/recovered/);
    expect(await rerunsOf(id)).toEqual([]);
    await sql.query(`update jobs set status = 'CANCELLED' where id = $1`, [id]);
  });

  it("starts one job for one key, however often it is sent", async () => {
    const id = await finished();
    const key = randomUUID();
    const first = await rerun(id, key);
    const again = await rerun(id, key);
    expect(first.statusCode).toBe(202);
    expect(again.statusCode).toBe(202);
    expect(again.json().jobId).toBe(first.json().jobId);
    expect(await rerunsOf(id)).toEqual([first.json().jobId]);

    const [a, b] = await Promise.all([
      rerun(id, (key + "x").slice(0, 60)),
      rerun(id, (key + "x").slice(0, 60)),
    ]);
    expect(a.json().jobId).toBe(b.json().jobId);
    expect(await rerunsOf(id)).toHaveLength(2);
  });

  it("refuses a key already used for another job or for a normal create", async () => {
    const [one, two] = [await finished(), await finished()];
    const key = randomUUID();
    expect((await rerun(one, key)).statusCode).toBe(202);

    const other = await rerun(two, key);
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await rerunsOf(two)).toEqual([]);

    const createKey = randomUUID();
    await owner("POST", "/v1/jobs", {
      key: createKey,
      body: { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version", projectId },
    });
    expect((await rerun(two, createKey)).json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("keeps a live runner pin, drops a revoked one, and a replay still answers after the revoke", async () => {
    const pair = await owner("POST", "/v1/runners/pair");
    const reg = await t.app.inject({
      method: "POST",
      url: "/v1/runner/register",
      payload: { code: pair.json().code, name: "pinned", os: "darwin", version: "0.0.0" },
    });
    const runnerId = reg.json().runnerId as string;
    const id = await finished({ runnerId });

    const key = randomUUID();
    const pinned = await rerun(id, key);
    expect(pinned.statusCode, pinned.body).toBe(202);
    expect((await getJob(pinned.json().jobId)).request.runnerId).toBe(runnerId);

    expect((await owner("POST", `/v1/runners/${runnerId}/revoke`)).statusCode).toBe(200);

    const replay = await rerun(id, key);
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json().jobId).toBe(pinned.json().jobId);

    const unpinned = await rerun(id);
    expect(unpinned.statusCode, unpinned.body).toBe(202);
    const job = await getJob(unpinned.json().jobId);
    expect(job.request.runnerId).toBeUndefined();
    expect(job.retryOfJobId).toBe(id);
    const row = await sql.query(`select target_runner_id from jobs where id = $1`, [unpinned.json().jobId]);
    expect(row.rows[0].target_runner_id).toBeNull();
    expect((await getJob(id)).request.runnerId).toBe(runnerId);
  });

  it("goes through createJob's checks: an emergency stop and an archived project refuse it", async () => {
    const id = await finished();

    expect((await owner("PUT", "/v1/system/emergency-stop", { body: { engaged: true } })).statusCode).toBe(
      200,
    );
    const stopped = await rerun(id);
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json().error.code).toBe("EMERGENCY_STOP");
    expect((await owner("PUT", "/v1/system/emergency-stop", { body: { engaged: false } })).statusCode).toBe(
      200,
    );

    await sql.query(`update projects set archived_at = now() where id = $1`, [projectId]);
    const archived = await rerun(id);
    await sql.query(`update projects set archived_at = null where id = $1`, [projectId]);
    expect(archived.statusCode).toBe(409);

    expect(await rerunsOf(id)).toEqual([]);
  });
});
