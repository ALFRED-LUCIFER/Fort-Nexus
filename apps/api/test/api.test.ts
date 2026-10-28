import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Job, LeaseResponse, RunEvent } from "@nexus/contracts";
import type { Config } from "../src/config.ts";
import { createDb, type Db } from "../src/db/index.ts";
import { reapExpiredLeases } from "../src/jobs.ts";
import { createTestApp, homeProjectId, ownerSession } from "./helpers/owner-session.ts";

const EVIL = "https://evil.example";
// projectId is the owner's "home" project, filled in once the owner exists (beforeAll).
const NODE_VERSION = { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version", projectId: "" };

let app: FastifyInstance;
let config: Config;
let db: Db;
let sql: pg.Pool;
let cookie: string;
let ownerLogin: string;

type Opts = {
  headers?: Record<string, string>;
  body?: unknown;
  origin?: string | null;
  cookie?: string | null;
};
const owner = (method: "GET" | "POST", url: string, o: Opts = {}) =>
  app.inject({
    method,
    url,
    headers: {
      ...(o.cookie === null ? {} : { cookie: o.cookie ?? cookie }),
      ...(o.origin === null ? {} : { origin: o.origin ?? config.publicOrigin }),
      ...o.headers,
    },
    ...(o.body === undefined ? {} : { payload: o.body as object }),
  });
const runner = (token: string, url: string, body?: unknown) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });

const createJob = (key: string = randomUUID(), body: unknown = NODE_VERSION) =>
  owner("POST", "/v1/jobs", { headers: { "idempotency-key": key }, body });

async function pairRunner(name = "home-studio") {
  const pair = await owner("POST", "/v1/runners/pair");
  expect(pair.statusCode).toBe(201);
  const reg = await app.inject({
    method: "POST",
    url: "/v1/runner/register",
    payload: { code: pair.json().code, name, os: "darwin", version: "0.0.0" },
  });
  expect(reg.statusCode).toBe(201);
  return reg.json() as { runnerId: string; token: string };
}

async function lease(token: string) {
  const res = await runner(token, "/v1/runner/lease");
  expect(res.statusCode).toBe(200);
  return res.json() as LeaseResponse;
}

const append = (token: string, l: LeaseResponse, body: Record<string, unknown>) =>
  runner(token, `/v1/runner/jobs/${l.jobId}/events`, {
    batchId: randomUUID(),
    fencingToken: l.fencingToken,
    events: [],
    ...body,
  });
const ev = (type: string, payload: Record<string, unknown> = {}) => ({
  occurredAt: new Date().toISOString(),
  type,
  payload,
});

const parseSse = (body: string) =>
  body
    .split("\n\n")
    .filter((b) => b.trim() && !b.startsWith(":"))
    .map((block) => {
      const f = Object.fromEntries(
        block.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]),
      );
      return { id: f.id, event: f.event!, data: JSON.parse(f.data!) as unknown };
    });

beforeAll(async () => {
  const t = await createTestApp({ RUNNER_LEASE_POLL_MS: "300" });
  ({ app, config } = t);
  ownerLogin = t.githubApp!.ownerGithubLogin;
  ({ db, pool: sql } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  NODE_VERSION.projectId = await homeProjectId(t, cookie);
});

afterAll(async () => {
  await app?.close();
  await sql?.end();
});

// Leases take the oldest eligible job, so leftovers from earlier tests are cancelled first.
beforeEach(async () => {
  const queued = (await owner("GET", "/v1/jobs?status=QUEUED&limit=100")).json().items as Job[];
  for (const j of queued) await owner("POST", `/v1/jobs/${j.id}/cancel`);
});

describe("access control", () => {
  it("serves health without auth and nothing else", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("returns 401 ApiError without a session", async () => {
    for (const res of [
      await owner("GET", "/v1/jobs", { cookie: null }),
      await owner("GET", "/v1/me", { cookie: null }),
      await owner("POST", "/v1/jobs", {
        cookie: null,
        headers: { "idempotency-key": randomUUID() },
        body: NODE_VERSION,
      }),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: { code: "UNAUTHENTICATED" },
        requestId: res.headers["x-request-id"],
      });
    }
  });

  it("returns the signed-in owner", async () => {
    const res = await owner("GET", "/v1/me");
    expect(res.json()).toMatchObject({ email: `${ownerLogin}@example.com`, name: "Owner" });
  });

  it("rejects cookie mutations from an untrusted or missing Origin (CSRF)", async () => {
    for (const origin of [EVIL, null]) {
      const res = await owner("POST", "/v1/jobs", {
        origin,
        headers: { "idempotency-key": randomUUID() },
        body: NODE_VERSION,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    }
  });
});

describe("job creation", () => {
  it("rejects an unknown preset, extra fields and a missing Idempotency-Key with 400", async () => {
    const bad = [
      await createJob(randomUUID(), { jobType: "RUNNER_DIAGNOSTIC", preset: "rm -rf /" }),
      await createJob(randomUUID(), { ...NODE_VERSION, cmd: "ls" }),
      await owner("POST", "/v1/jobs", { body: NODE_VERSION }),
      await createJob("short", NODE_VERSION),
    ];
    for (const res of bad) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("is idempotent per key and rejects key reuse with a different body", async () => {
    const key = randomUUID();
    const first = await createJob(key);
    const again = await createJob(key);
    expect(first.statusCode).toBe(202);
    expect(again.statusCode).toBe(202);
    expect(again.json().jobId).toBe(first.json().jobId);
    expect(first.json().streamUrl).toBe(`/v1/jobs/${first.json().jobId}/events`);

    const reused = await createJob(key, { ...NODE_VERSION, preset: "git-version" });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const audits = await sql.query(
      `select * from audit_records where action = 'job.create' and resource_id = $1`,
      [first.json().jobId],
    );
    expect(audits.rowCount).toBe(1);
    expect(audits.rows[0].correlation_id).toBe(first.headers["x-request-id"]);
  });

  it("accepts a job with no runner online and keeps it QUEUED (held, not lost)", async () => {
    const res = await createJob();
    expect(res.json().status).toBe("QUEUED");
    const job = (await owner("GET", `/v1/jobs/${res.json().jobId}`)).json() as Job;
    expect(job).toMatchObject({ status: "QUEUED", runnerId: null, lastEventSequence: 3, stateVersion: 2 });
  });

  it("paginates newest first with a cursor", async () => {
    const a = (await createJob()).json().jobId;
    const b = (await createJob()).json().jobId;
    const p1 = (await owner("GET", "/v1/jobs?limit=1")).json();
    expect(p1.items[0].id).toBe(b);
    const p2 = (await owner("GET", `/v1/jobs?limit=1&cursor=${p1.nextCursor}`)).json();
    expect(p2.items[0].id).toBe(a);
    expect((await owner("GET", "/v1/jobs?cursor=not-a-uuid")).statusCode).toBe(400);
  });
});

describe("runner lifecycle", () => {
  it("pair → register → heartbeat → lease → events → RUNNING → VERIFYING → COMPLETED, replayable over SSE", async () => {
    const { runnerId, token } = await pairRunner();
    const hb = await runner(token, "/v1/runner/heartbeat", { activeJobIds: [] });
    expect(hb.json()).toEqual({ cancelJobIds: [] });
    const listed = (await owner("GET", "/v1/runners")).json().items;
    expect(listed.find((r: { id: string }) => r.id === runnerId)).toMatchObject({ status: "ONLINE" });

    const jobId = (await createJob()).json().jobId;
    const l = await lease(token);
    expect(l).toMatchObject({ jobId, request: NODE_VERSION, fencingToken: 1 });

    // Live stream opened mid-run: must deliver everything after sequence 3 and then `end`.
    const live = owner("GET", `/v1/jobs/${jobId}/events?afterSequence=3`);

    const r1 = await append(token, l, {
      events: [ev("workspace.created", { hostname: "h", pid: 1, cwd: "/tmp/x" })],
      transition: { to: "RUNNING" },
    });
    expect(r1.json()).toEqual({ lastSequence: 6, status: "RUNNING" });
    await append(token, l, {
      events: [
        ev("agent.started"),
        ev("process.output", { stream: "stdout", text: "v24\n" }),
        ev("tool.completed"),
      ],
    });
    await append(token, l, { transition: { to: "VERIFYING" } });
    const done = await append(token, l, {
      events: [ev("job.completed")],
      transition: { to: "COMPLETED", outcome: "COMMAND_SUCCEEDED" },
    });
    expect(done.json()).toEqual({ lastSequence: 12, status: "COMPLETED" });

    const job = (await owner("GET", `/v1/jobs/${jobId}`)).json() as Job;
    expect(job).toMatchObject({
      status: "COMPLETED",
      outcome: "COMMAND_SUCCEEDED",
      runnerId,
      lastEventSequence: 12,
    });

    const liveEvents = parseSse((await live).body);
    expect(liveEvents.at(-1)).toMatchObject({
      event: "end",
      data: { status: "COMPLETED", lastSequence: 12 },
    });
    expect(liveEvents.slice(0, -1).map((e) => Number(e.id))).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // Events in a batch come first, the transition last.
    const seqTypes = liveEvents.slice(0, -1).map((e) => (e.data as RunEvent).type);
    expect(seqTypes.slice(1, 3)).toEqual(["workspace.created", "job.state.changed"]);
    expect(seqTypes.slice(-2)).toEqual(["job.completed", "job.state.changed"]);

    // GATE-04: reconnect with a cursor replays exactly the missing events, in order, then ends.
    const replay = parseSse((await owner("GET", `/v1/jobs/${jobId}/events?afterSequence=7`)).body);
    expect(replay.map((e) => e.id)).toEqual(["8", "9", "10", "11", "12", undefined]);
    expect(
      replay.slice(0, -1).every((e) => e.event === "run-event" && (e.data as RunEvent).jobId === jobId),
    ).toBe(true);
    const viaHeader = parseSse(
      (await owner("GET", `/v1/jobs/${jobId}/events`, { headers: { "last-event-id": "10" } })).body,
    );
    expect(viaHeader.map((e) => e.id)).toEqual(["11", "12", undefined]);
    const full = parseSse((await owner("GET", `/v1/jobs/${jobId}/events`)).body);
    expect(full.slice(0, 3).map((e) => (e.data as RunEvent).type)).toEqual([
      "job.created",
      "job.state.changed",
      "job.state.changed",
    ]);
    expect(full).toHaveLength(13);
    const runEvents = full.slice(0, -1).map((e) => e.data as RunEvent);
    for (const e of runEvents.filter((x) => x.type === "job.state.changed"))
      expect(e.payload).toEqual(
        expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
      );
    // Runner payloads are stored as sent.
    expect(runEvents.find((e) => e.type === "process.output")?.payload).toEqual({
      stream: "stdout",
      text: "v24\n",
    });

    // Replays never re-queue: still exactly one execution.
    expect((await runner(token, "/v1/runner/lease")).statusCode).toBe(204);

    const audits = (
      await sql.query(`select action from audit_records where resource_type = 'runner'`)
    ).rows.map((r) => r.action);
    expect(audits).toEqual(expect.arrayContaining(["runner.pair", "runner.register"]));
  });

  it("applies a retried batch once", async () => {
    const { token } = await pairRunner();
    await createJob();
    const l = await lease(token);
    const body = {
      batchId: randomUUID(),
      fencingToken: l.fencingToken,
      events: [ev("workspace.created")],
      transition: { to: "RUNNING" },
    };
    const first = await runner(token, `/v1/runner/jobs/${l.jobId}/events`, body);
    const retry = await runner(token, `/v1/runner/jobs/${l.jobId}/events`, body);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    const rows = await sql.query(
      `select type from run_events where job_id = $1 and type = 'workspace.created'`,
      [l.jobId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("rejects a stale fencing token with 409 STALE_LEASE", async () => {
    const { token } = await pairRunner();
    await createJob();
    const l = await lease(token);
    const res = await append(
      token,
      { ...l, fencingToken: l.fencingToken + 1 },
      { transition: { to: "RUNNING" } },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("STALE_LEASE");
  });

  it("rejects illegal transitions with 409 and server-only events with 400", async () => {
    const { token } = await pairRunner();
    await createJob();
    const l = await lease(token);
    const skip = await append(token, l, { transition: { to: "VERIFYING" } });
    expect(skip.statusCode).toBe(409);
    expect(skip.json().error.code).toBe("INVALID_TRANSITION");
    const spoof = await append(token, l, { events: [ev("job.state.changed")] });
    expect(spoof.statusCode).toBe(400);
    const noOutcome = await append(token, l, { transition: { to: "FAILED" } });
    expect(noOutcome.statusCode).toBe(400);
    // A runner that cannot start the job may fail it from PREPARING.
    const failed = await append(token, l, { transition: { to: "FAILED", outcome: "COMMAND_FAILED" } });
    expect(failed.json().status).toBe("FAILED");
  });

  it("returns 204 from lease when nothing is queued", async () => {
    const { token } = await pairRunner();
    expect((await runner(token, "/v1/runner/lease")).statusCode).toBe(204);
  });

  it("accepts a pairing code only once", async () => {
    const pair = (await owner("POST", "/v1/runners/pair")).json();
    const body = { code: pair.code.toLowerCase(), name: "r", os: "linux", version: "1" };
    expect((await app.inject({ method: "POST", url: "/v1/runner/register", payload: body })).statusCode).toBe(
      201,
    );
    const second = await app.inject({ method: "POST", url: "/v1/runner/register", payload: body });
    expect(second.statusCode).toBe(401);
  });

  it("stops accepting a revoked runner's token", async () => {
    const { runnerId, token } = await pairRunner();
    const res = await owner("POST", `/v1/runners/${runnerId}/revoke`);
    expect(res.json()).toMatchObject({ id: runnerId, status: "REVOKED" });
    for (const url of ["/v1/runner/heartbeat", "/v1/runner/lease"]) {
      const r = await runner(token, url, url.endsWith("heartbeat") ? { activeJobIds: [] } : undefined);
      expect(r.statusCode).toBe(401);
    }
    expect((await runner("nxr_bogus", "/v1/runner/lease")).statusCode).toBe(401);
    const audit = await sql.query(
      `select * from audit_records where action = 'runner.revoke' and resource_id = $1`,
      [runnerId],
    );
    expect(audit.rowCount).toBe(1);
  });
});

describe("recovery and cancel", () => {
  it("reaper moves an expired lease to RECOVERY_REQUIRED and the old lease becomes stale", async () => {
    const { token } = await pairRunner();
    await createJob();
    const l = await lease(token);
    await append(token, l, { transition: { to: "RUNNING" } });
    await sql.query(`update jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [
      l.jobId,
    ]);

    await reapExpiredLeases(db); // the app's own 5 s reaper may win the race; either way the job moves once
    const job = (await owner("GET", `/v1/jobs/${l.jobId}`)).json() as Job;
    expect(job.status).toBe("RECOVERY_REQUIRED");
    const types = (
      await sql.query(`select type from run_events where job_id = $1 order by sequence`, [l.jobId])
    ).rows;
    expect(types.at(-1).type).toBe("job.recovery_required");
    const audit = await sql.query(
      `select * from audit_records where action = 'job.recovery_required' and resource_id = $1`,
      [l.jobId],
    );
    expect(audit.rowCount).toBe(1);

    const late = await append(token, l, { events: [ev("process.output", { text: "late" })] });
    expect(late.json().error.code).toBe("STALE_LEASE");
  });

  it("cancels a QUEUED job immediately and refuses to cancel it twice", async () => {
    const jobId = (await createJob()).json().jobId;
    const res = await owner("POST", `/v1/jobs/${jobId}/cancel`);
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("CANCELLED");
    const again = await owner("POST", `/v1/jobs/${jobId}/cancel`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("INVALID_TRANSITION");
    const end = parseSse((await owner("GET", `/v1/jobs/${jobId}/events?afterSequence=3`)).body);
    expect(end.map((e) => e.event)).toEqual(["run-event", "run-event", "end"]);
  });

  it("cancels a RUNNING job via heartbeat and the runner's confirmation", async () => {
    const { token } = await pairRunner();
    await createJob();
    const l = await lease(token);
    await append(token, l, { transition: { to: "RUNNING" } });

    const res = await owner("POST", `/v1/jobs/${l.jobId}/cancel`);
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("RUNNING");
    const hb = await runner(token, "/v1/runner/heartbeat", { activeJobIds: [l.jobId] });
    expect(hb.json()).toEqual({ cancelJobIds: [l.jobId] });

    const confirmed = await append(token, l, {
      events: [ev("job.cancelled", { terminated: true })],
      transition: { to: "CANCELLED" },
    });
    expect(confirmed.json().status).toBe("CANCELLED");
    const audit = await sql.query(
      `select * from audit_records where action = 'job.cancel_requested' and resource_id = $1`,
      [l.jobId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("keeps run_events and audit_records append-only", async () => {
    await expect(sql.query(`update run_events set actor = 'x'`)).rejects.toThrow(/append-only/);
    await expect(sql.query(`delete from audit_records`)).rejects.toThrow(/append-only/);
  });
});
