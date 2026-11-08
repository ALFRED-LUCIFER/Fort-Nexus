import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_HANDOFF_TEXT_MAX,
  type CloudHandoff,
  type CloudHandoffPreview,
  type CloudHandoffState,
  type Project,
  type SetupStatus,
  type WorkspaceList,
} from "@nexus/contracts";
import { cloudHandoffPreviews, cloudHandoffs } from "../src/cloud-handoff/schema.ts";
import { createDb, type Db } from "../src/db/index.ts";
import { auditRecords, projectRepositories } from "../src/db/schema.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// docs/specs/cloud-handoff.md, API tests: the routine status, the server-built preview, the R2 approval that fires
// a Claude Code routine exactly once, how each answer of Anthropic maps, the PR GitHub shows, and that the routine
// token never leaves the fire call. GitHub and api.anthropic.com are fetch-level fakes; Octokit, the fire client,
// the database and the API are production code.

const GH = "https://api.github.com";
const TOKEN = `sk-ant-oat01-${randomBytes(24).toString("base64url")}`;
const ROUTINE = "trig_01Web";
const FIRE_URL = `https://api.anthropic.com/v1/claude_code/routines/${ROUTINE}/fire`;

type Fire = { url: string; headers: Headers; body: { text: string } };
type GhPull = {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged_at: string | null;
  draft: boolean;
  head: { ref: string };
  html_url: string;
  created_at: string;
};

// Issue numbers are unique for the whole file: handoffs stay in the database between tests.
let next = 100;

function fakes() {
  const issues = new Map<number, { title: string; body: string }>();
  const pulls: GhPull[] = [];
  const fires: Fire[] = [];
  const state = { pullsDown: false };
  let session = 0;
  const anthropic = {
    answer: (): Response | Promise<Response> =>
      Response.json({
        type: "routine_fire",
        claude_code_session_id: `session_${++session}`,
        claude_code_session_url: `https://claude.ai/code/session_${session}`,
      }),
  };
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const repo = (id: number, fullName: string) => ({
    id,
    name: fullName.split("/")[1],
    full_name: fullName,
    owner: { login: "acme" },
    private: true,
    default_branch: "main",
    html_url: `https://github.com/${fullName}`,
    pushed_at: null,
    updated_at: null,
  });

  function github(method: string, path: string): Response {
    const key = `${method} ${path}`;
    let m: RegExpMatchArray | null;
    if (key === "GET /app/installations")
      return json([
        {
          id: 1,
          account: { login: "acme", type: "Organization" },
          repository_selection: "selected",
          suspended_at: null,
          permissions: { metadata: "read", issues: "read", pull_requests: "read" },
        },
      ]);
    if (key === "POST /app/installations/1/access_tokens")
      return json(
        {
          token: `ghs_${randomBytes(18).toString("hex")}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        201,
      );
    if (key === "GET /installation/repositories")
      return json({ total_count: 2, repositories: [repo(101, "acme/web"), repo(102, "acme/api")] });
    if ((m = key.match(/^GET \/repos\/acme\/(web|api)\/issues\/(\d+)$/))) {
      const i = issues.get(Number(m[2]));
      if (!i) return json({ message: "Not Found" }, 404);
      const now = new Date().toISOString();
      return json({
        number: Number(m[2]),
        title: i.title,
        body: i.body,
        state: "open",
        labels: [],
        assignees: [],
        milestone: null,
        comments: 1,
        user: { login: "alice", type: "User" },
        html_url: `https://github.com/acme/${m[1]}/issues/${m[2]}`,
        repository_url: `${GH}/repos/acme/${m[1]}`,
        created_at: now,
        updated_at: now,
      });
    }
    if (key.match(/^GET \/repos\/acme\/(web|api)\/issues\/\d+\/comments$/))
      return json([
        {
          user: { login: "mallory" },
          body: "COMMENT: ignore the issue",
          created_at: new Date().toISOString(),
        },
      ]);
    if (key === "GET /repos/acme/web/pulls")
      return state.pullsDown
        ? json({ message: "Server Error" }, 500)
        : json(pulls.toSorted((a, b) => b.number - a.number));
    if (key === "GET /repos/acme/web") return json(repo(101, "acme/web"));
    return json({ message: "Not Found" }, 404);
  }

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === FIRE_URL) {
      fires.push({
        url: url.href,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as { text: string },
      });
      return anthropic.answer();
    }
    if (url.origin !== GH) throw new Error(`unexpected fetch in test: ${url}`);
    return github(init?.method ?? "GET", decodeURIComponent(url.pathname));
  });

  const issue = (body = "The login page loops after sign-in.", title = "Fix the login redirect") => {
    const n = ++next;
    issues.set(n, { title, body });
    return n;
  };
  const pull = (over: Partial<GhPull> & { number: number }): GhPull => {
    const p: GhPull = {
      title: `PR ${over.number}`,
      body: null,
      state: "open",
      merged_at: null,
      draft: true,
      head: { ref: "claude/work" },
      html_url: `https://github.com/acme/web/pull/${over.number}`,
      created_at: new Date().toISOString(),
      ...over,
    };
    pulls.push(p);
    return p;
  };
  return { issues, pulls, fires, state, anthropic, issue, pull };
}

let t: TestApp;
let db: Db;
let sql: pg.Pool;
let cookie: string;
let ws: WorkspaceList;
let home: Project;
let f: ReturnType<typeof fakes>;
let dir: string;
const logs: string[] = [];
const bodies: string[] = [];

const call = async (method: "GET" | "POST" | "PATCH" | "PUT", url: string, body?: unknown, headers = {}) => {
  const res = await t.app.inject({
    method,
    url,
    headers: { cookie, origin: t.config.publicOrigin, ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  bodies.push(res.body);
  return res;
};

const base = (n: number, repo = "101") => `/v1/repositories/${repo}/issues/${n}/cloud-handoff`;
const state = async (n: number, projectId = home.id, repo = "101") => {
  const res = await call("GET", `${base(n, repo)}?projectId=${projectId}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<CloudHandoffState>();
};
const preview = (n: number, projectId = home.id, repo = "101") =>
  call("POST", `${base(n, repo)}/preview`, { projectId });
async function previewed(n: number, projectId = home.id) {
  const res = await preview(n, projectId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<CloudHandoffPreview>();
}
const approve = (
  n: number,
  actionHash: string,
  {
    key = randomUUID(),
    confirmResend,
    projectId = home.id,
  }: { key?: string; confirmResend?: boolean; projectId?: string } = {},
) =>
  call(
    "POST",
    base(n),
    { projectId, actionHash, ...(confirmResend === undefined ? {} : { confirmResend }) },
    { "idempotency-key": key },
  );
async function started(n: number) {
  const res = await approve(n, (await previewed(n)).actionHash);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<CloudHandoff>();
}

async function newProject(mode: "DEV" | "BUSINESS" = "DEV") {
  const slug = `p-${randomBytes(3).toString("hex")}`;
  const wsId = ws.items.find((w) => w.mode === mode)!.id;
  const res = await call("POST", `/v1/workspaces/${wsId}/projects`, { name: slug, slug });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Project>();
}
const bind = (p: Project, ...repoIds: string[]) =>
  db.insert(projectRepositories).values(repoIds.map((repositoryId) => ({ projectId: p.id, repositoryId })));
const audits = (action: string, resourceId?: string) =>
  db
    .select()
    .from(auditRecords)
    .where(
      and(eq(auditRecords.action, action), resourceId ? eq(auditRecords.resourceId, resourceId) : undefined),
    );

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nexus-cloud-"));
  const file = join(dir, "claude-cloud.json");
  writeFileSync(
    file,
    JSON.stringify({ routines: [{ repository: "Acme/Web", fireUrl: FIRE_URL, token: TOKEN }] }),
    {
      mode: 0o600,
    },
  );
  t = await createTestApp(
    { NEXUS_CLAUDE_CLOUD_FILE: file, LOG_LEVEL: "debug" },
    { logStream: { write: (line) => void logs.push(line) } },
  );
  ({ db, pool: sql } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  ws = (await call("GET", "/v1/workspaces")).json();
  home = ws.items.find((w) => w.mode === "DEV")!.projects.find((p) => p.slug === "home")!;
  await bind(home, "101", "102");
});
afterAll(async () => {
  await t?.app.close();
  await sql?.end();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  f = fakes();
});
afterEach(() => vi.restoreAllMocks());

describe("status", () => {
  it("needs the owner session; mutations need a trusted Origin", async () => {
    const n = f.issue();
    const anon = await t.app.inject({ method: "GET", url: `${base(n)}?projectId=${home.id}` });
    expect(anon.statusCode).toBe(401);
    const noOrigin = await t.app.inject({
      method: "POST",
      url: `${base(n)}/preview`,
      headers: { cookie },
      payload: { projectId: home.id },
    });
    expect(noOrigin.statusCode).toBe(403);
    expect(f.fires).toHaveLength(0);
  });

  it("shows the routine (never the token) and no handoff yet; a repository without a routine says what to do", async () => {
    const n = f.issue();
    expect(await state(n)).toEqual({ routine: { configured: true, routineId: ROUTINE }, latest: null });
    const api = await state(n, home.id, "102");
    expect(api.routine).toMatchObject({ configured: false, reason: "NO_ROUTINE_FOR_REPO" });
    const res = await preview(n, home.id, "102");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({ reason: "NO_ROUTINE_FOR_REPO" });
  });
});

describe("preview", () => {
  it("returns the exact text and a stable hash, stored for PROPOSAL_TTL_MS and audited", async () => {
    const n = f.issue("Body with ``` a fence\n\n## Acceptance criteria\n- Lands on the dashboard\n- No loop");
    const a = await previewed(n);
    const b = await previewed(n);
    expect(b.actionHash).toBe(a.actionHash);
    expect(a).toMatchObject({
      projectId: home.id,
      repositoryId: "101",
      repositoryFullName: "acme/web",
      issueNumber: n,
      routineId: ROUTINE,
    });
    expect(a.text).toContain(`Issue: #${n}`);
    expect(a.text).toContain(`"Fixes #${n}"`);
    expect(a.text).toContain("````text\nBody with ``` a fence");
    expect(a.text).toContain("- Lands on the dashboard\n- No loop");
    expect(a.text).not.toContain("COMMENT");
    expect(a.rows.map((r) => r.k)).toEqual(["does", "where", "billing", "won't do", "next"]);
    expect(Date.parse(a.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    const rows = await db.select().from(cloudHandoffPreviews).where(eq(cloudHandoffPreviews.issueNumber, n));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe(a.text);
    const audit = await audits("cloud_handoff.preview", rows[0]!.id);
    expect(audit[0]!.metadata).toEqual({
      workspaceId: home.workspaceId,
      projectId: home.id,
      repositoryId: "101",
      issueNumber: n,
      routineId: ROUTINE,
      actionHash: a.actionHash,
    });
    expect(f.fires).toHaveLength(0);
  });

  it("cuts a long description to the limit and says so", async () => {
    const n = f.issue("y".repeat(CLOUD_HANDOFF_TEXT_MAX + 5000));
    const p = await previewed(n);
    expect(p.text.length).toBeLessThanOrEqual(CLOUD_HANDOFF_TEXT_MAX);
    expect(p.text).toMatch(/The description was cut to fit the 65,536-character limit/);
  });

  it("refuses an unbound repository, a Business project and an archived project", async () => {
    const n = f.issue();
    const unbound = await newProject();
    const res = await preview(n, unbound.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details).toEqual({ field: "repositoryId" });
    expect((await call("GET", `${base(n)}?projectId=${unbound.id}`)).statusCode).toBe(403);

    const business = await newProject("BUSINESS");
    await bind(business, "101");
    const biz = await preview(n, business.id);
    expect(biz.statusCode).toBe(403);
    expect(biz.json().error.details).toEqual({ field: "projectId" });

    const archived = await newProject();
    await bind(archived, "101");
    const p = await previewed(n, archived.id);
    expect((await call("PATCH", `/v1/projects/${archived.id}`, { archived: true })).statusCode).toBe(200);
    expect((await preview(n, archived.id)).statusCode).toBe(409);
    expect((await approve(n, p.actionHash, { projectId: archived.id })).statusCode).toBe(409);

    expect((await call("GET", `${base(n)}?projectId=${randomUUID()}`)).statusCode).toBe(404);
    expect(f.fires).toHaveLength(0);
  });
});

describe("approval", () => {
  it("fires exactly once with the token, headers and the approved text, and records the session", async () => {
    const n = f.issue();
    const p = await previewed(n);
    const key = randomUUID();
    const res = await approve(n, p.actionHash, { key });
    expect(res.statusCode, res.body).toBe(200);
    const h = res.json<CloudHandoff>();
    expect(h).toMatchObject({
      projectId: home.id,
      repositoryId: "101",
      repositoryFullName: "acme/web",
      issueNumber: n,
      routineId: ROUTINE,
      status: "STARTED",
      sessionUrl: "https://claude.ai/code/session_1",
      error: null,
      pullRequest: null,
      pullRequestCheck: "OK",
    });
    expect(f.fires).toHaveLength(1);
    const fire = f.fires[0]!;
    expect(fire.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(fire.headers.get("anthropic-version")).toBe("2026-10-21");
    expect(fire.headers.get("anthropic-beta")).toBe("experimental-cc-routine-2026-04-01");
    expect(fire.headers.get("content-type")).toBe("application/json");
    expect(fire.body).toEqual({ text: p.text });

    const [row] = await db.select().from(cloudHandoffs).where(eq(cloudHandoffs.id, h.id));
    expect(row).toMatchObject({
      status: "STARTED",
      sessionId: "session_1",
      lockedUntil: null,
      idempotencyKey: key,
    });
    const [approveAudit] = await audits("cloud_handoff.approve", h.id);
    expect(approveAudit!.metadata).toMatchObject({
      confirmResend: false,
      idempotencyKeyRowId: h.id,
      routineId: ROUTINE,
    });
    const [fireAudit] = await audits("cloud_handoff.fire", h.id);
    expect(fireAudit).toMatchObject({ outcome: "SUCCEEDED", resourceType: "cloud_handoff" });
    expect(fireAudit!.metadata).toMatchObject({
      statusClass: "2xx",
      httpStatus: 200,
      status: "STARTED",
      issueNumber: n,
    });
    expect((await state(n)).latest).toMatchObject({ id: h.id, status: "STARTED" });

    // The same key again: the same handoff, no second fire.
    const again = await approve(n, p.actionHash, { key });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<CloudHandoff>().id).toBe(h.id);
    expect(f.fires).toHaveLength(1);

    // Still the same handoff after the preview has expired: a late retry never reads as "expired".
    await db
      .update(cloudHandoffPreviews)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(cloudHandoffPreviews.actionHash, p.actionHash));
    const late = await approve(n, p.actionHash, { key });
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json<CloudHandoff>().id).toBe(h.id);
    expect(f.fires).toHaveLength(1);

    // The same key for another text is refused.
    f.issues.set(n, { title: "Fix the login redirect", body: "Changed." });
    const other = await previewed(n);
    const reused = await approve(n, other.actionHash, { key, confirmResend: true });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(f.fires).toHaveLength(1);
  });

  it("a changed issue, an unknown hash or an expired preview is a 409 and nothing fires", async () => {
    const n = f.issue();
    const p = await previewed(n);
    const unknown = await approve(n, "0".repeat(64));
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json().error.message).toBe("The issue changed since it was shown; preview it again.");

    f.issues.set(n, { title: "Fix the login redirect", body: "Someone edited the issue." });
    const changed = await approve(n, p.actionHash);
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.message).toBe("The issue changed since it was shown; preview it again.");

    const fresh = await previewed(n);
    await db
      .update(cloudHandoffPreviews)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(cloudHandoffPreviews.actionHash, fresh.actionHash));
    const expired = await approve(n, fresh.actionHash);
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error.message).toBe("This preview has expired; preview it again.");
    expect(f.fires).toHaveLength(0);
    expect(await db.select().from(cloudHandoffs).where(eq(cloudHandoffs.issueNumber, n))).toEqual([]);
  });

  it("Claude already on the issue needs confirmResend; with it a second session starts", async () => {
    const n = f.issue();
    const first = await started(n);
    const p = await previewed(n);
    const res = await approve(n, p.actionHash);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(
      "Claude is already on this issue; confirm to start another session.",
    );
    expect(res.json().error.details).toMatchObject({ needsConfirmResend: true, handoffId: first.id });
    expect(f.fires).toHaveLength(1);

    const second = await approve(n, p.actionHash, { confirmResend: true });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json<CloudHandoff>()).toMatchObject({
      status: "STARTED",
      sessionUrl: "https://claude.ai/code/session_2",
    });
    expect(f.fires).toHaveLength(2);
    const [audit] = await audits("cloud_handoff.approve", second.json<CloudHandoff>().id);
    expect(audit!.metadata).toMatchObject({ confirmResend: true });
    expect((await state(n)).latest?.id).toBe(second.json<CloudHandoff>().id);
  });

  it.each([
    [
      401,
      "The routine rejected NEXUS's token. Generate a new token for the routine on claude.ai/code/routines and update ~/.nexus/claude-cloud.json.",
    ],
    [404, "The routine doesn't exist. Check the fire URL in ~/.nexus/claude-cloud.json."],
    [400, "Anthropic refused the request: the routine may be paused."],
    [
      403,
      "This claude.ai account can't use routines. Check the plan and that Claude Code on the web is enabled.",
    ],
  ])(
    "HTTP %i: FAILED with a 409 explaining the fix; nothing blocks the next try",
    async (status, message) => {
      const n = f.issue();
      f.anthropic.answer = () =>
        Response.json({ error: { type: "x", message: `upstream says ${TOKEN}` } }, { status });
      const p = await previewed(n);
      const res = await approve(n, p.actionHash);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: "CONFLICT", message });
      expect(res.body).not.toContain("upstream says");
      const latest = (await state(n)).latest!;
      expect(latest).toMatchObject({
        status: "FAILED",
        error: message,
        sessionUrl: null,
        pullRequestCheck: "NOT_APPLICABLE",
      });
      const [audit] = await audits("cloud_handoff.fire", latest.id);
      expect(audit).toMatchObject({ outcome: "FAILED" });
      expect(audit!.metadata).toMatchObject({ statusClass: "4xx", httpStatus: status, status: "FAILED" });

      f.anthropic.answer = () =>
        Response.json({
          type: "routine_fire",
          claude_code_session_id: "s_ok",
          claude_code_session_url: "https://claude.ai/code/s_ok",
        });
      expect((await approve(n, p.actionHash)).statusCode).toBe(200); // FAILED needs no confirmation
      expect(f.fires).toHaveLength(2);
    },
  );

  it("HTTP 429: FAILED with retryAfterSeconds, answered as 429 RATE_LIMITED", async () => {
    const n = f.issue();
    f.anthropic.answer = () => new Response(null, { status: 429, headers: { "retry-after": "120" } });
    const res = await approve(n, (await previewed(n)).actionHash);
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSeconds: 120 } });
    expect((await state(n)).latest).toMatchObject({ status: "FAILED", retryAfterSeconds: 120 });
    expect(f.fires).toHaveLength(1);
  });

  it.each([
    ["HTTP 500", () => new Response("oops", { status: 500 }), "5xx", /Anthropic answered HTTP 500/],
    [
      "a timeout",
      () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
      "none",
      /didn't answer within 20 s/,
    ],
    ["an unusable 200", () => Response.json({ type: "routine_fire" }), "2xx", /answer couldn't be read/],
  ])(
    "%s: UNKNOWN, answered 502 UPSTREAM saying it may have started; never retried",
    async (_, answer, cls, message) => {
      const n = f.issue();
      f.anthropic.answer = answer;
      const p = await previewed(n);
      const res = await approve(n, p.actionHash);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("UPSTREAM");
      expect(res.json().error.message).toMatch(message);
      expect(res.json().error.message).toMatch(/may have started. Check the routine's runs on claude.ai/);
      expect(f.fires).toHaveLength(1);
      const latest = (await state(n)).latest!;
      expect(latest).toMatchObject({ status: "UNKNOWN", sessionUrl: null, pullRequestCheck: "OK" });
      const [audit] = await audits("cloud_handoff.fire", latest.id);
      expect(audit!.metadata).toMatchObject({ statusClass: cls, status: "UNKNOWN" });
      // UNKNOWN blocks a second session until the owner confirms it.
      const again = await approve(n, p.actionHash);
      expect(again.json().error.details).toMatchObject({ needsConfirmResend: true });
      expect(f.fires).toHaveLength(1);
    },
  );

  it("a live STARTING lease blocks; a lapsed one reads as UNKNOWN and needs confirmResend", async () => {
    const n = f.issue();
    const p = await previewed(n);
    const [row] = await db
      .insert(cloudHandoffs)
      .values({
        workspaceId: home.workspaceId,
        projectId: home.id,
        repositoryId: "101",
        repositoryFullName: "acme/web",
        issueNumber: n,
        routineId: ROUTINE,
        text: p.text,
        actionHash: p.actionHash,
        idempotencyKey: randomUUID(),
        status: "STARTING",
        lockedUntil: new Date(Date.now() + 60_000),
      })
      .returning();
    expect((await state(n)).latest).toMatchObject({ status: "STARTING", pullRequestCheck: "NOT_APPLICABLE" });
    const busy = await approve(n, p.actionHash, { confirmResend: true });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.message).toBe("NEXUS is starting this handoff right now.");

    await db
      .update(cloudHandoffs)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(cloudHandoffs.id, row!.id));
    const lapsed = (await state(n)).latest!;
    expect(lapsed).toMatchObject({ status: "UNKNOWN", pullRequestCheck: "OK" });
    expect(lapsed.error).toMatch(/may have started/);
    const confirm = await approve(n, p.actionHash);
    expect(confirm.json().error.details).toMatchObject({ needsConfirmResend: true, status: "UNKNOWN" });
    expect(f.fires).toHaveLength(0);
    expect((await approve(n, p.actionHash, { confirmResend: true })).statusCode).toBe(200);
    expect(f.fires).toHaveLength(1);
  });

  it("concurrent approvals of one issue fire once", async () => {
    const n = f.issue();
    const p = await previewed(n);
    const answers = await Promise.all([
      approve(n, p.actionHash),
      approve(n, p.actionHash),
      approve(n, p.actionHash),
    ]);
    expect(answers.map((a) => a.statusCode).toSorted()).toEqual([200, 409, 409]);
    expect(f.fires).toHaveLength(1);
  });

  it("the emergency stop refuses the approval with 409", async () => {
    const n = f.issue();
    const p = await previewed(n);
    expect((await call("PUT", "/v1/system/emergency-stop", { engaged: true })).statusCode).toBe(200);
    try {
      const stopped = await approve(n, p.actionHash);
      expect(stopped.statusCode).toBe(409);
      expect(stopped.json().error.code).toBe("EMERGENCY_STOP");
    } finally {
      await call("PUT", "/v1/system/emergency-stop", { engaged: false });
    }
    expect(f.fires).toHaveLength(0);
  });
});

describe("the PR GitHub shows", () => {
  it("is the newest claude/ PR opened in the window whose description closes the issue", async () => {
    const n = f.issue();
    const h = await started(n);
    const at = (minutes: number) => new Date(Date.parse(h.createdAt) + minutes * 60_000).toISOString();
    f.pull({ number: 1, body: `Fixes #${n}`, created_at: at(-11) }); // before the window
    f.pull({ number: 2, body: `Fixes #${n}`, head: { ref: "feature/x" }, created_at: at(1) });
    f.pull({ number: 3, body: `Fixes #${n}3`, created_at: at(2) }); // another issue
    f.pull({
      number: 4,
      title: "Fix login",
      body: `What changed.\n\ncloses #${n}`,
      created_at: at(3),
      head: { ref: "claude/fix-login" },
    });
    f.pull({ number: 5, body: "Refs nothing", created_at: at(4) });
    expect((await state(n)).latest).toMatchObject({
      pullRequestCheck: "OK",
      pullRequest: {
        number: 4,
        url: "https://github.com/acme/web/pull/4",
        title: "Fix login",
        branch: "claude/fix-login",
        state: "OPEN",
        draft: true,
      },
    });
  });

  it('a merged PR reads as MERGED; GitHub failing is UNAVAILABLE, never "no PR"', async () => {
    const n = f.issue();
    const h = await started(n);
    f.state.pullsDown = true;
    const down = (await state(n)).latest!;
    expect(down).toMatchObject({ status: "STARTED", pullRequest: null, pullRequestCheck: "UNAVAILABLE" });

    const m = f.issue();
    const h2 = await started(m);
    f.state.pullsDown = false;
    f.pull({
      number: 9,
      body: `Fixes #${m}`,
      state: "closed",
      merged_at: new Date().toISOString(),
      draft: false,
      created_at: h2.createdAt,
    });
    expect((await state(m)).latest?.pullRequest).toMatchObject({ number: 9, state: "MERGED" });
    expect(h.id).not.toBe(h2.id);
  });
});

describe("setup checklist", () => {
  it("shows the optional CLAUDE_CLOUD step as done once the file is usable", async () => {
    const res = await call("GET", "/v1/setup");
    const step = res.json<SetupStatus>().steps.find((s) => s.key === "CLAUDE_CLOUD");
    expect(step).toMatchObject({
      done: true,
      optional: true,
      detail: "Claude cloud handoff is set up for 1 repository.",
      runbook: "docs/runbooks/claude-cloud.md",
    });
  });
});

describe("the routine token", () => {
  // Runs last: every request of this file is in `bodies`, every log line in `logs`.
  it("never appears in a response, a log line, an audit record or the database", async () => {
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(bodies.join("\n")).not.toContain(TOKEN);
    const all = await sql.query(`select * from audit_records`);
    expect(JSON.stringify(all.rows)).not.toContain(TOKEN);
    for (const table of ["cloud_handoffs", "cloud_handoff_previews"])
      expect(JSON.stringify((await sql.query(`select * from ${table}`)).rows)).not.toContain(TOKEN);
  });
});
