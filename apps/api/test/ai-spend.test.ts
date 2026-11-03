import { randomUUID } from "node:crypto";
import type pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceList } from "@nexus/contracts";
import { costUsd } from "../src/ai-cost.ts";
import { createDb, type Db } from "../src/db/index.ts";
import { aiSpend } from "../src/db/schema.ts";
import { getSystemControls, reserveAiSpend, settleAiSpend, setEmergencyStop } from "../src/system.ts";
import { createTestApp, homeProjectId, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// FR-CSP-08 / GATE-09: the AI spend ledger (reserve → settle, counted in the daily budget) and the price table.

const TZ = "Asia/Dubai";
let t: TestApp;
let db: Db;
let sql: pg.Pool;
let ownerId: string;
let scope: { workspaceId: string; projectId: string };

const reserve = (maxUsd: number) =>
  db.transaction((tx) =>
    reserveAiSpend(tx, { ...scope, source: "DEEP_DIVE", sourceId: randomUUID(), maxUsd, timezone: TZ }),
  );
const spentToday = async (now = new Date()) => (await getSystemControls(db, TZ, now)).budget.spentTodayUsd;
const setCap = (usd: number) => sql.query(`update system_controls set daily_budget_usd = $1`, [usd]);

beforeAll(async () => {
  t = await createTestApp();
  ({ db, pool: sql } = createDb(t.databaseUrl));
  const cookie = await ownerSession(t);
  const projectId = await homeProjectId(t, cookie);
  const ws = (
    await t.app.inject({ method: "GET", url: "/v1/workspaces", headers: { cookie } })
  ).json<WorkspaceList>();
  scope = { workspaceId: ws.items.find((w) => w.mode === "DEV")!.id, projectId };
  ownerId = (await sql.query(`select owner_id from workspaces where id = $1`, [scope.workspaceId])).rows[0]
    .owner_id as string;
});
afterAll(async () => {
  await t?.app.close();
  await sql?.end();
});
beforeEach(async () => {
  await sql.query(`delete from ai_spend`);
  await setCap(10);
});

describe("ai_spend ledger", () => {
  it("a reservation counts in full until settled, then the measured cost counts; it settles once", async () => {
    const { spendId } = await reserve(2);
    expect(await spentToday()).toBeCloseTo(2, 6);
    await settleAiSpend(db, spendId, 0.123456);
    expect(await spentToday()).toBeCloseTo(0.123456, 6);
    await settleAiSpend(db, spendId, 1.5); // a second settle changes nothing
    const [row] = await db.select().from(aiSpend).where(eq(aiSpend.id, spendId));
    expect(row).toMatchObject({ reservedUsd: 2, costUsd: 0.123456, settledAt: expect.any(Date) });
  });

  it("BUDGET_EXHAUSTED with the same details as a job when the cap doesn't fit; nothing is reserved", async () => {
    await setCap(1);
    await reserve(0.75);
    const err = await reserve(0.5).catch((e: unknown) => e);
    expect(err).toMatchObject({
      statusCode: 409,
      code: "BUDGET_EXHAUSTED",
      message: expect.stringContaining("this deep dive may use up to $0.50"),
      details: {
        dailyCapUsd: 1,
        spentTodayUsd: 0.75,
        remainingUsd: 0.25,
        requestedMaxCostUsd: 0.5,
        resetsAt: expect.any(String),
      },
    });
    expect(await db.select().from(aiSpend)).toHaveLength(1);
    await reserve(0.25); // exactly what is left fits
  });

  it("parallel reservations queue on the controls row and can't overshoot the cap together", async () => {
    await setCap(1);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => reserve(0.3)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results.filter((x) => x.status === "rejected"))
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(await spentToday()).toBeCloseTo(0.9, 6);
  });

  it("an engaged emergency stop refuses a reservation", async () => {
    await setEmergencyStop(db, { ownerId, engaged: true, correlationId: randomUUID() });
    try {
      await expect(reserve(0.1)).rejects.toMatchObject({ statusCode: 409, code: "EMERGENCY_STOP" });
    } finally {
      await setEmergencyStop(db, { ownerId, engaged: false, correlationId: randomUUID() });
    }
    expect(await db.select().from(aiSpend)).toEqual([]);
  });

  it("the day resets at midnight in the owner's timezone (Asia/Dubai = UTC+4)", async () => {
    const at = (iso: string, usd: number) =>
      db.insert(aiSpend).values({
        ...scope,
        source: "DEEP_DIVE",
        sourceId: randomUUID(),
        reservedUsd: usd,
        createdAt: new Date(iso),
      });
    await at("2020-03-01T19:59:00Z", 1); // 23:59 on 1 March in Dubai
    await at("2020-03-01T20:01:00Z", 2); // 00:01 on 2 March in Dubai
    expect(await spentToday(new Date("2020-03-01T19:00:00Z"))).toBeCloseTo(1, 6);
    expect(await spentToday(new Date("2020-03-02T10:00:00Z"))).toBeCloseTo(2, 6);
    expect((await getSystemControls(db, TZ, new Date("2020-03-02T10:00:00Z"))).budget.resetsAt).toBe(
      "2020-03-02T20:00:00.000Z",
    );
  });
});

describe("costUsd", () => {
  const M = 1_000_000;
  const only = (
    k: "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens",
  ) => ({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    [k]: M,
  });

  it("prices input, output, cache writes (5 min and 1 h) and cache reads per model", () => {
    expect(costUsd("claude-opus-5-5", only("input_tokens"))).toBeCloseTo(4, 9);
    expect(costUsd("claude-opus-5-5", only("output_tokens"))).toBeCloseTo(20, 9);
    expect(costUsd("claude-opus-5-5", only("cache_read_input_tokens"))).toBeCloseTo(0.2, 9);
    expect(costUsd("claude-opus-5-5", only("cache_creation_input_tokens"))).toBeCloseTo(5, 9);
    expect(
      costUsd("claude-opus-5-5", {
        ...only("cache_creation_input_tokens"),
        cache_creation: { ephemeral_1h_input_tokens: M / 2, ephemeral_5m_input_tokens: M / 2 },
      }),
    ).toBeCloseTo(4 + 2.5, 9);
    expect(costUsd("claude-sonnet-5-5", only("output_tokens"))).toBeCloseTo(10, 9);
    expect(costUsd("claude-fable-5-1", only("cache_read_input_tokens"))).toBeCloseTo(0.25, 9);
    expect(costUsd("claude-opus-5-20260101", only("input_tokens"))).toBeCloseTo(5, 9); // dated form of claude-opus-5
  });

  it("Haiku 5.5 uses its long-prompt rate over 100K prompt tokens; an unknown model the highest listed price", () => {
    expect(costUsd("claude-haiku-5-5", { ...only("input_tokens"), input_tokens: 100_000 })).toBeCloseTo(
      0.01,
      9,
    );
    expect(costUsd("claude-haiku-5-5", { ...only("input_tokens"), input_tokens: 100_001 })).toBeCloseTo(
      0.0500005,
      9,
    );
    expect(costUsd("my-foundry-deployment", only("output_tokens"))).toBeCloseTo(50, 9);
    expect(costUsd("my-foundry-deployment", only("cache_read_input_tokens"))).toBeCloseTo(1, 9);
  });
});
