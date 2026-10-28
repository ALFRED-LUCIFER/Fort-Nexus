import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { BlockList } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import type pg from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Incident,
  IncidentList,
  MonitoredApp,
  MonitoredAppList,
  NotificationList,
  Project,
  WorkspaceList,
} from "@nexus/contracts";
import { createDb, type Db } from "../src/db/index.ts";
import { auditRecords } from "../src/db/schema.ts";
import { probe, type ProbeOptions, type ProbeResult } from "../src/monitoring/probe.ts";
import { healthChecks, monitoredApps } from "../src/monitoring/schema.ts";
import {
  MONITOR,
  createMonitoring,
  getIncident,
  listChecks,
  recordCheck,
  setIncidentStatus,
  updateApp,
} from "../src/monitoring/service.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// EPIC MON: MON-G01 (dedup + racing), MON-G02 (stale is UNKNOWN), the SSRF guard (incl. DNS rebinding) and decoy
// projects (NFR-CNV-05). No live network: a local TLS server, an injected resolver, and IP-literal URLs that the
// guard refuses before any connection.

const HOST = "status.example.test";
const FAR = new Date("2300-01-01T00:00:00Z"); // the API's own reaper tick never reaches these apps
const BLOCKED_URL = "https://127.0.0.1/health";

// ── Local TLS server ──

let server: Server;
let port: number;
let ca: string;
let connections = 0;
const seen: { path: string; host?: string; servername: string | false; cookie?: string; auth?: string }[] =
  [];

function startServer() {
  const dir = mkdtempSync(join(tmpdir(), "nexus-mon-"));
  try {
    const [key, cert] = [join(dir, "k.pem"), join(dir, "c.pem")];
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"]
        .concat(["-keyout", key, "-out", cert, "-days", "1", "-subj", `/CN=${HOST}`])
        .concat(["-addext", `subjectAltName=DNS:${HOST}`]),
      { stdio: "ignore" },
    );
    ca = readFileSync(cert, "utf8");
    server = createServer({ key: readFileSync(key), cert: ca }, (req, res) => {
      res.on("error", () => undefined);
      seen.push({
        path: req.url ?? "",
        host: req.headers.host,
        servername: (req.socket as TLSSocket).servername,
        cookie: req.headers.cookie,
        auth: req.headers.authorization,
      });
      if (req.url === "/ok") return res.end("ok");
      if (req.url === "/500") return res.writeHead(500).end();
      if (req.url === "/redirect")
        return res.writeHead(302, { location: "https://169.254.169.254/latest/meta-data/" }).end();
      if (req.url === "/big") {
        res.writeHead(200);
        const chunk = Buffer.alloc(16 * 1024, 120);
        const pump = () => {
          while (!res.destroyed && res.write(chunk));
        };
        res.on("drain", pump);
        return pump();
      }
      // "/slow": never answers.
    });
    server.on("connection", () => connections++);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    }),
  );
}

const url = (path: string) => new URL(`https://${HOST}:${port}${path}`);
// Tests stand 127.0.0.1 in for a public address (the production BLOCKED list refuses it) and 10/8 for private.
const TEST_BLOCKED = new BlockList();
TEST_BLOCKED.addSubnet("10.0.0.0", 8, "ipv4");
const local = (over: ProbeOptions = {}): ProbeOptions => ({
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  blocked: TEST_BLOCKED,
  ca,
  ...over,
});

// ── API ──

let t: TestApp;
let db: Db;
let sql: pg.Pool;
let cookie: string;
let ownerId: string;
let ws: WorkspaceList;

type Method = "GET" | "POST" | "PATCH";
const call = (method: Method, path: string, body?: unknown, remoteAddress?: string) =>
  t.app.inject({
    method,
    url: path,
    headers: { cookie, origin: t.config.publicOrigin },
    ...(remoteAddress ? { remoteAddress } : {}),
    ...(body === undefined ? {} : { payload: body as object }),
  });
const wsId = (mode: "DEV" | "BUSINESS") => ws.items.find((w) => w.mode === mode)!.id;
async function newProject(mode: "DEV" | "BUSINESS" = "DEV") {
  const slug = `p-${randomBytes(3).toString("hex")}`;
  const res = await call("POST", `/v1/workspaces/${wsId(mode)}/projects`, { name: slug, slug });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Project>();
}
/** An app the API's own tick never checks (its next check is far away), so check counts are exact. */
async function seedApp(p: Project, over: Partial<typeof monitoredApps.$inferInsert> = {}) {
  const [a] = await db
    .insert(monitoredApps)
    .values({
      workspaceId: p.workspaceId,
      projectId: p.id,
      name: "checkout-api",
      environment: "PROD",
      healthUrl: BLOCKED_URL,
      intervalSeconds: 60,
      timeoutMs: 2000,
      failureThreshold: 3,
      createdBy: "test",
      nextCheckAt: FAR,
      ...over,
    })
    .returning();
  return a!;
}
const fail = (statusCode: number | null = 503): ProbeResult => ({
  ok: false,
  statusCode,
  latencyMs: 12,
  error: statusCode ? "HTTP_STATUS" : "TIMEOUT",
});
const pass: ProbeResult = { ok: true, statusCode: 200, latencyMs: 9, error: null };
const sys = () => ({ actor: MONITOR, correlationId: randomUUID() });
const ctx = () => ({ ownerId, actor: `user:${ownerId}`, correlationId: randomUUID() });
const appsOf = async (projectId?: string) =>
  (
    await call("GET", `/v1/monitoring/apps${projectId ? `?projectId=${projectId}` : ""}`)
  ).json<MonitoredAppList>().items;
const incidentsOf = async (q: string) => (await call("GET", `/v1/incidents?${q}`)).json<IncidentList>().items;
const incidentNotes = async (incidentId: string) =>
  (await call("GET", "/v1/notifications?limit=100"))
    .json<NotificationList>()
    .items.filter((n) => n.subject.incidentId === incidentId);

beforeAll(async () => {
  await startServer();
  t = await createTestApp();
  ({ db, pool: sql } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
  ownerId = (await call("GET", "/v1/me")).json<{ id: string }>().id;
  ws = (await call("GET", "/v1/workspaces")).json<WorkspaceList>();
});
afterAll(async () => {
  await t?.app.close();
  await sql?.end();
  server?.closeAllConnections();
  server?.close();
});

describe("SSRF guard and probe", () => {
  it("refuses loopback, private, link-local, metadata, CGNAT, multicast and v4-in-v6 targets before connecting", async () => {
    const before = connections;
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "100.100.100.200",
      "224.0.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd00:ec2::254",
      "ff02::1",
      "::ffff:127.0.0.1",
      "64:ff9b::a00:1",
    ]) {
      const family = address.includes(":") ? 6 : 4;
      expect(
        await probe(url("/ok"), 2000, { ca, resolve: async () => [{ address, family }] }),
        address,
      ).toEqual({
        ok: false,
        statusCode: null,
        latencyMs: null,
        error: "BLOCKED_TARGET",
      });
    }
    // IP literals (no DNS involved) and an answer that mixes a public and a private address.
    expect((await probe(new URL(`https://127.0.0.1:${port}/ok`), 2000)).error).toBe("BLOCKED_TARGET");
    expect((await probe(new URL(`https://[::1]:${port}/ok`), 2000)).error).toBe("BLOCKED_TARGET");
    const mixed = async () => [
      { address: "93.184.215.14", family: 4 },
      { address: "192.168.0.10", family: 4 },
    ];
    expect((await probe(url("/ok"), 2000, { resolve: mixed })).error).toBe("BLOCKED_TARGET");
    expect(connections).toBe(before);
  });

  it("DNS rebinding: resolves once and connects to the vetted address, never a second answer", async () => {
    let lookups = 0;
    // First answer is allowed; any later lookup would rebind to a private address.
    const rebinding = async () =>
      lookups++ === 0 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.1", family: 4 }];
    seen.length = 0;
    expect(await probe(url("/ok"), 2000, local({ resolve: rebinding }))).toMatchObject({
      ok: true,
      statusCode: 200,
      error: null,
    });
    expect(lookups).toBe(1);
    // The connection went to the vetted address while TLS and Host still name the host; no credentials sent.
    expect(seen).toEqual([
      { path: "/ok", host: `${HOST}:${port}`, servername: HOST, cookie: undefined, auth: undefined },
    ]);

    // The reverse rebind: a private first answer is refused, the later public one is never asked for.
    lookups = 0;
    const before = connections;
    const privateFirst = async () =>
      lookups++ === 0 ? [{ address: "10.0.0.1", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
    expect((await probe(url("/ok"), 2000, local({ resolve: privateFirst }))).error).toBe("BLOCKED_TARGET");
    expect(lookups).toBe(1);
    expect(connections).toBe(before);
  });

  it("never follows a redirect: a 3xx is a REDIRECT failure", async () => {
    seen.length = 0;
    expect(await probe(url("/redirect"), 2000, local())).toMatchObject({
      ok: false,
      statusCode: 302,
      error: "REDIRECT",
    });
    expect(seen.map((s) => s.path)).toEqual(["/redirect"]);
  });

  it("classifies timeout, HTTP status, TLS, DNS and credentials; caps the body read", async () => {
    expect(await probe(url("/slow"), 1000, local())).toMatchObject({ ok: false, error: "TIMEOUT" });
    expect(await probe(url("/500"), 2000, local())).toMatchObject({
      ok: false,
      statusCode: 500,
      error: "HTTP_STATUS",
    });
    // Self-signed without the test CA, and a certificate for another name.
    expect((await probe(url("/ok"), 2000, local({ ca: undefined }))).error).toBe("TLS");
    const other = new URL(`https://other.example.test:${port}/ok`);
    expect((await probe(other, 2000, local())).error).toBe("TLS");
    const nx = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    expect((await probe(url("/ok"), 2000, local({ resolve: nx }))).error).toBe("DNS");
    expect((await probe(new URL(`https://u:p@${HOST}:${port}/ok`), 2000, local())).error).toBe(
      "BLOCKED_TARGET",
    );
    // An endless body: the read stops at 64 KB well within the timeout.
    expect(await probe(url("/big"), 5000, local())).toMatchObject({ ok: true, statusCode: 200 });
  });

  it("throws on API shutdown instead of recording a failure the app didn't cause", async () => {
    const shutdown = new AbortController();
    const pending = probe(url("/slow"), 5000, local({ signal: shutdown.signal }));
    setTimeout(() => shutdown.abort(), 50);
    await expect(pending).rejects.toThrow();
  });
});

describe("incidents", () => {
  it("MON-G01: three failures open one incident with three evidence and one notification; repeats add evidence only", async () => {
    const p = await newProject();
    const a = await seedApp(p);
    for (let i = 0; i < 3; i++) {
      const res = await call("POST", `/v1/monitoring/apps/${a.id}/check`, undefined, "198.51.100.1");
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ ok: false, error: "BLOCKED_TARGET", appId: a.id });
    }
    const [inc, ...more] = await incidentsOf(`projectId=${p.id}`);
    expect(more).toEqual([]);
    expect(inc).toMatchObject({
      appId: a.id,
      projectId: p.id,
      fingerprint: `app:${a.id}:PROD:http`,
      severity: "SEV2",
      status: "OPEN",
      evidenceCount: 3,
      recoveredAt: null,
    });
    expect(inc!.evidence.map((e) => e.error)).toEqual(["BLOCKED_TARGET", "BLOCKED_TARGET", "BLOCKED_TARGET"]);
    const [app] = await appsOf(p.id);
    expect(app).toMatchObject({ health: "DOWN", consecutiveFailures: 3, openIncidentId: inc!.id });

    const notes = await incidentNotes(inc!.id);
    expect(notes).toEqual([
      expect.objectContaining({
        projectId: p.id,
        category: "TASK_FAILED",
        title: "SEV2 · checkout-api (PROD) health check failing",
        subject: { jobId: null, approvalId: null, incidentId: inc!.id },
      }),
    ]);
    expect(notes[0]!.body).toContain("3 consecutive failed checks of 127.0.0.1");
    expect(notes[0]!.body).not.toContain("/health");

    // Throttle policy: further failures attach as evidence and never notify again.
    await recordCheck(db, a.id, fail(), sys());
    await recordCheck(db, a.id, fail(null), sys());
    expect(await getIncident(db, ownerId, inc!.id)).toMatchObject({ evidenceCount: 5, status: "OPEN" });
    expect(await incidentNotes(inc!.id)).toHaveLength(1);
    const opens = await db
      .select()
      .from(auditRecords)
      .where(and(eq(auditRecords.action, "incident.open"), eq(auditRecords.resourceId, inc!.id)));
    expect(opens).toHaveLength(1);
    const checks = await db
      .select()
      .from(auditRecords)
      .where(and(eq(auditRecords.action, "monitoring.app.check"), eq(auditRecords.resourceId, a.id)));
    expect(checks).toHaveLength(3); // the owner's manual checks; the scheduler's are stored, not audited
  });

  it("MON-G01: racing ticks check an app once, and racing checks open exactly one incident", async () => {
    const p = await newProject();
    const due = new Date("2200-01-01T00:00:00Z");
    const ticked = await seedApp(p, {
      healthUrl: url("/500").toString(),
      failureThreshold: 1,
      nextCheckAt: due,
    });
    const shutdown = new AbortController();
    const [m1, m2] = [1, 2].map(() => createMonitoring(db, t.app.log, shutdown.signal, local()));
    const now = new Date(due.getTime() + 1000);
    m1!.tick(now);
    m2!.tick(now);
    m1!.tick(now); // still busy: no second batch
    await Promise.all([m1!.drain(), m2!.drain()]);
    expect(await db.select().from(healthChecks).where(eq(healthChecks.appId, ticked.id))).toHaveLength(1);
    const [claimed] = await db.select().from(monitoredApps).where(eq(monitoredApps.id, ticked.id));
    expect(claimed!.nextCheckAt).toEqual(new Date(now.getTime() + 60_000));
    expect(await incidentsOf(`projectId=${p.id}`)).toHaveLength(1);

    const raced = await seedApp(p, { failureThreshold: 1, name: "raced" });
    await Promise.all(Array.from({ length: 5 }, () => recordCheck(db, raced.id, fail(), sys())));
    const mine = (await incidentsOf(`projectId=${p.id}`)).filter((i) => i.appId === raced.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.evidenceCount).toBe(5);
    expect(await incidentNotes(mine[0]!.id)).toHaveLength(1);
    // The partial unique index holds even without the app lock.
    await expect(
      sql.query(
        `insert into incidents (workspace_id, project_id, app_id, fingerprint, severity, title)
         values ($1, $2, $3, $4, 'SEV2', 'dup')`,
        [p.workspaceId, p.id, raced.id, mine[0]!.fingerprint],
      ),
    ).rejects.toThrow(/incidents_active_fingerprint_uq/);
  });

  it("a pass sets recoveredAt; the owner acknowledges and resolves; a new streak opens a new incident", async () => {
    const p = await newProject();
    const a = await seedApp(p);
    for (let i = 0; i < 3; i++) await recordCheck(db, a.id, fail(), sys());
    const [first] = await incidentsOf(`projectId=${p.id}`);
    await recordCheck(db, a.id, pass, sys());
    const recovered = await getIncident(db, ownerId, first!.id);
    expect(recovered.recoveredAt).not.toBeNull();
    expect(recovered.evidenceCount).toBe(3); // a pass isn't evidence
    expect((await appsOf(p.id))[0]).toMatchObject({ health: "HEALTHY", openIncidentId: first!.id });

    const ack = await call("POST", `/v1/incidents/${first!.id}/status`, { status: "ACKNOWLEDGED" });
    expect(ack.json<Incident>()).toMatchObject({
      status: "ACKNOWLEDGED",
      acknowledgedAt: expect.any(String),
    });
    const resolved = await call("POST", `/v1/incidents/${first!.id}/status`, { status: "RESOLVED" });
    expect(resolved.json<Incident>()).toMatchObject({ status: "RESOLVED", resolvedAt: expect.any(String) });
    expect(
      (await call("POST", `/v1/incidents/${first!.id}/status`, { status: "ACKNOWLEDGED" })).statusCode,
    ).toBe(409);
    expect((await call("POST", `/v1/incidents/${first!.id}/status`, { status: "OPEN" })).statusCode).toBe(
      400,
    );

    for (let i = 0; i < 3; i++) await recordCheck(db, a.id, fail(), sys());
    const all = await incidentsOf(`projectId=${p.id}`);
    expect(all.map((i) => i.status)).toEqual(["OPEN", "RESOLVED"]);
    expect(all[0]!.id).not.toBe(first!.id);
    expect(all[0]!.evidenceCount).toBe(3);
    expect(all[1]!.evidenceCount).toBe(3); // the old incident keeps its evidence
    expect(await incidentNotes(all[0]!.id)).toHaveLength(1);
    expect(await incidentsOf(`projectId=${p.id}&status=RESOLVED`)).toHaveLength(1);
  });

  it("a Business project's incident notifies BUSINESS_EXCEPTION; non-PROD is SEV3", async () => {
    const p = await newProject("BUSINESS");
    const a = await seedApp(p, { environment: "STAGING", failureThreshold: 1, name: "shop-web" });
    await recordCheck(db, a.id, fail(), sys());
    const [inc] = await incidentsOf(`projectId=${p.id}`);
    expect(inc).toMatchObject({ severity: "SEV3", fingerprint: `app:${a.id}:STAGING:http` });
    expect(await incidentNotes(inc!.id)).toEqual([
      expect.objectContaining({
        category: "BUSINESS_EXCEPTION",
        title: "SEV3 · shop-web (STAGING) health check failing",
      }),
    ]);
  });
});

describe("health", () => {
  it("MON-G02: never checked, disabled or stale is UNKNOWN, never HEALTHY", async () => {
    const p = await newProject();
    const a = await seedApp(p, { failureThreshold: 3 });
    const health = async () => (await appsOf(p.id)).find((x) => x.id === a.id)!.health;
    expect(await health()).toBe("UNKNOWN");
    await recordCheck(db, a.id, pass, sys());
    expect(await health()).toBe("HEALTHY");
    await recordCheck(db, a.id, fail(), sys());
    expect(await health()).toBe("DEGRADED");
    await recordCheck(db, a.id, pass, sys());
    // The home host was off: the last (passing) check is older than 2 × interval.
    await db
      .update(monitoredApps)
      .set({ lastCheckedAt: new Date(Date.now() - 121_000) })
      .where(eq(monitoredApps.id, a.id));
    expect(await health()).toBe("UNKNOWN");
    await recordCheck(db, a.id, pass, sys());
    await db.update(monitoredApps).set({ disabled: true }).where(eq(monitoredApps.id, a.id));
    expect(await health()).toBe("UNKNOWN");
  });

  it("the scheduler checks due apps of active projects only and stores every check", async () => {
    const live = await newProject();
    const archived = await newProject();
    const due = new Date("2250-01-01T00:00:00Z");
    const ok = await seedApp(live, { healthUrl: url("/ok").toString(), nextCheckAt: due });
    const off = await seedApp(live, { healthUrl: url("/ok").toString(), nextCheckAt: due, disabled: true });
    const gone = await seedApp(archived, { healthUrl: url("/ok").toString(), nextCheckAt: due });
    expect((await call("PATCH", `/v1/projects/${archived.id}`, { archived: true })).statusCode).toBe(200);
    const m = createMonitoring(db, t.app.log, new AbortController().signal, local());
    m.tick(new Date(due.getTime() + 1000));
    await m.drain();
    const checks = await listChecks(db, ownerId, ok.id);
    expect(checks).toEqual([expect.objectContaining({ ok: true, statusCode: 200, error: null })]);
    expect((await call("GET", `/v1/monitoring/apps/${ok.id}/checks`)).json()).toEqual({ items: checks });
    expect(await listChecks(db, ownerId, off.id)).toEqual([]);
    expect(await listChecks(db, ownerId, gone.id)).toEqual([]);
    expect((await appsOf(live.id)).find((x) => x.id === ok.id)!.health).toBe("HEALTHY");
  });
});

describe("apps API and project scope (NFR-CNV-05)", () => {
  it("registers, lists, updates (audited) and validates apps", async () => {
    const p = await newProject();
    const res = await call("POST", "/v1/monitoring/apps", {
      projectId: p.id,
      name: "api",
      environment: "PROD",
      healthUrl: "https://10.0.0.5/healthz",
    });
    expect(res.statusCode, res.body).toBe(201);
    const app = res.json<MonitoredApp>();
    expect(app).toMatchObject({
      projectId: p.id,
      intervalSeconds: 300,
      timeoutMs: 5000,
      failureThreshold: 3,
      disabled: false,
      health: "UNKNOWN",
      lastCheckedAt: null,
      openIncidentId: null,
    });
    const patched = await call("PATCH", `/v1/monitoring/apps/${app.id}`, {
      disabled: true,
      failureThreshold: 5,
    });
    expect(patched.json<MonitoredApp>()).toMatchObject({
      disabled: true,
      failureThreshold: 5,
      health: "UNKNOWN",
    });
    const audits = await db.select().from(auditRecords).where(eq(auditRecords.resourceId, app.id));
    expect(audits.map((r) => r.action).sort()).toEqual(["monitoring.app.create", "monitoring.app.update"]);
    expect(audits[0]!.metadata).toMatchObject({ projectId: p.id, workspaceId: p.workspaceId });

    const bad = (body: object) =>
      call("POST", "/v1/monitoring/apps", { projectId: p.id, name: "x", environment: "DEV", ...body });
    expect((await bad({ healthUrl: "http://10.0.0.5/" })).statusCode).toBe(400);
    expect((await bad({ healthUrl: "https://u:p@10.0.0.5/" })).statusCode).toBe(400);
    expect((await bad({ healthUrl: "https://10.0.0.5/", command: "rm -rf /" })).statusCode).toBe(400);
    expect((await bad({ healthUrl: "https://10.0.0.5/", repositoryId: "101" })).statusCode).toBe(403);
    expect((await bad({ healthUrl: "https://10.0.0.5/", projectId: randomUUID() })).statusCode).toBe(404);
    expect((await call("PATCH", `/v1/monitoring/apps/${app.id}`, {})).statusCode).toBe(400);
  });

  it("decoy project B never sees A's apps or incidents; another owner gets 404; an archived project is read-only", async () => {
    const a = await newProject();
    const b = await newProject();
    const app = await seedApp(a, { failureThreshold: 1 });
    await recordCheck(db, app.id, fail(), sys());
    const [inc] = await incidentsOf(`projectId=${a.id}`);

    expect(await appsOf(b.id)).toEqual([]);
    expect(await incidentsOf(`projectId=${b.id}`)).toEqual([]);
    expect((await appsOf()).map((x) => x.id)).toContain(app.id); // the read-only "All" view
    expect((await incidentsOf("")).map((x) => x.id)).toContain(inc!.id);
    expect((await call("GET", `/v1/monitoring/apps?projectId=${randomUUID()}`)).statusCode).toBe(404);

    const stranger = { ownerId: "someone-else", actor: "user:someone-else", correlationId: randomUUID() };
    await expect(getIncident(db, "someone-else", inc!.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(listChecks(db, "someone-else", app.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(updateApp(db, stranger, app.id, { name: "x" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(setIncidentStatus(db, stranger, inc!.id, "RESOLVED")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(t.app.inject({ method: "GET", url: `/v1/incidents/${inc!.id}` })).resolves.toMatchObject({
      statusCode: 401,
    });

    expect((await call("PATCH", `/v1/projects/${a.id}`, { archived: true })).statusCode).toBe(200);
    expect((await call("GET", `/v1/incidents/${inc!.id}`)).statusCode).toBe(200); // history stays readable
    expect((await call("PATCH", `/v1/monitoring/apps/${app.id}`, { name: "y" })).statusCode).toBe(409);
    expect(
      (await call("POST", `/v1/monitoring/apps/${app.id}/check`, undefined, "198.51.100.2")).statusCode,
    ).toBe(409);
    expect((await call("POST", `/v1/incidents/${inc!.id}/status`, { status: "RESOLVED" })).statusCode).toBe(
      409,
    );
    const create = await call("POST", "/v1/monitoring/apps", {
      projectId: a.id,
      name: "z",
      environment: "DEV",
      healthUrl: "https://10.0.0.5/",
    });
    expect(create.statusCode).toBe(409);
    await expect(updateApp(db, ctx(), app.id, { name: "z" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rate-limits manual checks to 6 a minute", async () => {
    const p = await newProject();
    const a = await seedApp(p);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++)
      codes.push(
        (await call("POST", `/v1/monitoring/apps/${a.id}/check`, undefined, "198.51.100.3")).statusCode,
      );
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });
});
