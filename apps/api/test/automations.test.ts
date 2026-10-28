import { createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SCORING_WEIGHTS,
  type AutomationClientSecret,
  type AutomationRun,
  type LeaseResponse,
  type Project,
  type TriggerResponse,
  type WorkspaceList,
} from "@nexus/contracts";
import { createDb, type Db } from "../src/db/index.ts";
import { researchWatchlists } from "../src/research/schema.ts";
import { createTestApp, homeProjectId, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// EPIC AUTO: n8n's only way in is a signed, typed trigger for an allowed action in its own project.
let t: TestApp;
let db: Db;
let sql: pg.Pool;
let cookie: string;
let projectA: string;
let projectB: string;

type Method = "GET" | "POST" | "PATCH" | "PUT";
const owner = (method: Method, url: string, body?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: { cookie, origin: t.config.publicOrigin },
    ...(body === undefined ? {} : { payload: body as object }),
  });
type Client = { id: string; key: string };
async function newClient(body: Record<string, unknown> = {}): Promise<Client> {
  const res = await owner("POST", "/v1/automations/clients", {
    projectId: projectA,
    name: "n8n",
    allowedActions: ["jobs.create", "research.run"],
    allowedJobTypes: ["RUNNER_DIAGNOSTIC"],
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  const s = res.json() as AutomationClientSecret;
  return { id: s.client.id, key: s.signingKey };
}
const now = () => Math.floor(Date.now() / 1000);
const sign = (key: string, ts: number, raw: string) =>
  `v1=${createHmac("sha256", key).update(`${ts}.${raw}`).digest("hex")}`;
function fire(
  c: Client,
  body: unknown,
  o: { ts?: number; sig?: string; send?: (raw: string) => string; headers?: Record<string, string> } = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const ts = o.ts ?? now();
  return t.app.inject({
    method: "POST",
    url: "/v1/automations/trigger",
    headers: {
      "content-type": "application/json",
      "x-nexus-client": c.id,
      "x-nexus-timestamp": String(ts),
      "x-nexus-signature": o.sig ?? sign(c.key, ts, raw),
      ...o.headers,
    },
    payload: o.send ? o.send(raw) : raw,
  });
}
const diagnostic = (projectId = projectA, key = randomUUID()) => ({
  idempotencyKey: key,
  action: {
    type: "jobs.create",
    request: { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version", projectId },
  },
});
const count = async (table: string) =>
  Number((await sql.query(`select count(*)::int as n from ${table}`)).rows[0].n);
const runsOf = async (c: Client) =>
  (await owner("GET", `/v1/automations/runs?clientId=${c.id}`)).json().items as AutomationRun[];
async function watchlist(projectId: string) {
  const { workspaceId } = (
    await sql.query(`select workspace_id as "workspaceId" from projects where id = $1`, [projectId])
  ).rows[0];
  const [w] = await db
    .insert(researchWatchlists)
    .values({
      workspaceId,
      projectId,
      name: "AI news",
      keywords: ["agents"],
      sources: [], // nothing to fetch: the run completes without network
      weights: DEFAULT_SCORING_WEIGHTS,
      schedule: { localTime: "08:00", timezone: "Asia/Dubai", days: [1], paused: true },
      createdBy: "test",
    })
    .returning();
  return w!.id;
}

beforeAll(async () => {
  t = await createTestApp({ RUNNER_LEASE_POLL_MS: "300" });
  ({ db, pool: sql } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  projectA = await homeProjectId(t, cookie);
  const ws = (await owner("GET", "/v1/workspaces")).json() as WorkspaceList;
  const decoy = await owner("POST", `/v1/workspaces/${ws.items.find((w) => w.mode === "DEV")!.id}/projects`, {
    name: "Decoy",
    slug: "decoy",
  });
  projectB = (decoy.json() as Project).id;
});

afterAll(async () => {
  await t?.app.close();
  await sql?.end();
});

beforeEach(async () => {
  await owner("PUT", "/v1/system/emergency-stop", { engaged: false });
  await sql.query(`update jobs set status = 'CANCELLED' where status = 'QUEUED'`);
});

describe("AUTO-G01 n8n launches a typed home-host job", () => {
  it("AUTO-G01: a signed jobs.create trigger creates a typed job in the client's project that a runner leases", async () => {
    const c = await newClient();
    const res = await fire(c, diagnostic());
    expect(res.statusCode, res.body).toBe(202);
    const out = res.json() as TriggerResponse;
    expect(out.result.kind).toBe("job");

    const job = (await owner("GET", `/v1/jobs/${out.result.id}`)).json();
    expect(job).toMatchObject({ projectId: projectA, jobType: "RUNNER_DIAGNOSTIC", status: "QUEUED" });

    const pair = await owner("POST", "/v1/runners/pair");
    const reg = await t.app.inject({
      method: "POST",
      url: "/v1/runner/register",
      payload: { code: pair.json().code, name: "home", os: "darwin", version: "0.0.0" },
    });
    const lease = await t.app.inject({
      method: "POST",
      url: "/v1/runner/lease",
      headers: { authorization: `Bearer ${reg.json().token}` },
    });
    expect(lease.statusCode).toBe(200);
    expect((lease.json() as LeaseResponse).jobId).toBe(out.result.id);

    const [run] = await runsOf(c);
    expect(run).toMatchObject({
      id: out.automationRunId,
      action: "jobs.create",
      status: "ACCEPTED",
      reason: null,
    });
    const audits = (
      await sql.query(
        `select actor, outcome, metadata from audit_records where action = 'automation.trigger' and resource_id = $1`,
        [out.automationRunId],
      )
    ).rows;
    expect(audits).toEqual([
      expect.objectContaining({
        actor: `automation:${c.id}`,
        outcome: "SUCCEEDED",
        metadata: expect.objectContaining({ projectId: projectA }),
      }),
    ]);
    const clients = (await owner("GET", `/v1/automations/clients?projectId=${projectA}`)).json().items;
    expect(clients.find((x: { id: string }) => x.id === c.id).lastUsedAt).not.toBeNull();
  });

  it("AUTO-G01: a signed research.run trigger starts a run of a watchlist in the client's project", async () => {
    const c = await newClient({ allowedActions: ["research.run"], allowedJobTypes: [] });
    const watchlistId = await watchlist(projectA);
    const res = await fire(c, {
      idempotencyKey: randomUUID(),
      action: { type: "research.run", watchlistId },
    });
    expect(res.statusCode, res.body).toBe(202);
    const out = res.json() as TriggerResponse;
    expect(out.result.kind).toBe("research_run");
    const run = (await sql.query(`select * from research_runs where id = $1`, [out.result.id])).rows[0];
    expect(run).toMatchObject({ watchlist_id: watchlistId, project_id: projectA, trigger: "MANUAL" });
    // The trigger starts the run; it finishes instead of staying RUNNING.
    await vi.waitFor(
      async () =>
        expect(
          (await sql.query(`select status from research_runs where id = $1`, [out.result.id])).rows[0].status,
        ).toBe("COMPLETED"),
      { timeout: 10_000 },
    );
  });
});

describe("AUTO-G02 reject forged webhook", () => {
  it("AUTO-G02: bad signature, stale or future timestamp, unknown or disabled client, tampering and missing headers all get the same 401 and enqueue nothing", async () => {
    const c = await newClient();
    const disabled = await newClient();
    expect(
      (await owner("PATCH", `/v1/automations/clients/${disabled.id}`, { disabled: true })).statusCode,
    ).toBe(200);
    const jobs = await count("jobs");
    const runs = await count("automation_runs");
    const body = diagnostic();
    const attempts = [
      fire(c, body, { sig: sign(randomBytes(32).toString("base64url"), now(), JSON.stringify(body)) }),
      fire(c, body, { sig: "v1=00" }),
      fire(c, body, { ts: now() - 301 }),
      fire(c, body, { ts: now() + 301 }),
      fire({ id: randomUUID(), key: c.key }, body),
      fire(disabled, body),
      fire(c, body, { send: (raw) => raw.replace("node-version", "host-info") }),
      fire(c, body, { send: (raw) => `${raw} ` }),
      fire(c, body, { headers: { "x-nexus-signature": "" } }),
      fire(c, body, { headers: { "x-nexus-client": "not-a-uuid" } }),
      fire(c, body, { headers: { "x-nexus-timestamp": "soon" } }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().error).toEqual({
        code: "UNAUTHENTICATED",
        message: "Automation request could not be authenticated",
      });
    }
    expect(await count("jobs")).toBe(jobs);
    expect(await count("automation_runs")).toBe(runs);
    // Forged calls against a real client are audited without the signature.
    const denied = (
      await sql.query(
        `select metadata from audit_records where action = 'automation.trigger.unauthenticated'`,
      )
    ).rows.map((r) => r.metadata.reason);
    expect(denied).toEqual(
      expect.arrayContaining([
        "signature mismatch",
        "timestamp outside the replay window",
        "client disabled",
      ]),
    );
  });

  it("AUTO-G02: a rotated key stops verifying at once and the new one works", async () => {
    const c = await newClient();
    // The documented derivation, so n8n operators can reason about it: HKDF-SHA256(secret, clientId, version).
    const derive = (v: number) =>
      Buffer.from(hkdfSync("sha256", t.config.authSecret, c.id, `nexus-automation-v${v}`, 32)).toString(
        "base64url",
      );
    expect(c.key).toBe(derive(1));
    const rotated = await owner("POST", `/v1/automations/clients/${c.id}/rotate`);
    expect(rotated.statusCode).toBe(200);
    const s = rotated.json() as AutomationClientSecret;
    expect(s.client.keyVersion).toBe(2);
    expect(s.signingKey).toBe(derive(2));
    expect((await fire(c, diagnostic())).statusCode).toBe(401);
    expect((await fire({ id: c.id, key: s.signingKey }, diagnostic())).statusCode).toBe(202);
  });

  it("never stores or audits the signing key", async () => {
    const c = await newClient();
    const stored = JSON.stringify([
      (await sql.query(`select * from automation_clients`)).rows,
      (await sql.query(`select * from audit_records`)).rows,
    ]);
    expect(stored).not.toContain(c.key);
  });
});

describe("AUTO-G03 n8n cannot command an unrestricted host shell", () => {
  it("AUTO-G03: a shell command or any unknown field is a 400, recorded as rejected, and nothing is enqueued", async () => {
    const c = await newClient();
    const jobs = await count("jobs");
    const shells = [
      { ...diagnostic(), shell: "rm -rf /" },
      {
        idempotencyKey: randomUUID(),
        action: { type: "jobs.create", request: { ...diagnostic().action.request, command: "curl x | sh" } },
      },
      { idempotencyKey: randomUUID(), action: { type: "shell.exec", command: "id" } },
      "not json",
    ];
    for (const body of shells) {
      const res = await fire(c, body);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
    }
    expect(await count("jobs")).toBe(jobs);
    const runs = await runsOf(c);
    expect(runs).toHaveLength(4);
    expect(runs.every((r) => r.status === "REJECTED" && r.action === null && r.result === null)).toBe(true);
  });
});

describe("policy", () => {
  it("refuses an action, a job type or a project the client isn't allowed, recording the reason", async () => {
    const researchOnly = await newClient({ allowedActions: ["research.run"], allowedJobTypes: [] });
    const c = await newClient();
    const jobs = await count("jobs");
    const runs = await count("research_runs");
    const issue = {
      idempotencyKey: randomUUID(),
      action: {
        type: "jobs.create",
        request: { jobType: "DEV_ISSUE_TO_PR", projectId: projectA, repositoryId: "101", issueNumber: 1 },
      },
    };
    const cases: [Client, unknown, number, RegExp][] = [
      [researchOnly, diagnostic(), 403, /may not run jobs.create/],
      [c, issue, 403, /may not create DEV_ISSUE_TO_PR/],
      [c, diagnostic(projectB), 403, /only in its own project/],
      [
        c,
        {
          idempotencyKey: randomUUID(),
          action: { type: "research.run", watchlistId: await watchlist(projectB) },
        },
        404,
        /Watchlist not found/,
      ],
    ];
    for (const [client, body, status, reason] of cases) {
      const res = await fire(client, body);
      expect(res.statusCode, res.body).toBe(status);
      expect(res.json().error.message).toMatch(reason);
    }
    expect(await count("jobs")).toBe(jobs);
    expect(await count("research_runs")).toBe(runs);
    expect((await runsOf(c)).map((r) => [r.status, r.reason])).toEqual([
      ["REJECTED", "Watchlist not found"],
      ["REJECTED", "An automation client acts only in its own project"],
      ["REJECTED", "This automation client may not create DEV_ISSUE_TO_PR jobs"],
    ]);
  });

  it("emergency stop refuses a trigger; a rejected key can be retried once it is released", async () => {
    const c = await newClient();
    const body = diagnostic();
    await owner("PUT", "/v1/system/emergency-stop", { engaged: true });
    const jobs = await count("jobs");
    const stopped = await fire(c, body);
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json().error.code).toBe("EMERGENCY_STOP");
    const research = await fire(c, {
      idempotencyKey: randomUUID(),
      action: { type: "research.run", watchlistId: await watchlist(projectA) },
    });
    expect(research.statusCode).toBe(409);
    expect(await count("jobs")).toBe(jobs);

    await owner("PUT", "/v1/system/emergency-stop", { engaged: false });
    expect((await fire(c, body)).statusCode).toBe(202);
    expect((await runsOf(c)).map((r) => r.status)).toEqual(["ACCEPTED", "REJECTED", "REJECTED"]);
  });

  it("an archived project's client can't act and can't be changed", async () => {
    const ws = (await owner("GET", "/v1/workspaces")).json() as WorkspaceList;
    const p = (
      await owner("POST", `/v1/workspaces/${ws.items.find((w) => w.mode === "DEV")!.id}/projects`, {
        name: "Old",
        slug: `old-${randomBytes(3).toString("hex")}`,
      })
    ).json() as Project;
    const c = await newClient({ projectId: p.id });
    await owner("PATCH", `/v1/projects/${p.id}`, { archived: true });
    expect((await fire(c, diagnostic(p.id))).statusCode).toBe(409);
    expect((await owner("PATCH", `/v1/automations/clients/${c.id}`, { name: "x" })).statusCode).toBe(409);
    expect(
      (
        await owner("POST", "/v1/automations/clients", {
          projectId: p.id,
          name: "y",
          allowedActions: ["research.run"],
        })
      ).statusCode,
    ).toBe(409);
  });
});

describe("replay and limits", () => {
  it("replaying an idempotency key returns the first result and runs nothing twice; a different body is a conflict", async () => {
    const c = await newClient();
    const body = diagnostic();
    const jobs = await count("jobs");
    const [a, b] = await Promise.all([fire(c, body), fire(c, body)]);
    const again = await fire(c, body);
    expect([a.statusCode, b.statusCode, again.statusCode]).toEqual([202, 202, 202]);
    expect(b.json()).toEqual(a.json());
    expect(again.json()).toEqual(a.json());
    expect(await count("jobs")).toBe(jobs + 1);

    const reused = await fire(c, {
      ...body,
      action: { ...body.action, request: { ...body.action.request, preset: "host-info" } },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await count("jobs")).toBe(jobs + 1);
  });

  it("rate-limits per client after authentication", async () => {
    const c = await newClient({ rateLimitPerMinute: 2 });
    const other = await newClient();
    expect((await fire(c, diagnostic())).statusCode).toBe(202);
    expect((await fire(c, diagnostic())).statusCode).toBe(202);
    const limited = await fire(c, diagnostic());
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect((await fire(other, diagnostic())).statusCode).toBe(202);
    // A forged request is refused as unauthenticated, never counted against or reported as the client's limit.
    expect((await fire(c, diagnostic(), { sig: "v1=00" })).statusCode).toBe(401);
  });

  it("refuses a body over 64 KB before reading it", async () => {
    const c = await newClient();
    const res = await fire(c, { ...diagnostic(), pad: "x".repeat(70 * 1024) });
    expect(res.statusCode).toBe(413);
  });
});

describe("owner API", () => {
  it("validates input, scopes lists to the project (NFR-CNV-05) and 404s unknown clients", async () => {
    const a = await newClient();
    const b = await newClient({ projectId: projectB });
    await fire(a, diagnostic());
    const ids = async (url: string) =>
      ((await owner("GET", url)).json().items as { id: string; clientId?: string }[]).map(
        (x) => x.clientId ?? x.id,
      );

    expect(await ids(`/v1/automations/clients?projectId=${projectB}`)).toEqual([b.id]);
    expect(await ids("/v1/automations/clients")).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(await ids(`/v1/automations/runs?projectId=${projectB}`)).not.toContain(a.id);
    expect(await ids(`/v1/automations/runs?projectId=${projectA}`)).toContain(a.id);
    expect((await owner("GET", `/v1/automations/clients?projectId=${randomUUID()}`)).statusCode).toBe(404);

    const bad = [
      { projectId: projectA, name: "x", allowedActions: [] },
      { projectId: projectA, name: "x", allowedActions: ["shell.exec"] },
      { projectId: projectA, name: "x", allowedActions: ["jobs.create"], rateLimitPerMinute: 61 },
      { projectId: projectA, name: "x", allowedActions: ["jobs.create"], command: "id" },
    ];
    for (const body of bad)
      expect((await owner("POST", "/v1/automations/clients", body)).statusCode).toBe(400);
    expect(
      (
        await owner("POST", "/v1/automations/clients", {
          projectId: randomUUID(),
          name: "x",
          allowedActions: ["research.run"],
        })
      ).statusCode,
    ).toBe(404);
    expect((await owner("PATCH", `/v1/automations/clients/${a.id}`, {})).statusCode).toBe(400);
    expect(
      (await owner("PATCH", `/v1/automations/clients/${randomUUID()}`, { disabled: true })).statusCode,
    ).toBe(404);
    expect((await owner("POST", `/v1/automations/clients/${randomUUID()}/rotate`)).statusCode).toBe(404);

    const unauth = await t.app.inject({ method: "GET", url: "/v1/automations/clients" });
    expect(unauth.statusCode).toBe(401);
    const noOrigin = await t.app.inject({
      method: "POST",
      url: `/v1/automations/clients/${a.id}/rotate`,
      headers: { cookie },
    });
    expect(noOrigin.statusCode).toBe(403);
  });
});
