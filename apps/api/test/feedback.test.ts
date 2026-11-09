import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JobFeedback, LeaseResponse } from "@nexus/contracts";
import { FAILED, issueRunKit } from "./helpers/issue-run.ts";

// Spec §6a: the owner's messages to a running issue job, and the runner claiming them at each round boundary.

let k: Awaited<ReturnType<typeof issueRunKit>>;

const send = (id: string, text: unknown, key: string | null = randomUUID()) =>
  k.owner("POST", `/v1/jobs/${id}/feedback`, { body: { text }, ...(key ? { key } : {}) });
const list = async (id: string) =>
  (await k.owner("GET", `/v1/jobs/${id}/feedback`)).json() as { items: JobFeedback[] };
const claim = (l: LeaseResponse, round: number, fencingToken = l.fencingToken) =>
  k.runner(`/v1/runner/jobs/${l.jobId}/feedback/claim`, { fencingToken, round });
const claimed = async (l: LeaseResponse, round: number) => {
  const res = await claim(l, round);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: { id: string; text: string }[] }).items;
};

beforeAll(async () => {
  k = await issueRunKit();
});
afterAll(async () => k?.close());
beforeEach(async () => k.reset());

describe("owner feedback", () => {
  it("stores a message for a running issue job, waiting for a round, and lists it", async () => {
    const l = await k.runningJob();
    const res = await send(l.jobId, "  Use banker's rounding  ");
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String) as string,
      jobId: l.jobId,
      text: "Use banker's rounding",
      createdAt: expect.any(String) as string,
      deliveredRound: null,
    });
    expect((await list(l.jobId)).items).toEqual([res.json()]);
  });

  it("is accepted while the job is queued, and audited without the text", async () => {
    const created = (await k.createIssueJob()).json() as { jobId: string };
    const text = "secret-ish guidance the audit trail must not copy";
    const res = await send(created.jobId, text);
    expect(res.statusCode, res.body).toBe(201);
    const rows = (
      await k.sql.query(`select * from audit_records where action = 'job.feedback' and resource_id = $1`, [
        created.jobId,
      ])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({ feedbackId: res.json().id, length: text.length });
    expect(JSON.stringify(rows[0])).not.toContain("secret-ish");
  });

  it("refuses 2,001 characters, an empty message, a missing key and an unknown field", async () => {
    const l = await k.runningJob();
    expect((await send(l.jobId, "x".repeat(2001))).statusCode).toBe(400);
    expect((await send(l.jobId, "x".repeat(2000))).statusCode).toBe(201);
    expect((await send(l.jobId, "   ")).statusCode).toBe(400);
    expect((await send(l.jobId, "hello", null)).statusCode).toBe(400);
    const extra = await k.owner("POST", `/v1/jobs/${l.jobId}/feedback`, {
      key: randomUUID(),
      body: { text: "hi", deliveredRound: 3 },
    });
    expect(extra.statusCode).toBe(400);
    expect((await list(l.jobId)).items).toHaveLength(1);
  });

  it("is idempotent per key: the same message once, a different one under the same key is refused", async () => {
    const l = await k.runningJob();
    const key = randomUUID();
    const first = await send(l.jobId, "one", key);
    const again = await send(l.jobId, "one", key);
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(first.json().id);
    expect((await list(l.jobId)).items).toHaveLength(1);
    const other = await send(l.jobId, "two", key);
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    // The same key on another job is no replay either.
    const l2 = await k.createIssueJob().then((r) => r.json().jobId as string);
    expect((await send(l2, "one", key)).statusCode).toBe(409);
  });

  it("belongs to an issue job of the owner only", async () => {
    const diag = await k.owner("POST", "/v1/jobs", {
      key: randomUUID(),
      body: { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version", projectId: k.projectId },
    });
    const diagId = diag.json().jobId as string;
    expect((await send(diagId, "hi")).statusCode).toBe(409);
    await k.owner("POST", `/v1/jobs/${diagId}/cancel`); // out of the queue: the lease below is the issue job's

    const l = await k.runningJob();
    await k.sql.query(
      `insert into "user" (id, name, email) values ('decoy-user', 'Decoy', 'decoy@example.com') on conflict do nothing`,
    );
    await k.sql.query(`update jobs set initiator_id = 'decoy-user' where id = $1`, [l.jobId]);
    expect((await send(l.jobId, "hi")).statusCode).toBe(404);
    expect((await k.owner("GET", `/v1/jobs/${l.jobId}/feedback`)).statusCode).toBe(404);
    expect((await send(randomUUID(), "hi")).statusCode).toBe(404);
  });

  it("refuses a finished job and points to Keep fixing", async () => {
    const id = await k.stoppedJob();
    const res = await send(id, "one more thing");
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toBe("This job has finished. Use Keep fixing to continue it.");
    expect((await list(id)).items).toEqual([]);
  });

  it("refuses a job waiting for approval: no round will read it, so Keep fixing is the way on", async () => {
    const l = await k.runningJob();
    expect((await k.upload(l)).statusCode).toBe(200); // tests passed: AWAITING_APPROVAL
    const res = await send(l.jobId, "one more thing");
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toMatch(/Keep fixing/);
    expect((await list(l.jobId)).items).toEqual([]);
  });

  it("replays a message already stored even after the job finished", async () => {
    const l = await k.runningJob();
    const key = randomUUID();
    const first = await send(l.jobId, "early", key);
    expect((await k.upload(l, { verification: FAILED })).statusCode).toBe(200);
    const again = await send(l.jobId, "early", key);
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(first.json().id);
  });
});

describe("runner claims feedback", () => {
  it("assigns waiting messages to the round, oldest first, once; a retry of that round gets the same ones", async () => {
    const l = await k.runningJob();
    const a = (await send(l.jobId, "first")).json() as JobFeedback;
    const b = (await send(l.jobId, "second")).json() as JobFeedback;

    expect(await claimed(l, 1)).toEqual([
      { id: a.id, text: "first" },
      { id: b.id, text: "second" },
    ]);
    // A lost response: the runner asks again for round 1 and gets the same messages.
    expect((await claimed(l, 1)).map((i) => i.id)).toEqual([a.id, b.id]);
    expect(await claimed(l, 2)).toEqual([]); // nothing new: round 1's are not delivered again

    const c = (await send(l.jobId, "third")).json() as JobFeedback;
    expect(await claimed(l, 3)).toEqual([{ id: c.id, text: "third" }]);
    expect((await list(l.jobId)).items.map((i) => i.deliveredRound)).toEqual([1, 1, 3]);
  });

  it("round 0 means no round will use them; the owner's list shows it", async () => {
    const l = await k.runningJob();
    const a = (await send(l.jobId, "too late")).json() as JobFeedback;
    expect(await claimed(l, 0)).toEqual([{ id: a.id, text: "too late" }]);
    expect(await claimed(l, 0)).toEqual([{ id: a.id, text: "too late" }]);
    expect(await claimed(l, 1)).toEqual([]);
    expect((await list(l.jobId)).items[0]).toMatchObject({ id: a.id, deliveredRound: 0 });
  });

  it("is atomic: two claims at once deliver each message exactly once", async () => {
    const l = await k.runningJob();
    for (let i = 0; i < 6; i++) await send(l.jobId, `m${i}`);
    const [x, y] = await Promise.all([claimed(l, 1), claimed(l, 2)]);
    const ids = [...x, ...y].map((i) => i.id);
    expect(new Set(ids).size).toBe(6);
    expect(ids).toHaveLength(6);
  });

  it("rejects a stale fencing token, a finished lease and another job's runner", async () => {
    const l = await k.runningJob();
    await send(l.jobId, "waiting");
    const stale = await claim(l, 1, l.fencingToken + 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("STALE_LEASE");
    expect((await list(l.jobId)).items[0]!.deliveredRound).toBeNull(); // nothing was handed out

    await k.sql.query(`update jobs set lease_expires_at = now() - interval '1 minute' where id = $1`, [
      l.jobId,
    ]);
    expect((await claim(l, 1)).statusCode).toBe(409);
    expect((await claim({ ...l, jobId: randomUUID() }, 1)).statusCode).toBe(404);
    expect(
      (await k.runner(`/v1/runner/jobs/${l.jobId}/feedback/claim`, { fencingToken: l.fencingToken }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await k.runner(
          `/v1/runner/jobs/${l.jobId}/feedback/claim`,
          { fencingToken: 1, round: 1 },
          "bad-token",
        )
      ).statusCode,
    ).toBe(401);
  });
});
