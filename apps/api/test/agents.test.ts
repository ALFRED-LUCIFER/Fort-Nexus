import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  AgentKey,
  AgentList,
  AgentProfileSettings,
  AgentProfileVersion,
  AgentProfileVersionList,
  EffectiveAgentProfile,
  Project,
  WorkspaceList,
} from "@nexus/contracts";
import {
  CEILING,
  DEFAULT_AGENT_SETTINGS,
  applyCeiling,
  pinnedAgentProfile,
  resolveAgentProfile,
} from "../src/agents/service.ts";
import { createDb, type Db } from "../src/db/index.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// EPIC AGT FR-AGT-06/07, FR-WKS-04/05, PRD C-04: registry, versioned profiles, resolution order, the global ceiling
// and project scope (NFR-CNV-05). Talk pinning is in conversations.test.ts.

const settings = (over: Partial<AgentProfileSettings> = {}): AgentProfileSettings => ({
  engine: "MESSAGES_API",
  autonomy: "ACT_WITH_APPROVAL",
  tools: ["jobs.read"],
  maxCostUsdPerTask: 2,
  maxTurns: 20,
  responseDetail: "BRIEF",
  ...over,
});

describe("global ceiling (C-04, §11.16)", () => {
  it("keeps AUTONOMOUS only when every allowed tool is R0/R1", () => {
    const s = settings({ autonomy: "AUTONOMOUS", tools: ["jobs.read", "jobs.create.issue_run"] });
    expect(applyCeiling("DEVELOPER", s)).toEqual({ settings: s, ceilingApplied: [] });
    // A tool rated R2 (e.g. a future write) caps the dial; the stored settings object is not touched.
    const capped = applyCeiling("DEVELOPER", s, { ...DEFAULT_RISK, "jobs.create.issue_run": "R2" });
    expect(capped.settings.autonomy).toBe("ACT_WITH_APPROVAL");
    expect(capped.ceilingApplied).toEqual([
      "AUTONOMOUS capped to ACT_WITH_APPROVAL: jobs.create.issue_run always need your approval",
    ]);
    expect(s.autonomy).toBe("AUTONOMOUS");
  });

  it("allows the coding engine only for Developer and QA", () => {
    const s = settings({ engine: "CLAUDE_AGENT_SDK" });
    expect(applyCeiling("DEVELOPER", s).settings.engine).toBe("CLAUDE_AGENT_SDK");
    expect(applyCeiling("QA", s).settings.engine).toBe("CLAUDE_AGENT_SDK");
    for (const agent of [
      "CHIEF_OF_STAFF",
      "DEVOPS",
      "PRODUCT",
      "AI_RESEARCHER",
      "FINANCIAL_ANALYST",
    ] as const) {
      const r = applyCeiling(agent, s);
      expect(r.settings.engine).toBe("MESSAGES_API");
      expect(r.ceilingApplied).toEqual([expect.stringMatching(/^CLAUDE_AGENT_SDK capped to MESSAGES_API/)]);
    }
  });

  it("caps cost and turns even for a stored value above today's ceiling", () => {
    const r = applyCeiling("QA", settings({ maxCostUsdPerTask: 80, maxTurns: 500 }));
    expect(r.settings).toMatchObject({
      maxCostUsdPerTask: CEILING.maxCostUsdPerTask,
      maxTurns: CEILING.maxTurns,
    });
    expect(r.ceilingApplied).toEqual(["maxCostUsdPerTask capped to 50", "maxTurns capped to 200"]);
  });

  it("leaves every built-in default untouched", () => {
    for (const [agent, s] of Object.entries(DEFAULT_AGENT_SETTINGS))
      expect(applyCeiling(agent as AgentKey, s).ceilingApplied).toEqual([]);
  });
});

const DEFAULT_RISK = {
  "jobs.read": "R0",
  "jobs.create.diagnostic": "R1",
  "jobs.create.issue_run": "R1",
  "github.read": "R0",
  "research.search": "R0",
  "research.run": "R0",
  "business.metrics": "R0",
  "monitoring.read": "R0",
} as const;

let t: TestApp;
let app: FastifyInstance;
let sql: pg.Pool;
let db: Db;
let cookie: string;
let ownerId: string;
let ws: WorkspaceList;
let devWs: string;

const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, body?: unknown) =>
  app.inject({
    method,
    url,
    headers: { cookie, origin: t.config.publicOrigin },
    ...(body === undefined ? {} : { payload: body as object }),
  });
async function newProject(mode: "DEV" | "BUSINESS" = "DEV") {
  const slug = `p-${randomBytes(3).toString("hex")}`;
  const wsId = ws.items.find((w) => w.mode === mode)!.id;
  const res = await call("POST", `/v1/workspaces/${wsId}/projects`, { name: `Project ${slug}`, slug });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Project;
}
const put = (agent: AgentKey, level: object, s: AgentProfileSettings) =>
  call("PUT", `/v1/agents/${agent}/profile`, { level, settings: s });
async function save(agent: AgentKey, level: object, s: AgentProfileSettings) {
  const res = await put(agent, level, s);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AgentProfileVersion;
}
const onWorkspace = () => ({ kind: "WORKSPACE", workspaceId: devWs });
const onProject = (p: Project) => ({ kind: "PROJECT", projectId: p.id });
async function effective(p: Project, agent: AgentKey): Promise<EffectiveAgentProfile> {
  const res = await call("GET", `/v1/agents?projectId=${p.id}`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as AgentList).items.find((a) => a.agent === agent)!.effective;
}
const history = async (p: Project, agent: AgentKey) => {
  const res = await call("GET", `/v1/agents/${agent}/versions?projectId=${p.id}`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as AgentProfileVersionList).items;
};

beforeAll(async () => {
  t = await createTestApp();
  app = t.app;
  ({ pool: sql, db } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  ownerId = (await call("GET", "/v1/me")).json<{ id: string }>().id;
  ws = (await call("GET", "/v1/workspaces")).json() as WorkspaceList;
  devWs = ws.items.find((w) => w.mode === "DEV")!.id;
});
afterAll(async () => {
  await app?.close();
  await sql?.end();
});

describe("registry (FR-AGT-07)", () => {
  it("lists the 7 built-in agents with conservative defaults and an empty record", async () => {
    const p = await newProject();
    const res = await call("GET", `/v1/agents?projectId=${p.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json() as AgentList).items;
    expect(items.map((a) => a.agent)).toEqual([
      "CHIEF_OF_STAFF",
      "DEVELOPER",
      "QA",
      "DEVOPS",
      "PRODUCT",
      "AI_RESEARCHER",
      "FINANCIAL_ANALYST",
    ]);
    for (const a of items) {
      expect(a.label).not.toBe("");
      expect(a.effective).toMatchObject({
        versionId: null,
        level: "DEFAULT",
        version: 0,
        ceilingApplied: [],
      });
      expect(a.record).toEqual({ stepsSucceeded: 0, stepsFailed: 0, lastActiveAt: null });
    }
    const by = (k: AgentKey) => items.find((a) => a.agent === k)!.effective.settings;
    expect(by("CHIEF_OF_STAFF").tools).toHaveLength(8);
    expect(by("DEVELOPER").tools).toEqual(["jobs.read", "jobs.create.issue_run", "github.read"]);
    expect(by("FINANCIAL_ANALYST").tools).toEqual(["business.metrics"]);
    expect(by("PRODUCT").autonomy).toBe("DRAFT");
    expect(
      items.filter((a) => a.effective.settings.autonomy !== "ACT_WITH_APPROVAL").map((a) => a.agent),
    ).toEqual(["PRODUCT"]);
  });

  it("needs a project to resolve, and rejects unknown agents and invalid settings", async () => {
    expect((await call("GET", "/v1/agents")).statusCode).toBe(400);
    expect((await call("GET", `/v1/agents?projectId=${randomUUID()}`)).statusCode).toBe(404);
    const p = await newProject();
    expect((await put("JANITOR" as AgentKey, onProject(p), settings())).statusCode).toBe(400);
    for (const bad of [
      { maxTurns: 201 },
      { maxCostUsdPerTask: 51 },
      { tools: ["shell.exec"] },
      { model: "https://evil.example/v1" },
    ])
      expect(
        (await put("QA", onProject(p), { ...settings(), ...bad } as AgentProfileSettings)).statusCode,
      ).toBe(400);
    expect(await history(p, "QA")).toEqual([]);
  });
});

describe("versioned profiles (FR-WKS-04/05)", () => {
  it("resolves project > workspace > built-in default, whole settings per level", async () => {
    const a = await newProject();
    const b = await newProject();
    expect((await effective(a, "QA")).level).toBe("DEFAULT");

    const w1 = await save("QA", onWorkspace(), settings({ responseDetail: "DETAILED", maxTurns: 30 }));
    expect(w1).toMatchObject({ level: "WORKSPACE", workspaceId: devWs, projectId: null, version: 1 });
    for (const p of [a, b])
      expect(await effective(p, "QA")).toMatchObject({ level: "WORKSPACE", versionId: w1.id, version: 1 });

    const p1 = await save("QA", onProject(a), settings({ tools: ["github.read"] }));
    expect(p1).toMatchObject({ level: "PROJECT", projectId: a.id, version: 1 });
    const w2 = await save("QA", onWorkspace(), settings({ responseDetail: "DETAILED", maxTurns: 40 }));
    expect(w2.version).toBe(2);

    // A's project version wins as a whole: no fields merged in from the newer workspace version.
    const ea = await effective(a, "QA");
    expect(ea).toMatchObject({ level: "PROJECT", versionId: p1.id, version: 1 });
    expect(ea.settings).toEqual(settings({ tools: ["github.read"] }));
    expect(await effective(b, "QA")).toMatchObject({ level: "WORKSPACE", versionId: w2.id, version: 2 });
    // Other agents are unaffected.
    expect((await effective(a, "DEVOPS")).level).toBe("DEFAULT");

    // The exported resolver (used by plans and explanations) agrees with the API.
    expect(await resolveAgentProfile(db, ownerId, a.id, "QA")).toEqual(ea);
    await expect(resolveAgentProfile(db, ownerId, randomUUID(), "QA")).rejects.toMatchObject({
      statusCode: 404,
    });
    // A pinned version stays exactly that version after newer ones exist.
    expect((await pinnedAgentProfile(db, "QA", w1.id)).settings.maxTurns).toBe(30);
    expect(await pinnedAgentProfile(db, "QA", null)).toMatchObject({ level: "DEFAULT", versionId: null });
  });

  it("appends a version per change, returns the same one for a repeated PUT, and audits it", async () => {
    const p = await newProject();
    const v1 = await save(
      "AI_RESEARCHER",
      onProject(p),
      settings({ tools: ["research.run", "research.search"] }),
    );
    // Same settings (tools in another order): nothing new is appended.
    const again = await save(
      "AI_RESEARCHER",
      onProject(p),
      settings({ tools: ["research.search", "research.run"] }),
    );
    expect(again.id).toBe(v1.id);
    const v2 = await save("AI_RESEARCHER", onProject(p), settings({ tools: ["research.search"] }));
    expect(v2.version).toBe(2);
    expect((await history(p, "AI_RESEARCHER")).map((v) => v.id)).toEqual([v2.id, v1.id]);

    const audit = await sql.query(
      `select actor, metadata from audit_records where action = 'agent_profile.set' and resource_id = $1`,
      [v2.id],
    );
    expect(audit.rows).toEqual([
      {
        actor: `user:${ownerId}`,
        metadata: expect.objectContaining({
          projectId: p.id,
          agent: "AI_RESEARCHER",
          level: "PROJECT",
          version: 2,
        }),
      },
    ]);
  });

  it("keeps profile versions append-only at the database", async () => {
    const p = await newProject();
    await save("DEVOPS", onProject(p), settings());
    await expect(sql.query(`update agent_profile_versions set version = 9`)).rejects.toThrow(/append-only/);
    await expect(sql.query(`delete from agent_profile_versions`)).rejects.toThrow(/append-only/);
    await expect(sql.query(`truncate agent_profile_versions cascade`)).rejects.toThrow(/append-only/);
  });

  it("stores what the owner asked and applies the ceiling on resolution", async () => {
    const p = await newProject();
    const asked = settings({
      engine: "CLAUDE_AGENT_SDK",
      autonomy: "AUTONOMOUS",
      tools: ["monitoring.read"],
    });
    const v = await save("DEVOPS", onProject(p), asked);
    expect(v.settings).toEqual(asked);
    expect((await history(p, "DEVOPS"))[0]!.settings.engine).toBe("CLAUDE_AGENT_SDK");
    const e = await effective(p, "DEVOPS");
    expect(e.settings).toMatchObject({ engine: "MESSAGES_API", autonomy: "AUTONOMOUS" }); // R0 only: kept
    expect(e.ceilingApplied).toEqual([expect.stringMatching(/^CLAUDE_AGENT_SDK capped to MESSAGES_API/)]);
    await save("DEVELOPER", onProject(p), { ...asked, tools: ["jobs.create.issue_run"] });
    expect(await effective(p, "DEVELOPER")).toMatchObject({
      settings: { engine: "CLAUDE_AGENT_SDK", autonomy: "AUTONOMOUS" },
      ceilingApplied: [],
    });
  });
});

describe("scope (NFR-CNV-05)", () => {
  it("B never sees or resolves A's project versions; workspace versions are shared", async () => {
    const a = await newProject();
    const b = await newProject();
    const own = await save("PRODUCT", onProject(a), settings({ autonomy: "SUGGEST" }));
    expect((await history(a, "PRODUCT")).map((v) => v.id)).toContain(own.id);
    expect((await history(b, "PRODUCT")).map((v) => v.id)).not.toContain(own.id);
    expect((await effective(b, "PRODUCT")).versionId).not.toBe(own.id);
    // The Business workspace's projects never see the Dev workspace's versions.
    const shared = await save("PRODUCT", onWorkspace(), settings({ autonomy: "DRAFT" }));
    expect((await history(b, "PRODUCT")).map((v) => v.id)).toContain(shared.id);
    const biz = await newProject("BUSINESS");
    expect(await history(biz, "PRODUCT")).toEqual([]);
    expect((await effective(biz, "PRODUCT")).level).toBe("DEFAULT");
  });

  it("authorizes each level: the owner's workspace, an active project of the owner", async () => {
    expect((await put("QA", { kind: "WORKSPACE", workspaceId: randomUUID() }, settings())).statusCode).toBe(
      404,
    );
    expect((await put("QA", { kind: "PROJECT", projectId: randomUUID() }, settings())).statusCode).toBe(404);
    const p = await newProject();
    expect((await call("PATCH", `/v1/projects/${p.id}`, { archived: true })).statusCode).toBe(200);
    const res = await put("QA", onProject(p), settings());
    expect(res.statusCode, res.body).toBe(409);
    expect(await history(p, "QA")).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ projectId: p.id })]),
    );
    // Reads of an archived project still resolve.
    expect((await call("GET", `/v1/agents?projectId=${p.id}`)).statusCode).toBe(200);
  });
});
