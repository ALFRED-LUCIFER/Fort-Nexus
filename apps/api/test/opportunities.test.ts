import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROPOSAL_TTL_MS,
  type Claim,
  type DeepDiveReport,
  type IssuePreview,
  type Opportunity,
  type OpportunityDraft,
  type Project,
  type WorkspaceList,
} from "@nexus/contracts";
import { createDb, type Db } from "../src/db/index.ts";
import { auditRecords, projectRepositories } from "../src/db/schema.ts";
import { canonical, sha256 } from "../src/jobs.ts";
import { opportunityIssueRequests, researchOpportunities } from "../src/research/opportunities/schema.ts";
import { recordOpportunity } from "../src/research/opportunities/service.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// FR-RES-10 / FR-CXR-09 (wave 5 module C): recorded opportunities, ranking, the server-built issue preview and the
// R2 create (RES-G12: exactly one issue, even after a crash once GitHub created it). GitHub is a stateful fake at
// fetch level; Octokit, token minting and the API are production code.

const GH = "https://api.github.com";

type Call = { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> };
type GhIssue = {
  number: number;
  title: string;
  body: string;
  state: string;
  user: { login: string; type: string };
  html_url: string;
  created_at: string;
  updated_at: string;
};

function fakeGithub(bot: string) {
  const calls: Call[] = [];
  const issues: GhIssue[] = [];
  // createThenFail: GitHub creates the issue but the answer never arrives (the API died or the network dropped).
  const state = { createThenFail: false, issuesPermission: "write" };
  const tokens = new Map<string, number>();
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const repo = (id: number, fullName: string) => ({
    id,
    name: fullName.split("/")[1],
    full_name: fullName,
    owner: { login: fullName.split("/")[0] },
    private: true,
    default_branch: "main",
    html_url: `https://github.com/${fullName}`,
    pushed_at: null,
    updated_at: null,
  });
  const permissions = (inst: number) =>
    inst === 1
      ? { metadata: "read", issues: state.issuesPermission, contents: "write", pull_requests: "write" }
      : { metadata: "read", issues: "read" };
  const addIssue = (title: string, body: string, login: string) => {
    const number = issues.length + 1;
    const now = new Date().toISOString();
    const i = {
      number,
      title,
      body,
      state: "open",
      user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
      html_url: `https://github.com/acme/web/issues/${number}`,
      created_at: now,
      updated_at: now,
    };
    issues.push(i);
    return i;
  };

  function route(c: Call): Response | undefined {
    const key = `${c.method} ${c.path}`;
    let m: RegExpMatchArray | null;
    if (key === "GET /app/installations")
      return json(
        [1, 2].map((id) => ({
          id,
          account: { login: id === 1 ? "acme" : "octo", type: "Organization" },
          repository_selection: "selected",
          suspended_at: null,
          permissions: permissions(id),
        })),
      );
    if ((m = key.match(/^POST \/app\/installations\/(\d+)\/access_tokens$/))) {
      const inst = Number(m[1]);
      const asked = (c.body.permissions ?? {}) as Record<string, string>;
      if (asked.issues === "write" && permissions(inst).issues !== "write")
        return json({ message: "The permissions requested are not granted to this installation." }, 422);
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      tokens.set(token, inst);
      return json({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (key === "GET /installation/repositories")
      return json(
        tokens.get(String(c.query.get("_auth"))) === 2
          ? { total_count: 1, repositories: [repo(201, "octo/tool")] }
          : { total_count: 1, repositories: [repo(101, "acme/web")] },
      );
    if (key === "GET /repos/acme/web/issues") {
      const since = Date.parse(c.query.get("since") ?? "1970-01-01T00:00:00Z");
      return json(issues.filter((i) => Date.parse(i.updated_at) >= since).toReversed());
    }
    if (key === "POST /repos/acme/web/issues") {
      if (state.issuesPermission !== "write")
        return json({ message: "Resource not accessible by integration" }, 403);
      const i = addIssue(String(c.body.title), String(c.body.body), bot);
      return state.createThenFail ? json({ message: "Bad Gateway" }, 502) : json(i, 201);
    }
    return undefined;
  }

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== GH) throw new Error(`unexpected fetch in test: ${url}`);
    const auth = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^token /, "");
    const query = new URLSearchParams(url.searchParams);
    query.set("_auth", auth);
    const c: Call = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      query,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    calls.push(c);
    return route(c) ?? json({ message: "Not Found" }, 404);
  });
  const creates = () => calls.filter((c) => c.method === "POST" && c.path === "/repos/acme/web/issues");
  return { calls, issues, state, creates, addIssue };
}

let t: TestApp;
let db: Db;
let sql: pg.Pool;
let cookie: string;
let ws: WorkspaceList;
let gh: ReturnType<typeof fakeGithub>;
let home: Project;

const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, body?: unknown, headers = {}) =>
  t.app.inject({
    method,
    url,
    headers: { cookie, origin: t.config.publicOrigin, ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });

async function newProject(mode: "DEV" | "BUSINESS" = "DEV") {
  const slug = `p-${randomBytes(3).toString("hex")}`;
  const wsId = ws.items.find((w) => w.mode === mode)!.id;
  const res = await call("POST", `/v1/workspaces/${wsId}/projects`, { name: slug, slug });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Project>();
}

const bind = (p: Project, ...repoIds: string[]) =>
  db.insert(projectRepositories).values(repoIds.map((repositoryId) => ({ projectId: p.id, repositoryId })));

async function allowIssues(p: Project, allow = true) {
  const res = await call("PUT", "/v1/agents/AI_RESEARCHER/profile", {
    level: { kind: "PROJECT", projectId: p.id },
    settings: {
      engine: "MESSAGES_API",
      autonomy: "ACT_WITH_APPROVAL",
      tools: allow ? ["research.search", "research.run", "github.issues.create"] : ["research.search"],
      maxCostUsdPerTask: 2,
      maxTurns: 30,
      responseDetail: "STANDARD",
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

const evidence = (url: string, verified = true, quote = "Checkout failures doubled after the release.") => ({
  url,
  publisher: new URL(url).hostname,
  tier: "PRIMARY" as const,
  quote,
  verified,
  snapshotId: verified ? randomUUID() : null,
});
const claim = (id: number, over: Partial<Claim> = {}): Claim => ({
  id,
  text: `Claim ${id} is observed.`,
  basis: "OBSERVED",
  label: "PRIMARY",
  evidence: [evidence(`https://acme.dev/post/${id}`)],
  ...over,
});
const draft = (over: Partial<OpportunityDraft> = {}): OpportunityDraft => ({
  kind: "RISK",
  title: "Restore the payment provider timeout",
  problem: "Checkout fails more often since the timeout was lowered.",
  targetUsers: "Buyers paying with 3DS cards",
  impactEstimate: "fewer failed payments",
  confidence: "MEDIUM",
  claimIds: [0, 1],
  validationSteps: ["Compare failure rates before and after the release."],
  ...over,
});
const report = (
  opportunity: OpportunityDraft | null,
  claims: Claim[] = [claim(0), claim(1)],
): DeepDiveReport => ({
  summary: "Summary [0].",
  claims,
  contradictions: [],
  openQuestions: [],
  confidence: "MEDIUM",
  opportunity,
});

/** An opportunity of `p`, recorded as the deep-dive engine records it. */
async function seed(
  p: Project,
  opp: OpportunityDraft | null = draft(),
  claims?: Claim[],
  diveId = randomUUID(),
) {
  return db.transaction((tx) =>
    recordOpportunity(tx, { id: diveId, workspaceId: p.workspaceId, projectId: p.id }, report(opp, claims)),
  );
}
const seedId = async (...args: Parameters<typeof seed>) => (await seed(...args))!;

const preview = (id: string, repositoryId = "101") =>
  call("POST", `/v1/research/opportunities/${id}/issue-preview`, { repositoryId });
const approve = (id: string, p: Pick<IssuePreview, "repositoryId" | "actionHash">, key = randomUUID()) =>
  call(
    "POST",
    `/v1/research/opportunities/${id}/issue`,
    { repositoryId: p.repositoryId, actionHash: p.actionHash },
    { "idempotency-key": key },
  );
async function previewed(id: string) {
  const res = await preview(id);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<IssuePreview>();
}

beforeAll(async () => {
  t = await createTestApp();
  ({ db, pool: sql } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  ws = (await call("GET", "/v1/workspaces")).json();
  home = ws.items.find((w) => w.mode === "DEV")!.projects.find((p) => p.slug === "home")!;
  await bind(home, "101", "201");
  await allowIssues(home);
});
afterAll(async () => {
  await t?.app.close();
  await sql?.end();
});
beforeEach(() => {
  gh = fakeGithub(`${t.githubApp!.slug}[bot]`);
});
afterEach(() => vi.restoreAllMocks());

describe("recordOpportunity", () => {
  it("copies the claims it rests on, maps the agents and records one opportunity per dive", async () => {
    const p = await newProject();
    const dive = randomUUID();
    const id = await seedId(p, draft({ kind: "OPPORTUNITY", claimIds: [1, 1, 7] }), undefined, dive);
    expect(await seed(p, draft(), undefined, dive)).toBe(id); // the engine retrying its completion
    const o = (await call("GET", `/v1/research/opportunities/${id}`)).json<Opportunity>();
    expect(o).toMatchObject({
      projectId: p.id,
      deepDiveId: dive,
      kind: "OPPORTUNITY",
      status: "OPEN",
      issue: null,
      agents: ["AI_RESEARCHER", "PRODUCT"],
    });
    expect(o.evidence.map((c) => c.id)).toEqual([1]); // unknown claim ids are dropped
  });

  it("refuses a report without a draft, or a draft whose claims have no verified quote", async () => {
    const p = await newProject();
    expect(await seed(p, null)).toBeNull();
    const unverified = [
      claim(0, { label: "UNVERIFIED", evidence: [evidence("https://a.example/x", false)] }),
    ];
    expect(await seed(p, draft({ claimIds: [0] }), unverified)).toBeNull();
    expect(await seed(p, draft({ claimIds: [5] }))).toBeNull();
    const rows = await db
      .select()
      .from(researchOpportunities)
      .where(eq(researchOpportunities.projectId, p.id));
    expect(rows).toEqual([]);
  });

  it("agents follow the kind: DevOps for a risk, Developer for an optimisation", async () => {
    const p = await newProject();
    const risk = await seedId(p, draft({ kind: "RISK" }));
    const opt = await seedId(p, draft({ kind: "OPTIMIZE" }));
    const agents = async (id: string) =>
      (await call("GET", `/v1/research/opportunities/${id}`)).json<Opportunity>().agents;
    expect(await agents(risk)).toEqual(["AI_RESEARCHER", "DEVOPS"]);
    expect(await agents(opt)).toEqual(["AI_RESEARCHER", "DEVELOPER"]);
  });
});

describe("list", () => {
  it("ranks by confidence, then verified claims, then newest; filters by status; scoped to the project", async () => {
    const p = await newProject();
    const decoy = await newProject();
    const low = await seedId(p, draft({ confidence: "LOW" }));
    const medOne = await seedId(p, draft({ claimIds: [0] }));
    const medTwo = await seedId(p, draft({ claimIds: [0, 1] }));
    const medTwoNewer = await seedId(p, draft({ claimIds: [0, 1] }));
    const high = await seedId(p, draft({ confidence: "HIGH", claimIds: [0] }));
    const other = await seedId(decoy, draft({ confidence: "HIGH", title: "Decoy" }));
    const ids = async (q: string) =>
      (await call("GET", `/v1/research/opportunities?${q}`))
        .json<{ items: Opportunity[] }>()
        .items.map((o) => o.id);
    // low was created first and ranks last anyway; uuidv7 orders the two equal MEDIUM ones newest first.
    expect(await ids(`projectId=${p.id}`)).toEqual([high, medTwoNewer, medTwo, medOne, low]);
    expect(await ids(`projectId=${decoy.id}`)).toEqual([other]);
    expect(await ids("limit=50")).toEqual(expect.arrayContaining([high, other]));

    expect((await call("POST", `/v1/research/opportunities/${medOne}/dismiss`)).statusCode).toBe(200);
    expect(await ids(`projectId=${p.id}&status=OPEN`)).not.toContain(medOne);
    expect(await ids(`projectId=${p.id}&status=DISMISSED`)).toEqual([medOne]);
    const audits = await db.select().from(auditRecords).where(eq(auditRecords.resourceId, medOne));
    expect(audits.map((a) => a.action)).toEqual([
      "research_opportunity.record",
      "research_opportunity.dismiss",
    ]);
  });

  it("an unknown id or another owner's project is a 404", async () => {
    expect((await call("GET", `/v1/research/opportunities/${randomUUID()}`)).statusCode).toBe(404);
    expect((await call("GET", `/v1/research/opportunities?projectId=${randomUUID()}`)).statusCode).toBe(404);
  });
});

describe("issue preview", () => {
  it("is built by the server: problem, verified quotes with links, steps, AI footer and the hidden marker", async () => {
    const claims = [
      claim(0),
      claim(1, {
        label: "CORROBORATED",
        basis: "INFERRED",
        evidence: [
          evidence("https://news.example/a", true, "Two reports confirm the failures rose sharply."),
          evidence("https://unread.example/b", false, "This quote was not found on the page."),
        ],
      }),
      claim(2, { label: "UNVERIFIED", evidence: [evidence("https://rumour.example/c", false)] }),
    ];
    const id = await seedId(home, draft({ claimIds: [0, 1, 2] }), claims, randomUUID());
    const p = await previewed(id);
    expect(p).toMatchObject({
      opportunityId: id,
      repositoryId: "101",
      repositoryFullName: "acme/web",
      labels: [],
    });
    expect(p.title).toBe("Restore the payment provider timeout");
    expect(p.body).toContain("## Problem\n\nCheckout fails more often since the timeout was lowered.");
    expect(p.body).toContain("**Impact (est.):** fewer failed payments");
    expect(p.body).toContain("> — [acme.dev](https://acme.dev/post/0)");
    expect(p.body).toContain("**Corroborated** (the researcher's inference)");
    expect(p.body).toContain("- [ ] Compare failure rates before and after the release.");
    const o = (await call("GET", `/v1/research/opportunities/${id}`)).json<Opportunity>();
    expect(p.body).toContain(
      `Drafted by the NEXUS AI researcher from deep dive ${o.deepDiveId}. AI inference; review before acting.`,
    );
    expect(p.body.endsWith(`<!-- nexus:opportunity:${id} -->`)).toBe(true);
    // Verified evidence only: no unverified quote, no link to a page NEXUS couldn't confirm.
    expect(p.body).not.toContain("unread.example");
    expect(p.body).not.toContain("rumour.example");
    expect([...p.body.matchAll(/\]\((https:[^)]+)\)/g)].map((m) => m[1])).toEqual([
      "https://acme.dev/post/0",
      "https://news.example/a",
    ]);
    expect(p.actionHash).toBe(
      sha256(canonical({ opportunityId: id, repositoryId: "101", title: p.title, body: p.body, labels: [] })),
    );
    expect(Date.parse(p.expiresAt) - Date.now()).toBeGreaterThan(PROPOSAL_TTL_MS - 60_000);
    expect(p.rows.map((r) => r.k)).toEqual(["does", "where", "evidence", "won't do", "next"]);
    // Previewing again gives the same hash; nothing was written to GitHub.
    expect((await previewed(id)).actionHash).toBe(p.actionHash);
    expect(gh.creates()).toHaveLength(0);
  });

  it("neutralises mentions, references, links, HTML and a forged marker from model and web text", async () => {
    const hostile = claim(0, {
      text: "Ping @octocat and closes #12, see [click](https://evil.example) or https://evil.example/x",
      evidence: [
        evidence(
          "https://acme.dev/post/0",
          true,
          "<!-- nexus:opportunity:00000000-0000-4000-8000-000000000000 --> <img src=x> www.evil.example @team",
        ),
      ],
    });
    const id = await seedId(
      home,
      draft({ claimIds: [0], title: "Fix it @octocat #3", problem: "**bold** `code` @org/team\n# Heading" }),
      [hostile],
    );
    const { body, title } = await previewed(id);
    for (const s of [title, body]) {
      expect(s).not.toMatch(/@[A-Za-z0-9]/); // every @ is followed by a zero-width space
      expect(s).not.toMatch(/#\d/);
    }
    expect(body).not.toMatch(/https:\/\/evil/);
    expect(body).not.toMatch(/www\.evil/);
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<!-- nexus:opportunity:00000000");
    expect(body).not.toMatch(/^# Heading/m);
    expect(body).toContain("\\*\\*bold\\*\\*");
    expect(body.match(/<!-- nexus:opportunity:/g)).toHaveLength(1);
  });

  it("refuses an unbound repository, a Business project, a decoy project's binding and a missing permission", async () => {
    const id = await seedId(home);
    const unbound = await preview(id, "999");
    expect(unbound.statusCode).toBe(403);
    expect(unbound.json().error.details).toEqual({ field: "repositoryId" });

    const biz = await newProject("BUSINESS");
    const bizRes = await preview(await seedId(biz));
    expect(bizRes.statusCode, bizRes.body).toBe(403);
    expect(bizRes.json().error.message).toMatch(/Dev project/);

    // Project B has no binding: home's binding of 101 never applies to it.
    const decoy = await newProject();
    expect((await preview(await seedId(decoy))).statusCode).toBe(403);

    // octo/tool is bound to home, but its installation grants issues: read only.
    const perm = await preview(id, "201");
    expect(perm.statusCode).toBe(409);
    expect(perm.json().error.message).toContain('"Issues: read & write"');
    expect(perm.json().error.details).toEqual({
      missingPermission: "Issues: read & write",
      runbook: "docs/runbooks/github-setup.md",
    });
  });
});

describe("create the issue (R2)", () => {
  it("creates exactly the previewed issue; approving twice returns the same one", async () => {
    const id = await seedId(home);
    const p = await previewed(id);
    const res = await approve(id, p);
    expect(res.statusCode, res.body).toBe(200);
    const o = res.json<Opportunity>();
    expect(o.status).toBe("ISSUE_CREATED");
    expect(o.issue).toEqual({
      repositoryFullName: "acme/web",
      number: 1,
      url: "https://github.com/acme/web/issues/1",
    });
    expect(gh.creates()).toHaveLength(1);
    expect(gh.creates()[0]!.body).toEqual({ title: p.title, body: p.body });
    // The write token is scoped to the one repository with issues: write only.
    const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens") && "permissions" in c.body)!;
    expect(mint.body).toMatchObject({ repository_ids: [101], permissions: { issues: "write" } });

    const again = await approve(id, p);
    expect(again.statusCode).toBe(200);
    expect(again.json<Opportunity>().issue).toEqual(o.issue);
    expect(gh.creates()).toHaveLength(1);
    expect((await call("POST", `/v1/research/opportunities/${id}/dismiss`)).statusCode).toBe(409);

    const audits = await db.select().from(auditRecords).where(eq(auditRecords.resourceId, id));
    const created = audits.find((a) => a.action === "research_opportunity.issue_create")!;
    expect(created.metadata).toMatchObject({ issueNumber: 1, adopted: false, actionHash: p.actionHash });
    // Ids and outcome only: never the issue text.
    expect(JSON.stringify(audits.map((a) => a.metadata))).not.toContain("Checkout");
  });

  it("RES-G12: GitHub created it but the answer was lost → the retry adopts it, never a second issue", async () => {
    const id = await seedId(home);
    const p = await previewed(id);
    gh.state.createThenFail = true;
    const lost = await approve(id, p);
    expect(lost.statusCode).toBe(502);
    expect((await call("GET", `/v1/research/opportunities/${id}`)).json<Opportunity>()).toMatchObject({
      status: "OPEN",
      issue: null, // never from our own belief, only from GitHub's answer
    });
    const [claimRow] = await db
      .select()
      .from(opportunityIssueRequests)
      .where(eq(opportunityIssueRequests.opportunityId, id));
    expect(claimRow).toMatchObject({ status: "PENDING", attempts: 1, lockedUntil: null });
    // A human's issue quoting the marker is newer, but only the app's own issue is adopted.
    gh.addIssue("Copied", `<!-- nexus:opportunity:${id} -->`, "someone");

    gh.state.createThenFail = false;
    const retry = await approve(id, p);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json<Opportunity>().issue?.number).toBe(
      gh.issues.find((i) => i.user.type === "Bot")!.number,
    );
    expect(gh.creates()).toHaveLength(1);
    const audit = (await db.select().from(auditRecords).where(eq(auditRecords.resourceId, id))).filter(
      (a) => a.action === "research_opportunity.issue_create",
    );
    expect(audit.map((a) => [a.outcome, (a.metadata as { adopted?: boolean }).adopted])).toEqual([
      ["FAILED", undefined],
      ["SUCCEEDED", true],
    ]);
  });

  it("RES-G12: an attempt still holding its lease blocks a second one; a crashed one's lease lapses", async () => {
    const id = await seedId(home);
    const p = await previewed(id);
    // A crash right after GitHub created the issue: the claim is PENDING and still leased.
    await db.insert(opportunityIssueRequests).values({
      workspaceId: home.workspaceId,
      projectId: home.id,
      opportunityId: id,
      repositoryId: "101",
      repositoryFullName: "acme/web",
      title: p.title,
      body: p.body,
      labels: [],
      actionHash: p.actionHash,
      idempotencyKey: randomUUID(),
      status: "PENDING",
      attempts: 1,
      lockedUntil: new Date(Date.now() + 60_000),
      createdAt: new Date(Date.now() - 1000),
    });
    gh.addIssue(p.title, p.body, `${t.githubApp!.slug}[bot]`);
    const busy = await approve(id, p);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.message).toMatch(/creating this issue right now/);

    await db
      .update(opportunityIssueRequests)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(opportunityIssueRequests.opportunityId, id));
    const res = await approve(id, p);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Opportunity>().issue?.number).toBe(1);
    expect(gh.creates()).toHaveLength(0);
  });

  it("a stale, changed or expired hash is a 409 and nothing reaches GitHub", async () => {
    const id = await seedId(home);
    const p = await previewed(id);
    expect((await approve(id, { ...p, actionHash: "0".repeat(64) })).statusCode).toBe(409);
    // The hash of the 101 preview doesn't approve another repository.
    expect((await approve(id, { ...p, repositoryId: "201" })).statusCode).toBe(409);
    await sql.query(`update opportunity_issue_previews set expires_at = now() - interval '1 second'`);
    const expired = await approve(id, p);
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error.message).toMatch(/expired/);
    expect(gh.creates()).toHaveLength(0);
    expect(
      await db.select().from(opportunityIssueRequests).where(eq(opportunityIssueRequests.opportunityId, id)),
    ).toEqual([]);
  });

  it("needs the AI researcher's github.issues.create tool and no emergency stop", async () => {
    const p1 = await newProject();
    await bind(p1, "101");
    const id = await seedId(p1);
    const p = await previewed(id);
    await allowIssues(p1, false);
    const noTool = await approve(id, p);
    expect(noTool.statusCode).toBe(409);
    expect(noTool.json().error.details).toEqual({ setting: "tools", tool: "github.issues.create" });

    await allowIssues(p1);
    expect((await call("PUT", "/v1/system/emergency-stop", { engaged: true })).statusCode).toBe(200);
    try {
      const stopped = await approve(id, p);
      expect(stopped.statusCode).toBe(409);
      expect(stopped.json().error.code).toBe("EMERGENCY_STOP");
    } finally {
      await call("PUT", "/v1/system/emergency-stop", { engaged: false });
    }
    expect(gh.creates()).toHaveLength(0);
    expect((await approve(id, p)).statusCode).toBe(200);
  });

  it("a permission lost between preview and approve is a 409 naming it; the claim is released", async () => {
    const id = await seedId(home);
    const p = await previewed(id);
    // The cached installation list and token still say write; GitHub now refuses the create itself.
    gh.state.issuesPermission = "read";
    const res = await approve(id, p);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("Issues: read & write");
    expect(gh.issues).toEqual([]);
    expect(
      await db.select().from(opportunityIssueRequests).where(eq(opportunityIssueRequests.opportunityId, id)),
    ).toEqual([]);
  });

  it("a dismissed opportunity can't be previewed or approved; the Idempotency-Key is required", async () => {
    const id = await seedId(home);
    const p = await previewed(id);
    const noKey = await call("POST", `/v1/research/opportunities/${id}/issue`, {
      repositoryId: p.repositoryId,
      actionHash: p.actionHash,
    });
    expect(noKey.statusCode).toBe(400);
    expect((await call("POST", `/v1/research/opportunities/${id}/dismiss`)).statusCode).toBe(200);
    expect((await preview(id)).statusCode).toBe(409);
    expect((await approve(id, p)).statusCode).toBe(409);
  });
});
