import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { issueRunKit } from "./helpers/issue-run.ts";

// Spec §6: the Developer's effective profile applies to jobs started directly (POST /v1/jobs and Run again):
// the budget is capped by its limits and the lease carries its model. Plan steps keep their own behaviour.

let k: Awaited<ReturnType<typeof issueRunKit>>;

const setProfile = (over: Record<string, unknown> = {}) =>
  k.owner("PUT", "/v1/agents/DEVELOPER/profile", {
    body: {
      level: { kind: "PROJECT", projectId: k.projectId },
      settings: {
        engine: "MESSAGES_API",
        autonomy: "ACT_WITH_APPROVAL",
        tools: ["jobs.read", "jobs.create.issue_run"],
        maxCostUsdPerTask: 1.5,
        maxTurns: 10,
        responseDetail: "STANDARD",
        model: "claude-test-model",
        ...over,
      },
    },
  });
const stored = async (id: string) =>
  (await k.sql.query(`select request from jobs where id = $1`, [id])).rows[0].request.budget as {
    maxCostUsd: number;
    maxTurns: number;
    maxWallClockMinutes: number;
  };

beforeAll(async () => {
  k = await issueRunKit();
});
afterAll(async () => k?.close());
beforeEach(async () => {
  await k.reset();
  // Versions are append-only: the newest one wins, so each test starts from the defaults' limits and no model.
  await setProfile({ maxCostUsdPerTask: 5, maxTurns: 60, model: undefined });
});

describe("Developer profile for direct issue jobs", () => {
  it("caps the budget by the profile, never raises it, and the lease carries the model", async () => {
    expect((await setProfile()).statusCode).toBe(200);
    const big = await k.createIssueJob({ budget: { maxCostUsd: 5, maxTurns: 60 } });
    expect(big.statusCode, big.body).toBe(202);
    expect(await stored(big.json().jobId)).toEqual({
      maxWallClockMinutes: 45,
      maxCostUsd: 1.5,
      maxTurns: 10,
    });
    const small = await k.createIssueJob({ budget: { maxCostUsd: 0.5, maxTurns: 5 } });
    expect(await stored(small.json().jobId)).toMatchObject({ maxCostUsd: 0.5, maxTurns: 5 });

    const l = await k.lease();
    expect(l.jobId).toBe(big.json().jobId);
    expect(l.request).toMatchObject({ budget: { maxCostUsd: 1.5, maxTurns: 10 } });
    expect(l.task?.model).toBe("claude-test-model");
  });

  it("Run again is capped by the profile as it is now", async () => {
    const first = await k.createIssueJob();
    const id = first.json().jobId as string;
    expect(await stored(id)).toMatchObject({ maxCostUsd: 5, maxTurns: 60 });
    await k.owner("POST", `/v1/jobs/${id}/cancel`);
    expect((await setProfile({ maxCostUsdPerTask: 2, maxTurns: 20 })).statusCode).toBe(200);
    const again = await k.owner("POST", `/v1/jobs/${id}/retry`, { key: randomUUID() });
    expect(again.statusCode, again.body).toBe(202);
    expect(await stored(again.json().jobId)).toMatchObject({ maxCostUsd: 2, maxTurns: 20 });
  });

  it("a replay under the same key returns the same job even after the profile changed", async () => {
    const key = randomUUID();
    const first = await k.createIssueJob({}, key);
    expect((await setProfile()).statusCode).toBe(200);
    const again = await k.createIssueJob({}, key);
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json().jobId).toBe(first.json().jobId);
  });

  it("without a model in the profile the lease names none; a plan step's job never gets one", async () => {
    expect((await setProfile({ model: undefined })).statusCode).toBe(200);
    await k.createIssueJob();
    const l = await k.lease();
    expect(l.task?.model).toBeUndefined();

    await k.sql.query(`update jobs set status = 'FAILED', lease_expires_at = null where id = $1`, [l.jobId]);
    expect((await setProfile()).statusCode).toBe(200);
    const planned = await k.createIssueJob();
    await k.sql.query(`update jobs set idempotency_key = $2 where id = $1`, [
      planned.json().jobId,
      `plan:${randomUUID()}:0`,
    ]);
    expect((await k.lease()).task?.model).toBeUndefined();
  });
});
