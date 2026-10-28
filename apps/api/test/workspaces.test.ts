import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type {
  Approval,
  IssueSnapshot,
  Job,
  Project,
  Repository,
  Verification,
  WorkspaceList,
} from "@nexus/contracts";
import { createDb, migrationsFolder, runMigrations, type Db } from "../src/db/index.ts";
import { approvals } from "../src/db/schema.ts";
import { buildAction } from "../src/issue-to-pr.ts";
import { createJob } from "../src/jobs.ts";
import { createTestApp, freshDatabaseUrl, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// NFR-CNV-05: every test runs against decoy data in a second project; nothing may cross the boundary.
const GH = "https://api.github.com";
const TOKEN = `ghs_${randomBytes(18).toString("hex")}`;
const ghRepo = (id: number, fullName: string) => ({
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
const SNAPSHOT: IssueSnapshot = {
  repositoryId: "101",
  fullName: "acme/web",
  issueNumber: 42,
  title: "Fix cart totals",
  body: "",
  acceptanceCriteria: [],
  htmlUrl: "https://github.com/acme/web/issues/42",
  issueUpdatedAt: "2026-10-27T10:00:00.000Z",
  baseBranch: "main",
  baseSha: "a".repeat(40),
};

const NOT_VERIFIED: Verification = {
  status: "not_configured",
  reason: null,
  source: null,
  install: null,
  test: null,
  exitCode: null,
  durationMs: 0,
  outputTail: "",
};

let t: TestApp;
let db: Db;
let sql: pg.Pool;
let cookie: string;
let ownerId: string;
let ws: WorkspaceList;
let fetches: string[];

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
const call = (method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({
    method,
    url,
    headers: { cookie, origin: t.config.publicOrigin, ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });
const devId = () => ws.items.find((w) => w.mode === "DEV")!.id;
const bizId = () => ws.items.find((w) => w.mode === "BUSINESS")!.id;
async function newProject(workspaceId: string, slug = `p-${randomBytes(3).toString("hex")}`) {
  const res = await call("POST", `/v1/workspaces/${workspaceId}/projects`, { name: `Project ${slug}`, slug });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Project;
}
const bind = (projectId: string, repoId: string) =>
  call("PUT", `/v1/projects/${projectId}/repositories/${repoId}`);
const diagnostic = (projectId: string) =>
  call(
    "POST",
    "/v1/jobs",
    { jobType: "RUNNER_DIAGNOSTIC", preset: "host-info", projectId },
    { "idempotency-key": randomUUID() },
  );
const issueViaApi = (projectId: string, repositoryId = "101") =>
  call(
    "POST",
    "/v1/jobs",
    { jobType: "DEV_ISSUE_TO_PR", repositoryId, issueNumber: 42, projectId },
    { "idempotency-key": randomUUID() },
  );
/** An issue job with the GitHub pinning stubbed (as the route does after pinning). */
const issueJob = (projectId: string) =>
  createJob(db, {
    ownerId,
    idempotencyKey: randomUUID(),
    body: {
      jobType: "DEV_ISSUE_TO_PR",
      repositoryId: "101",
      issueNumber: 42,
      projectId,
      budget: { maxWallClockMinutes: 45, maxTurns: 60, maxCostUsd: 1 },
    },
    correlationId: randomUUID(),
    timezone: t.config.ownerTimezone,
    pinIssue: async () => SNAPSHOT,
  });
async function pendingApproval(projectId: string) {
  const job = await issueJob(projectId);
  await sql.query(`update jobs set status = 'AWAITING_APPROVAL' where id = $1`, [job.id]);
  const [a] = await db
    .insert(approvals)
    .values({
      jobId: job.id,
      projectId: job.projectId,
      riskTier: "R2",
      status: "PENDING",
      action: buildAction(
        job.id,
        SNAPSHOT,
        [],
        { stats: { added: 0, removed: 0 }, agentSummary: "", verification: NOT_VERIFIED },
        "0".repeat(64),
      ),
      actionHash: "f".repeat(64),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  return a!;
}
const audits = async (action: string, resourceId: string) =>
  (
    await sql.query(`select * from audit_records where action = $1 and resource_id = $2`, [
      action,
      resourceId,
    ])
  ).rows;

beforeAll(async () => {
  t = await createTestApp();
  ({ db, pool: sql } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  ownerId = (await call("GET", "/v1/me")).json().id;
  ws = (await call("GET", "/v1/workspaces")).json();
  // One installation with acme/web (101) and acme/api (102); any repository call is recorded.
  fetches = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    fetches.push(key);
    if (url.origin !== GH) throw new Error(`unexpected fetch in test: ${url}`);
    if (key === "GET /app/installations")
      return Response.json([
        {
          id: 1,
          account: { login: "acme", type: "Organization" },
          repository_selection: "selected",
          suspended_at: null,
          permissions: { metadata: "read", issues: "read", contents: "write", pull_requests: "write" },
        },
      ]);
    if (key === "POST /app/installations/1/access_tokens")
      return Response.json(
        { token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 },
      );
    if (key === "GET /installation/repositories")
      return Response.json({
        total_count: 2,
        repositories: [ghRepo(101, "acme/web"), ghRepo(102, "acme/api")],
      });
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await t?.app.close();
  await sql?.end();
});

describe("workspaces", () => {
  it("gives the owner exactly one Dev (with project home) and one Business workspace", async () => {
    expect(ws.items.map((w) => [w.mode, w.name])).toEqual([
      ["DEV", "Dev"],
      ["BUSINESS", "Business"],
    ]);
    expect(ws.items[0]!.projects).toEqual([
      expect.objectContaining({
        slug: "home",
        name: "Home",
        mode: "DEV",
        archivedAt: null,
        repositoryIds: [],
      }),
    ]);
    expect(ws.items[1]!.projects).toEqual([]);
    const again = (await call("GET", "/v1/workspaces")).json() as WorkspaceList;
    expect(again.items.map((w) => w.id)).toEqual(ws.items.map((w) => w.id));
    const rows = await sql.query(`select count(*)::int as n from workspaces where owner_id = $1`, [ownerId]);
    expect(rows.rows[0].n).toBe(2);
  });

  it("needs the owner session, and a trusted Origin to change anything", async () => {
    expect((await t.app.inject({ method: "GET", url: "/v1/workspaces" })).statusCode).toBe(401);
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/workspaces/${devId()}/projects`,
      headers: { cookie, origin: "https://evil.example" },
      payload: { name: "X", slug: "x" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("projects", () => {
  it("creates a project (audited), rejects a duplicate slug, a bad slug and an unknown workspace", async () => {
    const p = await newProject(devId(), "shop");
    expect(p).toMatchObject({ workspaceId: devId(), mode: "DEV", slug: "shop", repositoryIds: [] });
    expect(await audits("project.create", p.id)).toEqual([
      expect.objectContaining({
        actor: `user:${ownerId}`,
        metadata: expect.objectContaining({ slug: "shop" }),
      }),
    ]);
    const dup = await call("POST", `/v1/workspaces/${devId()}/projects`, { name: "Again", slug: "shop" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatchObject({ code: "CONFLICT", details: { field: "slug" } });
    // The same slug in the other workspace is a different project.
    expect((await newProject(bizId(), "shop")).mode).toBe("BUSINESS");
    for (const body of [
      { name: "Bad", slug: "Bad Slug" },
      { name: " ", slug: "ok" },
      { name: "X", slug: "x", extra: 1 },
    ]) {
      const res = await call("POST", `/v1/workspaces/${devId()}/projects`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const unknown = await call("POST", `/v1/workspaces/${randomUUID()}/projects`, { name: "X", slug: "x" });
    expect(unknown.statusCode).toBe(404);
  });

  it("renames and archives (audited); an archived project blocks new jobs but keeps its history", async () => {
    const p = await newProject(devId());
    const job = (await diagnostic(p.id)).json().jobId as string;
    await call("POST", `/v1/jobs/${job}/cancel`);

    const renamed = await call("PATCH", `/v1/projects/${p.id}`, { name: "Renamed" });
    expect(renamed.json()).toMatchObject({ name: "Renamed", archivedAt: null });
    expect(await audits("project.rename", p.id)).toHaveLength(1);
    expect((await call("PATCH", `/v1/projects/${p.id}`, {})).statusCode).toBe(400);
    expect((await call("PATCH", `/v1/projects/${randomUUID()}`, { name: "X" })).statusCode).toBe(404);

    const archived = await call("PATCH", `/v1/projects/${p.id}`, { archived: true });
    expect(archived.json().archivedAt).not.toBeNull();
    expect(await audits("project.archive", p.id)).toHaveLength(1);
    const blocked = await diagnostic(p.id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("CONFLICT");
    expect((await call("GET", `/v1/jobs?projectId=${p.id}`)).json().items.map((j: Job) => j.id)).toEqual([
      job,
    ]);

    await call("PATCH", `/v1/projects/${p.id}`, { archived: false });
    expect((await diagnostic(p.id)).statusCode).toBe(202);
  });

  it("binds and unbinds installed repositories (audited); unbinding leaves existing jobs alone", async () => {
    const p = await newProject(devId());
    const bound = await bind(p.id, "101");
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json().repositoryIds).toEqual(["101"]);
    expect((await bind(p.id, "101")).json().repositoryIds).toEqual(["101"]); // idempotent
    expect(await audits("project.repository.bind", p.id)).toEqual([
      expect.objectContaining({ metadata: { repositoryId: "101", fullName: "acme/web" } }),
      expect.anything(),
    ]);
    expect((await bind(p.id, "999")).statusCode).toBe(404); // not in any installation
    expect((await bind(p.id, "abc")).statusCode).toBe(400);
    expect((await bind((await newProject(bizId())).id, "101")).statusCode).toBe(400); // Business: no repos

    const job = await issueJob(p.id);
    const unbound = await call("DELETE", `/v1/projects/${p.id}/repositories/101`);
    expect(unbound.json().repositoryIds).toEqual([]);
    expect(await audits("project.repository.unbind", p.id)).toHaveLength(1);
    expect((await call("GET", `/v1/jobs/${job.id}`)).json()).toMatchObject({
      projectId: p.id,
      status: "QUEUED",
    });
    expect((await issueViaApi(p.id)).statusCode).toBe(403);
    await call("POST", `/v1/jobs/${job.id}/cancel`);
  });
});

describe("cross-project isolation (decoy project B)", () => {
  let a: Project;
  let b: Project;
  beforeAll(async () => {
    a = await newProject(devId(), "alpha");
    b = await newProject(devId(), "bravo");
    expect((await bind(a.id, "101")).statusCode).toBe(200);
    expect((await bind(b.id, "102")).statusCode).toBe(200);
  });

  it("a repo bound only to A can't start a job from B, nor from a Business project; nothing reaches GitHub", async () => {
    fetches.length = 0;
    for (const res of [await issueViaApi(b.id), await issueViaApi((await newProject(bizId())).id)]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    }
    expect(fetches.filter((f) => f.includes("/repos/"))).toEqual([]);
    // No implicit fallback: an unknown project is a 404, never another project.
    expect((await diagnostic(randomUUID())).statusCode).toBe(404);
    expect((await issueViaApi(randomUUID())).statusCode).toBe(404);
    const missing = await call(
      "POST",
      "/v1/jobs",
      { jobType: "RUNNER_DIAGNOSTIC", preset: "host-info" },
      { "idempotency-key": randomUUID() },
    );
    expect(missing.statusCode).toBe(400);
  });

  it("B's lists never contain A's jobs or approvals; All aggregates both", async () => {
    const jobA = (await diagnostic(a.id)).json().jobId as string;
    const jobB = (await diagnostic(b.id)).json().jobId as string;
    const approvalA = await pendingApproval(a.id);

    const ids = async (url: string) => (await call("GET", url)).json().items.map((x: { id: string }) => x.id);
    const listedB = (await call("GET", `/v1/jobs?projectId=${b.id}&limit=100`)).json().items as Job[];
    expect(listedB.map((j) => j.id)).toEqual([jobB]);
    expect(listedB.every((j) => j.projectId === b.id)).toBe(true);
    expect(await ids(`/v1/jobs?projectId=${a.id}&limit=100`)).toEqual([approvalA.jobId, jobA]);
    expect(await ids("/v1/jobs?limit=100")).toEqual(expect.arrayContaining([jobA, jobB, approvalA.jobId]));

    expect(await ids(`/v1/approvals?projectId=${b.id}`)).toEqual([]);
    const resA = await call("GET", `/v1/approvals?projectId=${a.id}`);
    expect(resA.statusCode, resA.body).toBe(200);
    const listedA = resA.json().items as Approval[];
    expect(listedA).toEqual([expect.objectContaining({ id: approvalA.id, projectId: a.id })]);
    expect(await ids("/v1/approvals")).toContain(approvalA.id);
    // Single reads stay owner-scoped and carry the project so the UI can bind context.
    expect((await call("GET", `/v1/jobs/${jobA}`)).json().projectId).toBe(a.id);
    for (const id of [jobA, jobB, approvalA.jobId]) await call("POST", `/v1/jobs/${id}/cancel`);
  });

  it("repositories filter by project; an unknown project is a 404", async () => {
    const repos = async (q: string) =>
      ((await call("GET", `/v1/repositories${q}`)).json().items as Repository[]).map((r) => r.id);
    expect(await repos(`?projectId=${a.id}`)).toEqual(["101"]);
    expect(await repos(`?projectId=${b.id}`)).toEqual(["102"]);
    expect(await repos("")).toEqual(["102", "101"]); // sorted by full name
    expect((await call("GET", `/v1/repositories?projectId=${randomUUID()}`)).statusCode).toBe(404);
  });

  it("an approval of an archived project can't be decided", async () => {
    const p = await newProject(devId());
    await bind(p.id, "101");
    const approval = await pendingApproval(p.id);
    await call("PATCH", `/v1/projects/${p.id}`, { archived: true });
    const res = await call("POST", `/v1/approvals/${approval.id}/decision`, {
      decision: "deny",
      actionHash: approval.actionHash,
    });
    expect(res.statusCode).toBe(409);
    const [row] = (await sql.query(`select status from approvals where id = $1`, [approval.id])).rows;
    expect(row.status).toBe("PENDING");
  });

  it("an approval's project can't be changed at the database", async () => {
    const approval = await pendingApproval(a.id);
    await expect(
      sql.query(`update approvals set project_id = $2 where id = $1`, [approval.id, b.id]),
    ).rejects.toThrow(/immutable/);
    await sql.query(`update approvals set status = 'DENIED' where id = $1`, [approval.id]);
  });
});

describe("migration", () => {
  it("moves legacy jobs and approvals into the Dev project home, bound to the repos they used", async () => {
    // Apply everything up to the workspaces migration, write pre-wave-6 rows, then migrate the rest.
    const dir = mkdtempSync(join(tmpdir(), "nexus-migrations-"));
    const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    const before = journal.entries.slice(
      0,
      journal.entries.findIndex((e) => e.tag === "0004_workspaces"),
    );
    mkdirSync(join(dir, "meta"));
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: before }));
    for (const e of before) copyFileSync(join(migrationsFolder, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));

    const pool = new pg.Pool({ connectionString: await freshDatabaseUrl(), max: 2 });
    try {
      const legacy = drizzle(pool);
      await migrate(legacy, { migrationsFolder: dir });
      await pool.query(`insert into "user" (id, name, email) values ('u1', 'Owner', 'o@example.com')`);
      const job = (id: string, type: string, request: object) =>
        pool.query(
          `insert into jobs (id, initiator_id, job_type, status, risk_tier, request, request_hash, idempotency_key)
           values ($1, 'u1', $2, 'COMPLETED', 'R1', $3, 'h', $4)`,
          [id, type, JSON.stringify(request), id],
        );
      const [j1, j2, j3] = [randomUUID(), randomUUID(), randomUUID()];
      await job(j1, "DEV_ISSUE_TO_PR", { jobType: "DEV_ISSUE_TO_PR", repositoryId: "555", issueNumber: 1 });
      await job(j2, "DEV_ISSUE_TO_PR", { jobType: "DEV_ISSUE_TO_PR", repositoryId: "555", issueNumber: 2 });
      await job(j3, "RUNNER_DIAGNOSTIC", { jobType: "RUNNER_DIAGNOSTIC", preset: "host-info" });
      await pool.query(
        `insert into approvals (job_id, risk_tier, status, action, action_hash, expires_at)
         values ($1, 'R2', 'EXECUTED', '{}', 'x', now())`,
        [j1],
      );

      await runMigrations(legacy as unknown as Db);
      const { rows: home } = await pool.query(
        `select p.id from projects p join workspaces w on w.id = p.workspace_id
         where w.owner_id = 'u1' and w.mode = 'DEV' and p.slug = 'home'`,
      );
      expect(home).toHaveLength(1);
      const homeId = home[0].id as string;
      const { rows: jobs } = await pool.query(`select distinct project_id from jobs`);
      expect(jobs).toEqual([{ project_id: homeId }]);
      expect((await pool.query(`select project_id from approvals`)).rows).toEqual([{ project_id: homeId }]);
      expect((await pool.query(`select project_id, repository_id from project_repositories`)).rows).toEqual([
        { project_id: homeId, repository_id: "555" },
      ]);
      expect((await pool.query(`select mode from workspaces order by mode`)).rows).toEqual([
        { mode: "BUSINESS" },
        { mode: "DEV" },
      ]);
      await expect(pool.query(`update jobs set project_id = null where id = $1`, [j3])).rejects.toThrow(
        /not-null/,
      );
    } finally {
      await pool.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
