import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CHANGESET_MAX_BYTES,
  type Approval,
  type Job,
  type LeaseResponse,
  type PushDraftPrAction,
  type Verification,
} from "@nexus/contracts";
import { buildApp } from "../src/app.ts";
import { createDb, type Db } from "../src/db/index.ts";
import { buildAction, expireApprovals } from "../src/issue-to-pr.ts";
import { canonical, reapExpiredLeases, sha256 } from "../src/jobs.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// GitHub is a stateful fake at fetch level (refs, PRs, objects); Octokit and token minting are production code.
const GH = "https://api.github.com";
const BASE_SHA = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const b64 = (s: string) => Buffer.from(s).toString("base64");

type Call = {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string;
  body: Record<string, unknown>;
};

function fakeGithub() {
  const calls: Call[] = [];
  const mints: { installationId: number; body: Record<string, unknown>; token: string }[] = [];
  const tokenInstallation = new Map<string, number>();
  const refs = new Map<string, string>();
  const pulls: { number: number; html_url: string; head: { ref: string; sha: string }; base: string }[] = [];
  const state = { failRestrictedMint: false, hang: null as string | null, release: () => {} };

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const notFound = () => json({ message: "Not Found" }, 404);
  const issue = (number: number, over: Record<string, unknown> = {}) => ({
    number,
    title: `Fix cart totals ${number}`,
    state: "open",
    labels: [],
    assignees: [],
    milestone: null,
    user: { login: "reporter" },
    comments: 0,
    created_at: "2026-10-20T10:00:00Z",
    updated_at: "2026-10-27T10:00:00Z",
    html_url: `https://github.com/acme/web/issues/${number}`,
    repository_url: `${GH}/repos/acme/web`,
    body: "",
    ...over,
  });
  const issues: Record<number, unknown> = {
    42: issue(42, { body: "Totals are wrong.\n\n## Acceptance criteria\n- Rounds per currency" }),
    43: issue(43, { body: "Make it faster." }),
    2: issue(2, { pull_request: { url: `${GH}/repos/acme/web/pulls/2` } }),
  };
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

  function route(c: Call): Response | undefined {
    const key = `${c.method} ${c.path}`;
    let m: RegExpMatchArray | null;
    if (key === "GET /app/installations")
      return json([
        {
          id: 1,
          account: { login: "acme", type: "Organization" },
          repository_selection: "selected",
          suspended_at: null,
          permissions: { metadata: "read", issues: "read", contents: "write", pull_requests: "write" },
        },
        {
          id: 2,
          account: { login: "octo", type: "User" },
          repository_selection: "selected",
          suspended_at: null,
          permissions: { metadata: "read", contents: "read", pull_requests: "write" },
        },
      ]);
    if ((m = key.match(/^POST \/app\/installations\/(\d+)\/access_tokens$/))) {
      const restricted = "repository_ids" in c.body;
      if (restricted && state.failRestrictedMint) return json({ message: "Server Error" }, 500);
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      tokenInstallation.set(token, Number(m[1]));
      if (restricted) mints.push({ installationId: Number(m[1]), body: c.body, token });
      return json({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (key === "GET /installation/repositories") {
      const inst = tokenInstallation.get(c.auth.replace(/^token /, ""));
      return json(
        inst === 1
          ? { total_count: 1, repositories: [repo(101, "acme/web")] }
          : { total_count: 1, repositories: [repo(201, "octo/tool")] },
      );
    }
    if (key === "GET /repos/acme/web") return json(repo(101, "acme/web"));
    if ((m = key.match(/^GET \/repos\/acme\/web\/issues\/(\d+)$/))) {
      const found = issues[Number(m[1])];
      return found ? json(found) : notFound();
    }
    if (/^GET \/repos\/acme\/web\/issues\/\d+\/comments$/.test(key)) return json([]);
    if (key === "GET /repos/acme/web/branches/main") return json({ name: "main", commit: { sha: BASE_SHA } });
    if (key === `GET /repos/acme/web/git/commits/${BASE_SHA}`)
      return json({ sha: BASE_SHA, tree: { sha: BASE_TREE } });
    if (key === "POST /repos/acme/web/git/blobs") return json({ sha: sha1(String(c.body.content)) }, 201);
    if (key === "POST /repos/acme/web/git/trees" || key === "POST /repos/acme/web/git/commits")
      return json({ sha: sha1(JSON.stringify(c.body)) }, 201);
    if ((m = key.match(/^GET \/repos\/acme\/web\/git\/ref\/heads\/(.+)$/))) {
      const sha = refs.get(m[1]!);
      return sha ? json({ ref: `refs/heads/${m[1]}`, object: { sha } }) : notFound();
    }
    if (key === "POST /repos/acme/web/git/refs") {
      const branch = String(c.body.ref).replace(/^refs\/heads\//, "");
      if (refs.has(branch)) return json({ message: "Reference already exists" }, 422);
      refs.set(branch, String(c.body.sha));
      return json({ ref: c.body.ref, object: { sha: c.body.sha } }, 201);
    }
    if (key === "GET /repos/acme/web/pulls") {
      const head = c.query.get("head")!.replace(/^acme:/, "");
      return json(pulls.filter((p) => p.head.ref === head));
    }
    if (key === "POST /repos/acme/web/pulls") {
      const head = String(c.body.head);
      const pr = {
        number: pulls.length + 1,
        html_url: `https://github.com/acme/web/pull/${pulls.length + 1}`,
        head: { ref: head, sha: refs.get(head)! },
        base: String(c.body.base),
      };
      pulls.push(pr);
      return json(pr, 201);
    }
    return undefined;
  }

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== GH) throw new Error(`unexpected fetch in test: ${url}`);
    const c: Call = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      auth: String(new Headers(init?.headers).get("authorization") ?? ""),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    calls.push(c);
    if (state.hang === `${c.method} ${c.path}`)
      // A process that dies mid-call: this answer comes only when the test releases it.
      return new Promise<Response>((resolve) => {
        state.release = () => resolve(json({ message: "Bad Gateway" }, 502));
      });
    return route(c) ?? notFound();
  });
  const writes = () => calls.filter((c) => c.method !== "GET" && c.path.startsWith("/repos/"));
  return { calls, mints, refs, pulls, state, writes };
}

let t: TestApp;
let app: FastifyInstance;
let db: Db;
let sql: pg.Pool;
let cookie: string;
let gh: ReturnType<typeof fakeGithub>;
let runnerToken: string;

type Opts = { body?: unknown; origin?: string | null; headers?: Record<string, string> };
const owner = (method: "GET" | "POST", url: string, o: Opts = {}) =>
  app.inject({
    method,
    url,
    headers: {
      cookie,
      ...(o.origin === null ? {} : { origin: o.origin ?? t.config.publicOrigin }),
      ...o.headers,
    },
    ...(o.body === undefined ? {} : { payload: o.body as object }),
  });
const runner = (token: string, url: string, body?: unknown) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });
const createIssueJob = (body: Record<string, unknown> = {}, key = randomUUID()) =>
  owner("POST", "/v1/jobs", {
    headers: { "idempotency-key": key },
    body: { jobType: "DEV_ISSUE_TO_PR", repositoryId: "101", issueNumber: 42, ...body },
  });

async function pairRunner() {
  if (runnerToken) return runnerToken; // registration is rate limited: one runner for the whole file
  const pair = await owner("POST", "/v1/runners/pair");
  const reg = await app.inject({
    method: "POST",
    url: "/v1/runner/register",
    payload: { code: pair.json().code, name: "home", os: "darwin", version: "0.0.0" },
  });
  runnerToken = reg.json().token as string;
  return runnerToken;
}

const FILES = [
  { change: "modified", path: "src/cart.ts", mode: "100644", contentBase64: b64("export const x = 1;\n") },
  { change: "added", path: "bin/run", mode: "100755", contentBase64: b64("#!/bin/sh\n") },
  { change: "added", path: "link", mode: "120000", contentBase64: b64("src/cart.ts") },
  { change: "deleted", path: "old.txt" },
];
// Test output is repo-controlled: it carries @mentions, closing keywords and backtick runs like agent text does.
const FAILED: Verification = {
  status: "failed",
  source: "package.json",
  install: ["npm", "ci"],
  test: ["npm", "test"],
  exitCode: 1,
  durationMs: 65_400,
  outputTail: "FAIL src/cart.test.ts\n  ✕ rounds totals @octo closes #9 ````\n1 failed",
};
const changeset = (l: LeaseResponse, over: Record<string, unknown> = {}) => ({
  fencingToken: l.fencingToken,
  baseSha: BASE_SHA,
  files: FILES,
  stats: { added: 3, removed: 1 },
  agentSummary: "Rounded totals. @octo fixes #9 ```",
  verification: FAILED,
  ...over,
});

/** Issue job → leased → RUNNING; returns the runner token and the lease. */
async function runningJob(issueNumber = 42) {
  const token = await pairRunner();
  const created = await createIssueJob({ issueNumber });
  expect(created.statusCode, created.body).toBe(202);
  const res = await runner(token, "/v1/runner/lease");
  expect(res.statusCode, res.body).toBe(200);
  const l = res.json() as LeaseResponse;
  expect(l.jobId).toBe(created.json().jobId);
  const run = await runner(token, `/v1/runner/jobs/${l.jobId}/events`, {
    batchId: randomUUID(),
    fencingToken: l.fencingToken,
    events: [],
    transition: { to: "RUNNING" },
  });
  expect(run.statusCode).toBe(200);
  return { token, l };
}

async function pendingApproval() {
  const { token, l } = await runningJob();
  const up = await runner(token, `/v1/runner/jobs/${l.jobId}/changeset`, changeset(l));
  expect(up.statusCode, up.body).toBe(200);
  return { token, l, ...(up.json() as { approvalId: string; actionHash: string }) };
}

const decide = (id: string, decision: "approve" | "deny", actionHash: string, origin?: string | null) =>
  owner("POST", `/v1/approvals/${id}/decision`, { body: { decision, actionHash }, origin });
const job = async (id: string) => (await owner("GET", `/v1/jobs/${id}`)).json() as Job;
const eventTypes = async (jobId: string) =>
  (await sql.query(`select type from run_events where job_id = $1 order by sequence`, [jobId])).rows.map(
    (r: { type: string }) => r.type,
  );

beforeAll(async () => {
  t = await createTestApp({ RUNNER_LEASE_POLL_MS: "200" });
  app = t.app;
  ({ db, pool: sql } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
});
afterAll(async () => {
  await app?.close();
  await sql?.end();
});
beforeEach(async () => {
  gh = fakeGithub();
  // Leases take the oldest eligible job, so leftovers from earlier tests are cancelled first.
  const queued = (await owner("GET", "/v1/jobs?status=QUEUED&limit=100")).json().items as Job[];
  for (const j of queued) await owner("POST", `/v1/jobs/${j.id}/cancel`);
  // Free the runner's single slot from jobs a test left running.
  await sql.query(
    `update jobs set status = 'FAILED', lease_expires_at = null where status in ('PREPARING', 'RUNNING', 'VERIFYING')`,
  );
});
afterEach(() => vi.restoreAllMocks());

describe("create DEV_ISSUE_TO_PR", () => {
  it("rejects an unknown repo, a missing write permission, a PR number, a missing issue and bad base branches", async () => {
    const cases: [Record<string, unknown>, number, string, unknown][] = [
      [{ repositoryId: "999" }, 400, "VALIDATION_FAILED", { field: "repositoryId" }],
      [
        { repositoryId: "201" },
        403,
        "FORBIDDEN",
        expect.objectContaining({ missingPermissions: ["contents"] }),
      ],
      [{ issueNumber: 2 }, 400, "VALIDATION_FAILED", { field: "issueNumber" }],
      [{ issueNumber: 77 }, 400, "VALIDATION_FAILED", { field: "issueNumber" }],
      [{ baseBranch: "nope" }, 400, "VALIDATION_FAILED", { field: "baseBranch" }],
      [{ baseBranch: "nexus/issue-1-abc" }, 400, "VALIDATION_FAILED", { field: "baseBranch" }],
    ];
    for (const [body, status, code, details] of cases) {
      const res = await createIssueJob(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(status);
      expect(res.json().error).toMatchObject({ code, details });
    }
    expect((await owner("GET", "/v1/jobs?limit=100")).json().items).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ jobType: "DEV_ISSUE_TO_PR", status: "QUEUED" })]),
    );
    expect(gh.writes()).toEqual([]);
  });

  it("pins the issue and base commit, records missing acceptance criteria, risk R1, idempotent", async () => {
    const key = randomUUID();
    const res = await createIssueJob({ issueNumber: 43 }, key);
    expect(res.statusCode, res.body).toBe(202);
    const jobId = res.json().jobId as string;
    expect(await job(jobId)).toMatchObject({
      jobType: "DEV_ISSUE_TO_PR",
      status: "QUEUED",
      riskTier: "R1",
      issue: {
        fullName: "acme/web",
        issueNumber: 43,
        title: "Fix cart totals 43",
        workBranch: `nexus/issue-43-${jobId.replaceAll("-", "").slice(-8)}`,
      },
    });
    const diag = await owner("POST", "/v1/jobs", {
      headers: { "idempotency-key": randomUUID() },
      body: { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version" },
    });
    expect((await job(diag.json().jobId)).issue).toBeNull();
    await owner("POST", `/v1/jobs/${diag.json().jobId}/cancel`);

    const snapshot = {
      repositoryId: "101",
      fullName: "acme/web",
      issueNumber: 43,
      title: "Fix cart totals 43",
      body: "Make it faster.",
      acceptanceCriteria: [],
      htmlUrl: "https://github.com/acme/web/issues/43",
      issueUpdatedAt: "2026-10-27T10:00:00.000Z",
      baseBranch: "main",
      baseSha: BASE_SHA,
    };
    const row = await sql.query(`select issue_snapshot from jobs where id = $1`, [jobId]);
    expect(row.rows[0].issue_snapshot).toEqual(snapshot);
    const created = await sql.query(
      `select payload from run_events where job_id = $1 and type = 'job.created'`,
      [jobId],
    );
    expect(created.rows[0].payload).toMatchObject({ missingAcceptanceCriteria: true, issue: snapshot });

    const before = gh.calls.length;
    const again = await createIssueJob({ issueNumber: 43 }, key);
    expect(again.json().jobId).toBe(jobId);
    expect(gh.calls.length).toBe(before); // a replay never asks GitHub again
  });
});

describe("lease", () => {
  it("hands the runner a fresh token for exactly this repository with contents:read", async () => {
    const { l } = await runningJob();
    expect(gh.mints).toHaveLength(1);
    expect(gh.mints[0]).toMatchObject({
      installationId: 1,
      body: { repository_ids: [101], permissions: { contents: "read" } },
    });
    expect(l.task).toEqual({
      kind: "issue_to_pr",
      snapshot: expect.objectContaining({ repositoryId: "101", issueNumber: 42, baseSha: BASE_SHA }),
      workBranch: `nexus/issue-42-${l.jobId.replaceAll("-", "").slice(-8)}`,
      git: {
        cloneUrl: "https://github.com/acme/web.git",
        token: gh.mints[0]!.token,
        expiresAt: expect.any(String),
      },
    });
    // The token is for the runner only: never in events or audit.
    const leaked = await sql.query(
      `select 1 from run_events where payload::text like $1 union all select 1 from audit_records where metadata::text like $1`,
      [`%${gh.mints[0]!.token}%`],
    );
    expect(leaked.rowCount).toBe(0);
  });

  it("fails the job instead of handing out a lease without a token", async () => {
    gh.state.failRestrictedMint = true;
    const token = await pairRunner();
    const jobId = (await createIssueJob()).json().jobId as string;
    expect((await runner(token, "/v1/runner/lease")).statusCode).toBe(204);
    expect(await job(jobId)).toMatchObject({ status: "FAILED" });
    expect(await eventTypes(jobId)).toContain("job.failed");
  });
});

describe("changeset upload", () => {
  it("stores it, requests approval of the exact action and releases the lease", async () => {
    const { token, l, approvalId, actionHash } = await pendingApproval();
    expect(await job(l.jobId)).toMatchObject({ status: "AWAITING_APPROVAL" });
    const lease = await sql.query(`select lease_expires_at from jobs where id = $1`, [l.jobId]);
    expect(lease.rows[0].lease_expires_at).toBeNull();
    expect((await eventTypes(l.jobId)).slice(-3)).toEqual([
      "artifact.created",
      "approval.requested",
      "job.state.changed",
    ]);

    // The reaper leaves it alone, and a retried upload gets the same answer.
    await reapExpiredLeases(db);
    expect((await job(l.jobId)).status).toBe("AWAITING_APPROVAL");
    // A retried upload (lost response) gets the same answer; a different changeset for that lease is a 409.
    const retry = await runner(token, `/v1/runner/jobs/${l.jobId}/changeset`, changeset(l));
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ approvalId, actionHash });
    const other = await runner(
      token,
      `/v1/runner/jobs/${l.jobId}/changeset`,
      changeset(l, { files: [FILES[0]] }),
    );
    expect(other.statusCode).toBe(409);
    expect((await sql.query(`select 1 from approvals where job_id = $1`, [l.jobId])).rowCount).toBe(1);

    const list = (await owner("GET", `/v1/approvals?status=PENDING&jobId=${l.jobId}`)).json();
    expect(list.items).toHaveLength(1);
    const a = list.items[0] as Approval;
    expect(a).toMatchObject({ id: approvalId, riskTier: "R2", status: "PENDING", actionHash, result: null });
    expect(sha256(canonical(a.action))).toBe(actionHash);
    expect(a.action).toMatchObject<Partial<PushDraftPrAction>>({
      type: "github.push_draft_pr",
      repositoryId: "101",
      repositoryFullName: "acme/web",
      issueNumber: 42,
      baseBranch: "main",
      baseSha: BASE_SHA,
      headBranch: l.task!.workBranch,
      title: "#42: Fix cart totals 42",
      files: [
        { path: "bin/run", change: "added" },
        { path: "link", change: "added" },
        { path: "old.txt", change: "deleted" },
        { path: "src/cart.ts", change: "modified" },
      ],
      stats: { added: 3, removed: 1 },
    });
    // Agent text is fenced so its @mentions and closing keywords stay inert; the issue is referenced, not closed.
    expect(a.action.body).toMatch(/^Refs #42\n/);
    expect(a.action.body).toContain(
      "### Agent report (unverified)\n````text\nRounded totals. @octo fixes #9 ```\n````",
    );
    // FR-DEV-05: NEXUS's own result replaces "not verified", is part of the approved hash, and is fenced.
    expect(a.action.verification).toEqual(FAILED);
    expect(a.action.body).toContain(
      [
        "### Tests: FAILED with exit code 1 (run by NEXUS in the sandbox)",
        "Exit code 1 · 1 min 5 s · from package.json (auto-detected)",
        "`````text",
        "$ npm ci",
        "$ npm test",
        "",
        "FAIL src/cart.test.ts",
        "  ✕ rounds totals @octo closes #9 ````",
        "1 failed",
        "`````",
      ].join("\n"),
    );
    expect(a.action.body).not.toContain("not independently verified");
    expect(a.action.body).toContain("Opened by NEXUS — human review required, never auto-merged.");
    expect(Date.parse(a.expiresAt) - Date.parse(a.createdAt)).toBe(24 * 60 * 60 * 1000);
  });

  it("rejects stale leases, wrong states, other bases, unsafe paths and oversize content", async () => {
    const { token, l } = await runningJob();
    const up = (body: unknown) => runner(token, `/v1/runner/jobs/${l.jobId}/changeset`, body);

    const stale = await up(changeset(l, { fencingToken: l.fencingToken + 1 }));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("STALE_LEASE");
    expect((await up(changeset(l, { baseSha: "c".repeat(40) }))).json().error.code).toBe("CONFLICT");
    for (const path of ["../x", ".git/config", "/etc/passwd"])
      expect((await up(changeset(l, { files: [{ ...FILES[0], path }] }))).statusCode, path).toBe(400);
    const dup = await up(changeset(l, { files: [FILES[0], FILES[0]] }));
    expect(dup.statusCode).toBe(400);
    const big = await up(
      changeset(l, {
        files: [
          { ...FILES[0], contentBase64: Buffer.alloc(CHANGESET_MAX_BYTES / 2).toString("base64") },
          { ...FILES[1], contentBase64: Buffer.alloc(CHANGESET_MAX_BYTES / 2 + 1).toString("base64") },
        ],
      }),
    );
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("VALIDATION_FAILED");
    expect((await job(l.jobId)).status).toBe("RUNNING");
    expect((await sql.query(`select 1 from changesets where job_id = $1`, [l.jobId])).rowCount).toBe(0);
  });
});

describe("buildAction verification", () => {
  const snapshot = {
    repositoryId: "101",
    fullName: "acme/web",
    issueNumber: 42,
    title: "Fix",
    body: "",
    acceptanceCriteria: [],
    htmlUrl: "https://github.com/acme/web/issues/42",
    issueUpdatedAt: "2026-10-27T10:00:00.000Z",
    baseBranch: "main",
    baseSha: BASE_SHA,
  };
  const action = (verification: Verification) =>
    buildAction(
      randomUUID(),
      snapshot,
      [],
      { stats: { added: 0, removed: 0 }, agentSummary: "", verification },
      "c".repeat(64),
    );
  const notConfigured: Verification = {
    status: "not_configured",
    source: null,
    install: null,
    test: null,
    exitCode: null,
    durationMs: 3,
    outputTail: "",
  };

  it("a different verification result is a different action hash (the owner approves code AND result)", () => {
    const jobId = randomUUID();
    const hash = (v: Verification) =>
      sha256(
        canonical(
          buildAction(
            jobId,
            snapshot,
            [],
            { stats: { added: 0, removed: 0 }, agentSummary: "", verification: v },
            "c".repeat(64),
          ),
        ),
      );
    expect(hash(FAILED)).not.toBe(hash({ ...FAILED, status: "passed", exitCode: 0 }));
    expect(hash(FAILED)).not.toBe(hash({ ...FAILED, outputTail: "edited" }));
    expect(hash(FAILED)).toBe(hash({ ...FAILED }));
  });

  it.each([
    [
      "passed",
      {
        ...FAILED,
        status: "passed",
        exitCode: 0,
        install: null,
        source: "nexus.json",
        durationMs: 2_000,
        outputTail: "ok",
      },
      "### Tests: passed (run by NEXUS in the sandbox)\nExit code 0 · 2.0 s · from .nexus.json at the base commit\n```text\n$ npm test\n\nok\n```",
    ],
    [
      "error",
      {
        ...FAILED,
        status: "error",
        exitCode: null,
        outputTail: "[nexus] timed out after 15 min during test",
      },
      "### Tests: could not run (NEXUS tried in the sandbox)\nExit code none · 1 min 5 s · from package.json (auto-detected)",
    ],
    ["not_configured", notConfigured, "### Tests: not verified by NEXUS\nNo test setup at the base commit"],
  ] as [string, Verification, string][])("PR body says %s plainly", (_, v, text) => {
    const { body } = action(v);
    expect(body).toContain(text);
    expect(body).toMatch(/\n\nOpened by NEXUS — human review required, never auto-merged\.$/);
  });
});

describe("approval decisions", () => {
  it("needs a trusted Origin and the current hash", async () => {
    const { approvalId, actionHash } = await pendingApproval();
    expect((await decide(approvalId, "approve", actionHash, null)).statusCode).toBe(403);
    const wrong = await decide(approvalId, "approve", "0".repeat(64));
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe("CONFLICT");
    const [a] = (await owner("GET", `/v1/approvals?jobId=${await approvalJob(approvalId)}`)).json().items;
    expect(a.status).toBe("PENDING");
    expect(gh.writes()).toEqual([]);
    await expect(
      sql.query(`update approvals set action_hash = 'x' where id = $1`, [approvalId]),
    ).rejects.toThrow(/immutable/);
  });

  it("deny completes the job with APPROVAL_DENIED and touches nothing on GitHub", async () => {
    const { l, approvalId, actionHash } = await pendingApproval();
    const res = await decide(approvalId, "deny", actionHash);
    expect(res.json()).toMatchObject({ status: "DENIED", decidedAt: expect.any(String) });
    expect(await job(l.jobId)).toMatchObject({ status: "COMPLETED", outcome: "APPROVAL_DENIED" });
    expect((await decide(approvalId, "approve", actionHash)).statusCode).toBe(409);
    expect(gh.writes()).toEqual([]);
    const audit = await sql.query(
      `select actor, metadata from audit_records where action = 'approval.deny' and resource_id = $1`,
      [approvalId],
    );
    expect(audit.rows[0]).toMatchObject({ metadata: { actionHash, decision: "deny" } });
  });

  it("expires: a late decision gets 409 and the job EXPIRED; the reaper expires the rest", async () => {
    const first = await pendingApproval();
    await sql.query(`update approvals set expires_at = now() - interval '1 second' where id = $1`, [
      first.approvalId,
    ]);
    const late = await decide(first.approvalId, "approve", first.actionHash);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toMatch(/expired/);
    expect(await job(first.l.jobId)).toMatchObject({ status: "EXPIRED" });

    const second = await pendingApproval();
    await sql.query(`update approvals set expires_at = now() - interval '1 second' where id = $1`, [
      second.approvalId,
    ]);
    await expireApprovals(db); // the app's own reaper may win the race; either way it moves once
    expect(await job(second.l.jobId)).toMatchObject({ status: "EXPIRED" });
    const statuses = await sql.query(`select status from approvals where id = any($1)`, [
      [first.approvalId, second.approvalId],
    ]);
    expect(statuses.rows.map((r: { status: string }) => r.status)).toEqual(["EXPIRED", "EXPIRED"]);
    expect(gh.writes()).toEqual([]);
  });
});

async function approvalJob(approvalId: string) {
  return (await sql.query(`select job_id from approvals where id = $1`, [approvalId])).rows[0]
    .job_id as string;
}

describe("execution", () => {
  it("approve pushes blobs → tree → commit → new ref → draft PR with a write token for this repo only", async () => {
    const { l, approvalId, actionHash } = await pendingApproval();
    const readMints = gh.mints.length;
    const res = await decide(approvalId, "approve", actionHash);
    expect(res.statusCode, res.body).toBe(200);

    const writeMint = gh.mints[readMints]!;
    expect(writeMint.body).toEqual({
      repository_ids: [101],
      permissions: { contents: "write", pull_requests: "write" },
    });
    const branch = l.task!.workBranch;
    const repoCalls = gh.calls.filter(
      (c) => c.path.startsWith("/repos/acme/web/") && c.auth === `token ${writeMint.token}`,
    );
    expect(repoCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /repos/acme/web/git/ref/heads/${branch}`,
      `GET /repos/acme/web/git/commits/${BASE_SHA}`,
      "POST /repos/acme/web/git/blobs",
      "POST /repos/acme/web/git/blobs",
      "POST /repos/acme/web/git/blobs",
      "POST /repos/acme/web/git/trees",
      "POST /repos/acme/web/git/commits",
      "POST /repos/acme/web/git/refs",
      "GET /repos/acme/web/pulls",
      "POST /repos/acme/web/pulls",
    ]);
    // Every write uses the restricted token.
    expect(gh.writes().every((c) => c.auth === `token ${writeMint.token}`)).toBe(true);
    const body = (p: string) => gh.calls.find((c) => c.method === "POST" && c.path === p)!.body;
    expect(body("/repos/acme/web/git/blobs")).toEqual({
      content: FILES[1]!.contentBase64,
      encoding: "base64",
    });
    const tree = body("/repos/acme/web/git/trees");
    expect(tree).toEqual({
      base_tree: BASE_TREE,
      tree: [
        { path: "bin/run", mode: "100755", type: "blob", sha: expect.any(String) },
        { path: "link", mode: "120000", type: "blob", sha: expect.any(String) },
        { path: "old.txt", mode: "100644", type: "blob", sha: null },
        { path: "src/cart.ts", mode: "100644", type: "blob", sha: expect.any(String) },
      ],
    });
    const commit = body("/repos/acme/web/git/commits");
    expect(commit).toMatchObject({
      message: "#42: Fix cart totals 42\n\nRefs #42",
      tree: sha1(JSON.stringify(tree)),
      parents: [BASE_SHA],
      author: { name: "NEXUS" },
    });
    const commitSha = sha1(JSON.stringify(commit));
    expect(body("/repos/acme/web/git/refs")).toEqual({ ref: `refs/heads/${branch}`, sha: commitSha });
    const approval = await sql.query(`select action from approvals where id = $1`, [approvalId]);
    expect(body("/repos/acme/web/pulls")).toEqual({
      title: "#42: Fix cart totals 42",
      body: approval.rows[0].action.body,
      head: branch,
      base: "main",
      draft: true,
    });

    const pr = {
      pullRequestNumber: gh.pulls.length,
      pullRequestUrl: gh.pulls.at(-1)!.html_url,
      headSha: commitSha,
    };
    expect(res.json()).toMatchObject({ status: "EXECUTED", result: pr, error: null });
    expect(await job(l.jobId)).toMatchObject({ status: "COMPLETED", outcome: "PR_CREATED" });
    expect((await eventTypes(l.jobId)).slice(-4)).toEqual([
      "approval.decided",
      "external_action.completed",
      "job.completed",
      "job.state.changed",
    ]);
    const ledger = await sql.query(`select * from external_actions where approval_id = $1`, [approvalId]);
    expect(ledger.rows[0]).toMatchObject({
      idempotency_key: `${l.jobId}:push_draft_pr`,
      status: "SUCCEEDED",
      commit_sha: commitSha,
      external_id: pr.pullRequestUrl,
    });
    const audits = await sql.query(
      `select action, outcome from audit_records where resource_id = $1 order by occurred_at`,
      [approvalId],
    );
    expect(audits.rows).toEqual([
      { action: "approval.approve", outcome: "SUCCEEDED" },
      { action: "approval.execute", outcome: "SUCCEEDED" },
    ]);

    // No GitHub token ever reaches an owner response, an event, the audit trail or a ledger row.
    const owned = [
      res.body,
      (await owner("GET", "/v1/approvals")).body,
      (await owner("GET", `/v1/jobs/${l.jobId}`)).body,
      (await owner("GET", `/v1/jobs/${l.jobId}/events`)).body,
      JSON.stringify((await sql.query(`select * from audit_records`)).rows),
      JSON.stringify((await sql.query(`select * from external_actions`)).rows),
      JSON.stringify((await sql.query(`select * from approvals`)).rows),
    ];
    for (const m of gh.mints) for (const b of owned) expect(b).not.toContain(m.token);
  });

  it("a restart after the ref was created adopts it and opens exactly one PR (DEV-G08)", async () => {
    const { l, approvalId, actionHash } = await pendingApproval();
    const branch = l.task!.workBranch;
    gh.state.hang = "GET /repos/acme/web/pulls"; // the process "dies" after creating the ref
    const interrupted = decide(approvalId, "approve", actionHash);
    await vi.waitFor(() => expect(gh.refs.has(branch)).toBe(true));
    gh.state.hang = null;
    const before = gh.calls.length;

    // Restart: a second API process on the same database reconciles the APPROVED approval on startup.
    const dir = mkdtempSync(join(tmpdir(), "nexus-test-"));
    writeFileSync(join(dir, "github-app.json"), JSON.stringify(t.githubApp), { mode: 0o600 });
    const restarted = await buildApp({ ...t.config, githubAppFile: join(dir, "github-app.json") });
    try {
      await restarted.ready();
      await vi.waitFor(
        async () =>
          expect(
            (await sql.query(`select status from approvals where id = $1`, [approvalId])).rows[0].status,
          ).toBe("EXECUTED"),
        { timeout: 10_000 },
      );
    } finally {
      await restarted.close();
      rmSync(dir, { recursive: true, force: true });
    }
    const after = gh.calls.slice(before).filter((c) => c.method === "POST" && c.path.startsWith("/repos/"));
    expect(after.map((c) => c.path)).toEqual(["/repos/acme/web/pulls"]); // no blobs, tree, commit or ref again
    expect(gh.calls.filter((c) => c.method === "POST" && c.path === "/repos/acme/web/git/refs")).toHaveLength(
      1,
    );
    expect(gh.pulls.filter((p) => p.head.ref === branch)).toHaveLength(1);
    expect(await job(l.jobId)).toMatchObject({ status: "COMPLETED", outcome: "PR_CREATED" });
    const done = await sql.query(
      `select payload from run_events where job_id = $1 and type = 'external_action.completed'`,
      [l.jobId],
    );
    expect(done.rows).toHaveLength(1);
    expect(done.rows[0].payload).toMatchObject({ adopted: true, headSha: gh.refs.get(branch) });

    // The original process wakes up to a GitHub error: it must not overwrite the finished approval.
    gh.state.release();
    const res = await interrupted;
    expect(res.json()).toMatchObject({ status: "EXECUTED" });
    expect(await job(l.jobId)).toMatchObject({ status: "COMPLETED", outcome: "PR_CREATED" });
  });

  it("never moves a branch it didn't create", async () => {
    const { l, approvalId, actionHash } = await pendingApproval();
    gh.refs.set(l.task!.workBranch, "d".repeat(40));
    const res = await decide(approvalId, "approve", actionHash);
    expect(res.json()).toMatchObject({
      status: "FAILED",
      error: expect.stringMatching(/never moves a branch/),
    });
    expect(gh.writes()).toEqual([]);
    expect(await job(l.jobId)).toMatchObject({ status: "FAILED" });
    expect(gh.refs.get(l.task!.workBranch)).toBe("d".repeat(40));
  });
});
