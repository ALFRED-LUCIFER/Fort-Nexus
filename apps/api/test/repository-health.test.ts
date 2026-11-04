import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryDetails, RepositoryHealth, SetupStatus, WorkspaceList } from "@nexus/contracts";
import { createDb, type Db } from "../src/db/index.ts";
import { runners } from "../src/db/schema.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// FR-GH-05 repository health and details, and the setup checklist. GitHub is stubbed at fetch level, so Octokit,
// token handling and the catalog cache are production code.
const GH = "https://api.github.com";
const TOKEN = `ghs_${randomBytes(18).toString("hex")}`;
const SHA = "c".repeat(40);

let t: TestApp;
let db: Db;
let pool: { end: () => Promise<void> };
let cookie: string;
let ownerId: string;
let ws: WorkspaceList;
let dir: string;
// The health cache keeps 3 minutes: every test starts 5 minutes later.
let clock = Date.parse("2026-11-04T10:00:00Z");

type Route = (url: URL) => Response | undefined;
function stubGithub(over: Record<string, Route> = {}) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (url.origin !== GH) throw new Error(`unexpected fetch in test: ${url}`);
    calls.push(key);
    return (over[key] ?? ROUTES[key])?.(url) ?? Response.json({ message: "Not Found" }, { status: 404 });
  });
  return calls;
}

const ghRepo = (id: number, fullName: string, openIssues: number, over: Record<string, unknown> = {}) => ({
  id,
  name: fullName.split("/")[1],
  full_name: fullName,
  owner: { login: fullName.split("/")[0] },
  private: true,
  default_branch: "main",
  html_url: `https://github.com/${fullName}`,
  pushed_at: "2026-11-03T08:00:00Z",
  updated_at: "2026-11-03T09:00:00Z",
  archived: false,
  open_issues_count: openIssues,
  ...over,
});
const pull = (number: number, fullName: string, head: string, draft = false) => ({
  number,
  title: `PR ${number}`,
  draft,
  user: { login: "octo" },
  head: { ref: head },
  base: { ref: "main" },
  updated_at: "2026-11-03T10:00:00Z",
  html_url: `https://github.com/${fullName}/pull/${number}`,
});
const run = (name: string, status: string, conclusion: string | null, completedAt: string | null = null) => ({
  name,
  status,
  conclusion,
  head_sha: SHA,
  completed_at: completedAt,
  html_url: `https://github.com/acme/web/runs/${name}`,
});

// acme/web (101): 5 open (2 PRs) and failing CI. acme/api (102): passing CI, no PRs. acme/empty (103): empty repo.
// acme/gone (104): the app lost access (404 on its pulls). acme/old (105): archived.
const ROUTES: Record<string, Route> = {
  "GET /app/installations": () =>
    Response.json([
      {
        id: 1,
        account: { login: "acme", type: "Organization" },
        repository_selection: "selected",
        suspended_at: null,
        permissions: { metadata: "read", checks: "read", pull_requests: "write", contents: "write" },
      },
    ]),
  "POST /app/installations/1/access_tokens": () =>
    Response.json(
      { token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
      { status: 201 },
    ),
  "GET /installation/repositories": () =>
    Response.json({
      total_count: 5,
      repositories: [
        ghRepo(101, "acme/web", 5),
        ghRepo(102, "acme/api", 0),
        ghRepo(103, "acme/empty", 0),
        ghRepo(104, "acme/gone", 1),
        ghRepo(105, "acme/old", 0, { archived: true }),
      ],
    }),
  "GET /repos/acme/web/pulls": () =>
    Response.json([pull(7, "acme/web", "nexus/issue-3-abc", true), pull(6, "acme/web", "feature/x")]),
  "GET /repos/acme/api/pulls": () => Response.json([]),
  "GET /repos/acme/empty/pulls": () => Response.json([]),
  "GET /repos/acme/old/pulls": () => Response.json([]),
  "GET /repos/acme/web/commits/main/check-runs": () =>
    Response.json({
      total_count: 3,
      check_runs: [
        run("lint", "completed", "success", "2026-11-03T10:05:00Z"),
        run("test", "completed", "failure", "2026-11-03T10:09:00Z"),
        run("e2e", "in_progress", null),
      ],
    }),
  "GET /repos/acme/api/commits/main/check-runs": () =>
    Response.json({
      total_count: 1,
      check_runs: [run("ci", "completed", "success", "2026-11-03T09:00:00Z")],
    }),
  "GET /repos/acme/empty/commits/main/check-runs": () =>
    Response.json({ message: "Git Repository is empty." }, { status: 409 }),
  "GET /repos/acme/old/commits/main/check-runs": () => Response.json({ total_count: 0, check_runs: [] }),
  "GET /repos/acme/web/branches": () =>
    new Response(
      JSON.stringify([
        { name: "feature/x", protected: false, commit: { sha: "d".repeat(40) } },
        { name: "main", protected: true, commit: { sha: SHA } },
        { name: "nexus/issue-3-abc", protected: false, commit: { sha: "e".repeat(40) } },
      ]),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          link: `<${GH}/repositories/101/branches?per_page=100&page=2>; rel="next"`,
        },
      },
    ),
};

const call = (method: "GET" | "PUT" | "PATCH", url: string, c: string | null = cookie) =>
  t.app.inject({ method, url, headers: c ? { cookie: c, origin: t.config.publicOrigin } : {} });
const home = () => ws.items.find((w) => w.mode === "DEV")!.projects[0]!;
const byName = (items: RepositoryHealth[]) =>
  Object.fromEntries(items.map((i) => [i.repository.fullName, i]));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nexus-setup-"));
  t = await createTestApp({
    NEXUS_AI_FILE: join(dir, "ai.json"),
    NEXUS_SEARCH_FILE: join(dir, "search.json"),
  });
  ({ db, pool } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  ownerId = (await call("GET", "/v1/me")).json().id;
  ws = (await call("GET", "/v1/workspaces")).json();
});
afterAll(async () => {
  vi.useRealTimers();
  await t?.app.close();
  await pool?.end();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clock += 300_000;
  vi.setSystemTime(clock);
});
afterEach(() => vi.restoreAllMocks());

describe("repository health (FR-GH-05)", () => {
  it("needs the owner session", async () => {
    stubGithub();
    for (const url of ["/v1/repositories/health", "/v1/repositories/101/details", "/v1/setup"])
      expect((await call("GET", url, null)).statusCode).toBe(401);
  });

  it("shows PRs, issues without PRs and CI per repository; one refused repository doesn't hide the others", async () => {
    stubGithub();
    const res = await call("GET", "/v1/repositories/health");
    expect(res.statusCode).toBe(200);
    const items = byName(res.json().items);
    expect(Object.keys(items)).toEqual(["acme/api", "acme/empty", "acme/gone", "acme/old", "acme/web"]);
    expect(items["acme/web"]).toMatchObject({
      archived: false,
      openPullRequests: 2,
      draftPullRequests: 1,
      pullRequestsMore: false,
      openIssues: 3,
      ci: {
        state: "FAILING",
        sha: SHA,
        total: 3,
        failing: ["test"],
        completedAt: "2026-11-03T10:09:00.000Z",
      },
      error: null,
    });
    expect(items["acme/api"]!.ci).toMatchObject({ state: "PASSING", failing: [] });
    expect(items["acme/empty"]!.ci).toEqual({
      state: "NONE",
      sha: null,
      total: 0,
      failing: [],
      completedAt: null,
    });
    expect(items["acme/old"]).toMatchObject({ archived: true, ci: { state: "NONE" } });
    expect(items["acme/gone"]).toMatchObject({ openPullRequests: null, openIssues: null, ci: null });
    expect(items["acme/gone"]!.error).toMatch(/can't access acme\/gone/);
  });

  it("keeps health for 3 minutes per repository instead of asking GitHub again", async () => {
    // acme/gone answers this time: a lost repository drops the whole catalog cache, as every lost access does.
    const reachable = {
      "GET /repos/acme/gone/pulls": () => Response.json([]),
      "GET /repos/acme/gone/commits/main/check-runs": () => Response.json({ total_count: 0, check_runs: [] }),
    };
    const first = stubGithub(reachable);
    await call("GET", "/v1/repositories/health");
    expect(first.filter((c) => c.endsWith("/pulls"))).toHaveLength(5);
    vi.restoreAllMocks();
    vi.setSystemTime(clock + 120_000);
    const again = stubGithub(reachable);
    const res = await call("GET", "/v1/repositories/health");
    expect(res.json().items).toHaveLength(5);
    expect(again.filter((c) => c.startsWith("GET /repos/"))).toEqual([]);
  });

  it("in a project, only its bound repositories; none bound asks GitHub nothing; an unknown project is a 404", async () => {
    let calls = stubGithub();
    const empty = await call("GET", `/v1/repositories/health?projectId=${home().id}`);
    expect(empty.json()).toEqual({ items: [] });
    expect(calls).toEqual([]);

    expect((await call("PUT", `/v1/projects/${home().id}/repositories/101`)).statusCode).toBe(200);
    vi.restoreAllMocks();
    calls = stubGithub();
    const bound = await call("GET", `/v1/repositories/health?projectId=${home().id}`);
    expect(bound.json().items.map((i: RepositoryHealth) => i.repository.fullName)).toEqual(["acme/web"]);
    expect(calls.filter((c) => c.startsWith("GET /repos/") && !c.includes("acme/web"))).toEqual([]);

    expect((await call("GET", `/v1/repositories/health?projectId=${randomUUID()}`)).statusCode).toBe(404);
  });

  // The reset is a minute away, so the next test (5 minutes later) may call GitHub again.
  it("turns a GitHub rate limit into a per-repository error, not a failed page", async () => {
    stubGithub({
      "GET /repos/acme/api/pulls": () =>
        Response.json(
          { message: "API rate limit exceeded" },
          {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.floor(clock / 1000) + 60),
            },
          },
        ),
    });
    const res = await call("GET", "/v1/repositories/health");
    expect(res.statusCode).toBe(200);
    expect(byName(res.json().items)["acme/api"]!.error).toMatch(/rate limit/);
  });
});

describe("repository details (FR-GH-05)", () => {
  it("lists open PRs, branches (default and protected first) and checks (failing first)", async () => {
    stubGithub();
    const res = await call("GET", "/v1/repositories/101/details");
    expect(res.statusCode).toBe(200);
    const d = res.json() as RepositoryDetails;
    expect(d.repository.fullName).toBe("acme/web");
    expect(d.openIssues).toBe(3);
    expect(d.pullRequests).toEqual([
      {
        number: 7,
        title: "PR 7",
        draft: true,
        author: "octo",
        headBranch: "nexus/issue-3-abc",
        baseBranch: "main",
        nexus: true,
        updatedAt: "2026-11-03T10:00:00.000Z",
        htmlUrl: "https://github.com/acme/web/pull/7",
      },
      expect.objectContaining({ number: 6, nexus: false, draft: false }),
    ]);
    expect(d.branches.map((b) => [b.name, b.default, b.protected, b.nexus])).toEqual([
      ["main", true, true, false],
      ["feature/x", false, false, false],
      ["nexus/issue-3-abc", false, false, true],
    ]);
    expect(d.branchesMore).toBe(true);
    expect(d.ci).toMatchObject({ state: "FAILING", sha: SHA });
    expect(d.checks.map((c) => [c.name, c.status, c.conclusion])).toEqual([
      ["test", "completed", "failure"],
      ["e2e", "in_progress", null],
      ["lint", "completed", "success"],
    ]);
  });

  it("an empty repository has no checks; an uninstalled repository is a 404 without asking GitHub about it", async () => {
    const calls = stubGithub({ "GET /repos/acme/empty/branches": () => Response.json([]) });
    const empty = (await call("GET", "/v1/repositories/103/details")).json() as RepositoryDetails;
    expect(empty.ci).toEqual({ state: "NONE", sha: null, total: 0, failing: [], completedAt: null });
    expect(empty.branches).toEqual([]);
    expect((await call("GET", "/v1/repositories/999/details")).statusCode).toBe(404);
    expect(calls.some((c) => c.includes("/999"))).toBe(false);
  });
});

describe("setup checklist", () => {
  const steps = async (q = "") => {
    const res = await call("GET", `/v1/setup${q}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as SetupStatus;
    return { ready: body.ready, by: Object.fromEntries(body.steps.map((s) => [s.key, s])) };
  };

  it("says what is missing, without any file content, and the project's bindings", async () => {
    stubGithub();
    const { ready, by } = await steps();
    expect(ready).toBe(false);
    expect(by.GITHUB).toMatchObject({ done: true, optional: false });
    expect(by.GITHUB!.detail).toContain("acme");
    expect(by.AI_PROVIDER).toMatchObject({ done: false, runbook: "docs/runbooks/ai-provider.md" });
    expect(by.AI_PROVIDER!.detail).toContain(join(dir, "ai.json"));
    expect(by.RUNNER).toMatchObject({ done: false });
    expect(by.RUNNER!.detail).toMatch(/No runner is paired/);
    expect(by.WEB_SEARCH).toMatchObject({ done: false, optional: true });
    // An earlier test bound acme/web to Home.
    expect(by.REPOSITORIES).toMatchObject({ done: true });
    const scoped = await steps(`?projectId=${home().id}`);
    expect(scoped.by.REPOSITORIES!.detail).toBe("You work on 1 repository in Home.");
    expect((await call("GET", `/v1/setup?projectId=${randomUUID()}`)).statusCode).toBe(404);
  });

  it("is ready once ai.json is usable and a runner is online; web search stays optional", async () => {
    stubGithub();
    const key = `sk-ant-${randomBytes(24).toString("hex")}`;
    writeFileSync(
      join(dir, "ai.json"),
      JSON.stringify({ provider: "anthropic", apiKey: key, model: "m-1" }),
      {
        mode: 0o600,
      },
    );
    await db.insert(runners).values({
      ownerId,
      name: "home-mac",
      os: "darwin",
      version: "1.0.0",
      capacity: 1,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      lastHeartbeatAt: new Date(clock),
    });
    const res = await call("GET", "/v1/setup");
    expect(res.body).not.toContain(key);
    const { ready, by } = await steps();
    expect(by.AI_PROVIDER).toMatchObject({ done: true, detail: "An AI provider is set up (model m-1)." });
    expect(by.RUNNER).toMatchObject({ done: true, detail: "Runner home-mac is online." });
    expect(by.WEB_SEARCH!.done).toBe(false);
    expect(ready).toBe(true);
  });

  it("a paired runner that stopped sending heartbeats is not ready", async () => {
    stubGithub();
    vi.setSystemTime(clock + 10 * 60_000);
    const { ready, by } = await steps();
    expect(by.RUNNER).toMatchObject({ done: false });
    expect(by.RUNNER!.detail).toMatch(/home-mac is paired but not online/);
    expect(ready).toBe(false);
  });
});
