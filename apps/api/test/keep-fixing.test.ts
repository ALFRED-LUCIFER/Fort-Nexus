import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvals, changesets } from "../src/db/schema.ts";
import { buildAction } from "../src/issue-to-pr.ts";
import { sha256 } from "../src/jobs.ts";
import { BASE_SHA } from "./helpers/fake-github.ts";
import { FAILED, FILES, NOT_CONFIGURED, PASSED, issueRunKit } from "./helpers/issue-run.ts";

// Spec §5: POST /v1/jobs/:id/keep-fixing starts a linked job from a stopped job's stored changeset.

let k: Awaited<ReturnType<typeof issueRunKit>>;

const keepFixing = (id: string, o: { note?: string; key?: string } = {}) =>
  k.owner("POST", `/v1/jobs/${id}/keep-fixing`, {
    key: o.key ?? randomUUID(),
    ...(o.note === undefined ? {} : { body: { note: o.note } }),
  });
const row = async (id: string) =>
  (await k.sql.query(`select * from jobs where id = $1`, [id])).rows[0] as Record<string, unknown>;
const audits = async (action: string) =>
  (await k.sql.query(`select * from audit_records where action = $1 order by occurred_at`, [action])).rows;
/** A NEEDS_INFO job: the agent stopped with questions and stored no changeset. */
async function needsInfoJob() {
  const l = await k.runningJob();
  for (const transition of [{ to: "VERIFYING" }, { to: "COMPLETED", outcome: "NEEDS_INFO" }]) {
    const res = await k.runner(`/v1/runner/jobs/${l.jobId}/events`, {
      batchId: randomUUID(),
      fencingToken: l.fencingToken,
      events: [],
      transition,
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  return l.jobId;
}
/** medvya #213: an approval still pending from before the gate, whose own tests failed and whose changeset kept none. */
async function legacyPendingApproval() {
  const l = await k.runningJob();
  const [job] = await k.sql.query(`select * from jobs where id = $1`, [l.jobId]).then((r) => r.rows);
  const files = [...FILES].sort((a, b) => (a.path < b.path ? -1 : 1)) as never[];
  const sha = sha256(l.jobId);
  const snapshot = job.issue_snapshot;
  await k.db.insert(changesets).values({
    jobId: l.jobId,
    runnerId: job.runner_id,
    fencingToken: l.fencingToken,
    baseSha: BASE_SHA,
    sha256: sha,
    files,
    stats: { added: 3, removed: 1 },
    agentSummary: "Rounded totals.",
    verification: null,
  });
  const action = buildAction(
    l.jobId,
    snapshot,
    files,
    {
      stats: { added: 3, removed: 1 },
      agentSummary: "Rounded totals.",
      verification: FAILED,
      integrity: { clean: true, problems: [] },
    },
    sha,
  );
  const [a] = await k.db
    .insert(approvals)
    .values({
      jobId: l.jobId,
      projectId: k.projectId,
      riskTier: "R2",
      status: "PENDING",
      action,
      actionHash: sha256(JSON.stringify(action)),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  await k.sql.query(`update jobs set status = 'AWAITING_APPROVAL', lease_expires_at = null where id = $1`, [
    l.jobId,
  ]);
  return { jobId: l.jobId, approval: a! };
}

beforeAll(async () => {
  k = await issueRunKit();
});
afterAll(async () => k?.close());
beforeEach(async () => k.reset());

describe("keep fixing", () => {
  it("starts a linked job from the stored changeset, on the same base and issue snapshot, with the note", async () => {
    const id = await k.stoppedJob();
    const before = await row(id);
    const issueReads = () => k.gh.calls.filter((c) => c.path.includes("/issues/")).length;
    const reads = issueReads();

    const res = await keepFixing(id, { note: "Use banker's rounding" });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json() as { jobId: string; status: string; streamUrl: string };
    expect(body).toEqual({
      jobId: expect.any(String) as string,
      status: "QUEUED",
      streamUrl: `/v1/jobs/${body.jobId}/events`,
    });

    const next = await row(body.jobId);
    expect(next).toMatchObject({
      retry_of_job_id: id,
      continues_changeset: true,
      owner_note: "Use banker's rounding",
      agent: before.agent,
      initiator_id: before.initiator_id,
      project_id: before.project_id,
      risk_tier: "R1",
    });
    expect(next.issue_snapshot).toEqual(before.issue_snapshot); // not pinned again from GitHub
    expect(next.request).toEqual(before.request);
    expect(issueReads()).toBe(reads);
    expect(await k.job(id)).toMatchObject({ status: "FAILED", outcome: "FAILED_TESTS" }); // a stopped job is left as it was
    expect(await k.job(body.jobId)).toMatchObject({ retryOfJobId: id });

    const [entry] = await audits("job.keep_fixing");
    expect(entry).toMatchObject({ resource_id: body.jobId });
    expect(entry.metadata).toMatchObject({ retryOfJobId: id, continuesChangeset: true });
  });

  it("works without a note", async () => {
    const id = await k.stoppedJob();
    const res = await keepFixing(id);
    expect(res.statusCode, res.body).toBe(202);
    expect(await row(res.json().jobId)).toMatchObject({ continues_changeset: true, owner_note: null });
  });

  it("hands the stored files and the note to the runner with the lease", async () => {
    const id = await k.stoppedJob();
    const created = (await keepFixing(id, { note: "Mind the cents" })).json() as { jobId: string };
    const l = await k.lease();
    expect(l.jobId).toBe(created.jobId);
    expect(l.task).toMatchObject({
      kind: "issue_to_pr",
      continuation: { files: [...FILES].sort((a, b) => (a.path < b.path ? -1 : 1)), note: "Mind the cents" },
    });
  });

  it("withdraws a pending approval from before the gate (medvya #213) and cancels the old job", async () => {
    const { jobId, approval } = await legacyPendingApproval();
    const res = await keepFixing(jobId, { note: "Fix the failing test" });
    expect(res.statusCode, res.body).toBe(202);

    const [a] = await k.sql.query(`select * from approvals where id = $1`, [approval.id]).then((r) => r.rows);
    expect(a).toMatchObject({ status: "DENIED", decided_by: expect.stringMatching(/^user:/) as string });
    expect(a.error).toContain("Keep fixing");
    expect(a.action_hash).toBe(approval.actionHash); // the frozen action is untouched
    expect(await k.job(jobId)).toMatchObject({ status: "CANCELLED" });
    const types = (
      await k.sql.query(`select type from run_events where job_id = $1 order by sequence`, [jobId])
    ).rows.map((r: { type: string }) => r.type);
    expect(types.slice(-3)).toEqual(["approval.decided", "job.cancelled", "job.state.changed"]);
    expect((await audits("approval.withdraw"))[0]).toMatchObject({ resource_id: approval.id });
    expect(await row(res.json().jobId)).toMatchObject({ retry_of_job_id: jobId, continues_changeset: true });

    // The withdrawn approval can't be decided any more.
    const decide = await k.owner("POST", `/v1/approvals/${approval.id}/decision`, {
      body: { decision: "approve", actionHash: approval.actionHash },
    });
    expect(decide.statusCode).toBe(409);
    // The cancelled job still has its changes and nothing was pushed, so another Keep fixing is allowed.
    expect((await keepFixing(jobId)).statusCode).toBe(202);
  });

  it("a concurrent approve and Keep fixing queue behind each other: no deadlock, no 500", async () => {
    for (let i = 0; i < 6; i++) {
      const { jobId, approval } = await legacyPendingApproval();
      const [decided, kept] = await Promise.all([
        k.owner("POST", `/v1/approvals/${approval.id}/decision`, {
          body: { decision: "approve", actionHash: approval.actionHash },
        }),
        keepFixing(jobId),
      ]);
      // The approval's tests failed, so approving is always refused; Keep fixing either wins or sees the refusal.
      expect(decided.statusCode, decided.body).toBe(409);
      expect([202, 409], kept.body).toContain(kept.statusCode);
      await k.sql.query(
        `update jobs set status = 'FAILED', lease_expires_at = null where status in ('PREPARING','RUNNING','VERIFYING')`,
      );
      await k.reset();
    }
  });

  it("waits for the approval's lock before taking the job's, in the order approve does", async () => {
    const { jobId, approval } = await legacyPendingApproval();
    const c = await k.sql.connect();
    try {
      await c.query("begin");
      await c.query(`select 1 from approvals where id = $1 for update`, [approval.id]);
      const waiting = keepFixing(jobId);
      await new Promise((r) => setTimeout(r, 400));
      // Keep fixing is stuck on the approval; had it already locked the job, an approve holding the approval
      // and reaching for the job would deadlock with it.
      await c.query(`select 1 from jobs where id = $1 for update nowait`, [jobId]);
      await c.query("commit");
      const res = await waiting;
      expect(res.statusCode, res.body).toBe(202);
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  });

  it("refuses not_configured and points to Run again", async () => {
    const id = await k.stoppedJob(NOT_CONFIGURED);
    const res = await keepFixing(id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toMatch(/Run again/);
    expect(await k.sql.query(`select 1 from jobs where retry_of_job_id = $1`, [id])).toHaveProperty(
      "rowCount",
      0,
    );
  });

  it("refuses a changeset whose tests passed, pending or finished, and a pushed one", async () => {
    const l = await k.runningJob();
    expect((await k.upload(l, { verification: PASSED })).statusCode).toBe(200); // pending approval
    expect((await keepFixing(l.jobId)).statusCode).toBe(409);
    expect(await k.job(l.jobId)).toMatchObject({ status: "AWAITING_APPROVAL" });
    expect(
      (await k.sql.query(`select status from approvals where job_id = $1`, [l.jobId])).rows[0].status,
    ).toBe("PENDING");

    // Pushed: executed approval, finished job; even with failing recorded tests the push is not undone.
    await k.sql.query(`update approvals set status = 'EXECUTED' where job_id = $1`, [l.jobId]);
    await k.sql.query(`update jobs set status = 'COMPLETED', outcome = 'PR_CREATED' where id = $1`, [
      l.jobId,
    ]);
    const pushed = await keepFixing(l.jobId);
    expect(pushed.statusCode).toBe(409);
    expect(pushed.json().error.message).toMatch(/pull request|pushed/i);
  });

  it("refuses an executed approval even when the stored tests did not pass", async () => {
    const id = await k.stoppedJob();
    const [cs] = await k.sql.query(`select * from changesets where job_id = $1`, [id]).then((r) => r.rows);
    const action = buildAction(
      id,
      (await row(id)).issue_snapshot as never,
      cs.files,
      {
        stats: cs.stats,
        agentSummary: "x",
        verification: FAILED,
        integrity: { clean: true, problems: [] },
      },
      cs.sha256,
    );
    await k.db.insert(approvals).values({
      jobId: id,
      projectId: k.projectId,
      riskTier: "R2",
      status: "EXECUTED",
      action,
      actionHash: sha256(JSON.stringify(action)),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect((await keepFixing(id)).statusCode).toBe(409);
  });

  it("refuses a job that is still working", async () => {
    const l = await k.runningJob();
    const res = await keepFixing(l.jobId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toMatch(/RUNNING/);
    expect(await k.job(l.jobId)).toMatchObject({ status: "RUNNING" });
  });

  it("refuses a job with nothing stored to continue from, and a diagnostic job", async () => {
    const l = await k.runningJob();
    await k.sql.query(`update jobs set status = 'FAILED', lease_expires_at = null where id = $1`, [l.jobId]);
    const none = await keepFixing(l.jobId);
    expect(none.statusCode).toBe(409);
    expect(none.json().error.message).toMatch(/Run again/);

    const diag = await k.owner("POST", "/v1/jobs", {
      key: randomUUID(),
      body: { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version", projectId: k.projectId },
    });
    const id = diag.json().jobId as string;
    await k.owner("POST", `/v1/jobs/${id}/cancel`);
    expect((await keepFixing(id)).statusCode).toBe(409);
  });

  it("answers an owner's own NEEDS_INFO job with a note: a new job, no files, nothing continued", async () => {
    const id = await needsInfoJob();
    expect((await keepFixing(id)).statusCode).toBe(400); // the questions need an answer
    const res = await keepFixing(id, { note: "Round to 2 decimals" });
    expect(res.statusCode, res.body).toBe(202);
    expect(await row(res.json().jobId)).toMatchObject({
      retry_of_job_id: id,
      continues_changeset: false,
      owner_note: "Round to 2 decimals",
    });
    const l = await k.lease();
    expect(l.jobId).toBe(res.json().jobId);
    expect(l.task?.continuation).toEqual({ files: [], note: "Round to 2 decimals" });
  });

  it("is idempotent per key, and a retry's key can't be replayed as keep fixing", async () => {
    const id = await k.stoppedJob();
    const key = randomUUID();
    const first = await keepFixing(id, { key, note: "a" });
    const again = await keepFixing(id, { key, note: "a" });
    expect(again.statusCode).toBe(202);
    expect(again.json().jobId).toBe(first.json().jobId);
    expect((await k.sql.query(`select 1 from jobs where retry_of_job_id = $1`, [id])).rowCount).toBe(1);
    const other = await keepFixing(id, { key, note: "b" });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const retryKey = randomUUID();
    expect((await k.owner("POST", `/v1/jobs/${id}/retry`, { key: retryKey })).statusCode).toBe(202);
    const crossed = await keepFixing(id, { key: retryKey });
    expect(crossed.statusCode).toBe(409);
    expect(crossed.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("replays a keep fixing that withdrew an approval instead of refusing the now-cancelled job", async () => {
    const { jobId } = await legacyPendingApproval();
    const key = randomUUID();
    const first = await keepFixing(jobId, { key });
    const again = await keepFixing(jobId, { key });
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json().jobId).toBe(first.json().jobId);
  });

  it("is blocked by the emergency stop and the daily budget, and then withdraws nothing", async () => {
    const { jobId, approval } = await legacyPendingApproval();
    expect((await k.owner("PUT", "/v1/system/emergency-stop", { body: { engaged: true } })).statusCode).toBe(
      200,
    );
    const stopped = await keepFixing(jobId);
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json().error.code).toBe("EMERGENCY_STOP");
    expect((await k.owner("PUT", "/v1/system/emergency-stop", { body: { engaged: false } })).statusCode).toBe(
      200,
    );

    await k.sql.query(`update system_controls set daily_budget_usd = 1`);
    const broke = await keepFixing(jobId);
    expect(broke.statusCode).toBe(409);
    await k.sql.query(`update system_controls set daily_budget_usd = 20`);

    expect(await k.job(jobId)).toMatchObject({ status: "AWAITING_APPROVAL" });
    expect(
      (await k.sql.query(`select status from approvals where id = $1`, [approval.id])).rows[0].status,
    ).toBe("PENDING");
  });

  it("answers 404 for another owner's job and for an unknown one", async () => {
    const id = await k.stoppedJob();
    await k.sql.query(
      `insert into "user" (id, name, email) values ('decoy-user', 'Decoy', 'decoy@example.com') on conflict do nothing`,
    );
    await k.sql.query(`update jobs set initiator_id = 'decoy-user' where id = $1`, [id]);
    expect((await keepFixing(id)).statusCode).toBe(404);
    expect((await keepFixing(randomUUID())).statusCode).toBe(404);
    expect((await k.sql.query(`select 1 from jobs where retry_of_job_id = $1`, [id])).rowCount).toBe(0);
  });

  it("needs an Idempotency-Key and rejects an over-long note", async () => {
    const id = await k.stoppedJob();
    expect((await k.owner("POST", `/v1/jobs/${id}/keep-fixing`)).statusCode).toBe(400);
    expect((await keepFixing(id, { note: "x".repeat(2001) })).statusCode).toBe(400);
  });
});
