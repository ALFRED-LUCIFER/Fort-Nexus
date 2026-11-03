import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentProfileSettings,
  DeepDive,
  DeepDiveDetail,
  DeepDiveList,
  WorkspaceList,
} from "@nexus/contracts";
import { createDb, type Db } from "../src/db/index.ts";
import {
  researchFindingSources,
  researchFindings,
  researchRuns,
  researchWatchlists,
} from "../src/research/schema.ts";
import { createTestApp, homeProjectId, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// The deep-dive routes end to end: the app's own diver, the real Anthropic SDK and the adapters' fetch path, with the
// provider and the web stubbed at fetch level. Engine rules are covered in deep-dives.test.ts.

const profiles = vi.hoisted(() => ({ ai: {} as Partial<AgentProfileSettings> }));
vi.mock("../src/agents/service.ts", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/agents/service.ts")>();
  return {
    ...m,
    resolveAgentProfile: async (...args: Parameters<typeof m.resolveAgentProfile>) => {
      const p = await m.resolveAgentProfile(...args);
      return args[3] === "AI_RESEARCHER" ? { ...p, settings: { ...p.settings, ...profiles.ai } } : p;
    },
  };
});

const MODEL = "claude-test-model";
const PAGE = "https://acme.dev/blog/sdk-2";
const QUOTE = "Acme SDK 2.0 drops support for Node 18.";

let t: TestApp;
let db: Db;
let sql: pg.Pool;
let cookie: string;
let projectId: string;
let dir: string;
let aiFile: string;
let requests: Record<string, unknown>[];

const call = (method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({
    method,
    url,
    headers: { cookie, origin: t.config.publicOrigin, ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });
const start = (body: Record<string, unknown>, key: string = randomUUID()) =>
  call(
    "POST",
    "/v1/research/deep-dives",
    { projectId, question: "What does Acme SDK 2.0 change for us?", maxCostUsd: 1, ...body },
    { "idempotency-key": key },
  );

async function seedFinding() {
  const scope = {
    workspaceId: (await sql.query(`select workspace_id from projects where id = $1`, [projectId])).rows[0]
      .workspace_id as string,
    projectId,
  };
  const [w] = await db
    .insert(researchWatchlists)
    .values({
      ...scope,
      name: "SDKs",
      keywords: [],
      sources: [],
      weights: { credibility: 25, relevance: 25, novelty: 20, impact: 15, opportunity: 15 },
      schedule: { localTime: "08:00", timezone: "UTC", days: [1], paused: true },
      createdBy: "test",
    })
    .returning();
  const [r] = await db
    .insert(researchRuns)
    .values({ ...scope, watchlistId: w!.id, trigger: "MANUAL", status: "COMPLETED" })
    .returning();
  const [f] = await db
    .insert(researchFindings)
    .values({
      ...scope,
      watchlistId: w!.id,
      firstRunId: r!.id,
      title: "Acme SDK 2.0",
      excerpt: "",
      canonicalUrl: PAGE,
      label: "UNVERIFIED",
      scoreBreakdown: { credibility: 1, relevance: 1, novelty: 1, impact: 0, opportunity: 0 },
    })
    .returning();
  await db.insert(researchFindingSources).values({
    ...scope,
    findingId: f!.id,
    watchlistId: w!.id,
    url: PAGE,
    publisher: "acme.dev",
    tier: "PRIMARY",
    title: "Acme SDK 2.0",
    fetchedAt: new Date(),
  });
  return f!.id;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nexus-deep-"));
  aiFile = join(dir, "ai.json");
  writeFileSync(
    aiFile,
    JSON.stringify({
      provider: "anthropic",
      apiKey: `sk-ant-${randomBytes(24).toString("hex")}`,
      model: MODEL,
    }),
    { mode: 0o600 },
  );
  t = await createTestApp({ NEXUS_AI_FILE: aiFile, NEXUS_SEARCH_FILE: join(dir, "search.json") });
  ({ db, pool: sql } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  projectId = await homeProjectId(t, cookie);
  (await call("GET", "/v1/workspaces")).json<WorkspaceList>();
});
afterAll(async () => {
  await t?.app.close();
  await sql?.end();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  requests = [];
  profiles.ai = {
    tools: ["research.deep_dive"],
    autonomy: "ACT_WITH_APPROVAL",
    maxCostUsdPerTask: 2,
    maxTurns: 5,
  };
  vi.restoreAllMocks();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://acme.dev/robots.txt") return new Response("User-agent: *\nAllow: /\n");
    if (url === PAGE)
      return new Response(
        `<html><head><title>Acme SDK 2.0</title></head><body><p>${QUOTE} Streaming lands too.</p><script>x()</script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    if (url !== "https://api.anthropic.com/v1/messages") throw new Error(`unexpected fetch in test: ${url}`);
    requests.push(JSON.parse(input instanceof Request ? await input.text() : String(init?.body)));
    return Response.json({
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "record_report",
          input: {
            summary: `Acme drops Node 18 [0] (${PAGE}).`,
            claims: [
              { id: 0, text: "Node 18 dropped", basis: "OBSERVED", evidence: [{ url: PAGE, quote: QUOTE }] },
            ],
            contradictions: [],
            openQuestions: [],
            confidence: "MEDIUM",
            opportunity: null,
          },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 2000, output_tokens: 300 },
    });
  });
});

describe("/v1/research/deep-dives", () => {
  it("Idempotency-Key is required; 409 with the runbook without ai.json, or without search.json and findings", async () => {
    const noKey = await call("POST", "/v1/research/deep-dives", {
      projectId,
      question: "A question to research",
      maxCostUsd: 1,
    });
    expect(noKey.statusCode).toBe(400);
    const noSearch = await start({});
    expect(noSearch.statusCode).toBe(409);
    expect(noSearch.json().error.details).toMatchObject({
      reason: "search_provider_not_configured",
      runbook: "docs/runbooks/web-search.md",
    });
    renameSync(aiFile, `${aiFile}.off`);
    try {
      const noAi = await start({});
      expect(noAi.statusCode).toBe(409);
      expect(noAi.json().error.details).toMatchObject({
        reason: "ai_provider_not_configured",
        runbook: "docs/runbooks/ai-provider.md",
      });
    } finally {
      renameSync(`${aiFile}.off`, aiFile);
    }
    expect(
      (await call("GET", `/v1/research/deep-dives?projectId=${projectId}`)).json<DeepDiveList>().items,
    ).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("202 from findings without search; replay returns the same dive; it completes with a verified claim", async () => {
    const findingId = await seedFinding();
    const key = randomUUID();
    const first = await start({ findingIds: [findingId], depth: "QUICK" }, key);
    expect(first.statusCode, first.body).toBe(202);
    const dive = first.json<DeepDive>();
    expect(dive).toMatchObject({
      status: "QUEUED",
      limits: { maxCostUsd: 1, maxTurns: 5, maxSearches: 0, maxFetches: 8 },
      model: MODEL,
    });
    const again = await start({ findingIds: [findingId], depth: "QUICK" }, key);
    expect(again.json<DeepDive>().id).toBe(dive.id);

    let detail!: DeepDiveDetail;
    await vi.waitFor(
      async () => {
        detail = (await call("GET", `/v1/research/deep-dives/${dive.id}`)).json<DeepDiveDetail>();
        expect(detail.status).toBe("COMPLETED");
      },
      { timeout: 10_000 },
    );
    expect(detail.report!.claims[0]).toMatchObject({
      label: "UNVERIFIED",
      evidence: [{ url: PAGE, verified: true, tier: "COMMUNITY" }],
    });
    expect(detail.report!.summary).toBe(`Acme drops Node 18 [0] (${PAGE}).`);
    expect(detail.steps.map((s) => [s.kind, s.outcome])).toEqual([
      ["FETCH", "OK"],
      ["MODEL", "OK"],
    ]);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain(QUOTE);

    const list = (await call("GET", `/v1/research/deep-dives?projectId=${projectId}`)).json<DeepDiveList>();
    expect(list.items.map((d) => d.id)).toEqual([dive.id]);
    const cancel = await call("POST", `/v1/research/deep-dives/${dive.id}/cancel`);
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json<DeepDive>().status).toBe("COMPLETED");
  });

  it("404 for unknown ids; 400 for a cursor that isn't one", async () => {
    expect((await call("GET", `/v1/research/deep-dives/${randomUUID()}`)).statusCode).toBe(404);
    expect((await call("POST", `/v1/research/deep-dives/${randomUUID()}/cancel`)).statusCode).toBe(404);
    expect((await call("GET", `/v1/research/deep-dives?cursor=nope`)).statusCode).toBe(400);
  });
});
