import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  REMOTE_ACCESS_STALE_AFTER_MS,
  type RemoteAccessReport,
  type RemoteAccessStatus,
} from "@nexus/contracts";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/index.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

const REPORT: RemoteAccessReport = {
  state: "RUNNING",
  url: "https://home.tail2a3f3c.ts.net",
  serving: true,
  funnel: false,
  devices: [{ name: "home", os: "macOS", online: true, self: true }],
};

let t: TestApp;
let app: FastifyInstance;
let sql: pg.Pool;
let cookie: string;

const asOwner = (method: "GET" | "POST", url: string) =>
  app.inject({ method, url, headers: { cookie, origin: t.config.publicOrigin } });
const status = async () => {
  const res = await asOwner("GET", "/v1/remote-access");
  expect(res.statusCode, res.body).toBe(200);
  return res.json<RemoteAccessStatus>();
};
const beat = (token: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/v1/runner/heartbeat",
    headers: { authorization: `Bearer ${token}` },
    payload: { activeJobIds: [], ...body },
  });

async function pair(name: string) {
  const code = (await asOwner("POST", "/v1/runners/pair")).json<{ code: string }>().code;
  const reg = await app.inject({
    method: "POST",
    url: "/v1/runner/register",
    payload: { code, name, os: "darwin", version: "0.0.0" },
  });
  expect(reg.statusCode, reg.body).toBe(201); // /register allows 10 a minute: this file stays within it
  return reg.json<{ runnerId: string; token: string }>();
}
const reportedAgo = (runnerId: string, ms: number) =>
  sql.query(`update runners set remote_access_at = now() - make_interval(secs => $2) where id = $1`, [
    runnerId,
    ms / 1000,
  ]);

beforeAll(async () => {
  t = await createTestApp();
  app = t.app;
  ({ pool: sql } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
});

afterAll(async () => {
  await app?.close();
  await sql?.end();
});

beforeEach(async () => {
  await sql.query(`update runners set revoked_at = now() where revoked_at is null`);
});

describe("GET /v1/remote-access", () => {
  it("needs a signed-in owner", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/remote-access" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a runner token", async () => {
    const { token } = await pair("home");
    const res = await app.inject({
      method: "GET",
      url: "/v1/remote-access",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("is empty until a runner reports, and a plain heartbeat isn't a report", async () => {
    const { token } = await pair("home");
    expect((await beat(token, {})).statusCode).toBe(200);
    expect(await status()).toEqual({
      publicOrigin: t.config.publicOrigin,
      runnerName: null,
      reportedAt: null,
      stale: false,
      report: null,
    });
  });

  it("returns the report a heartbeat carried", async () => {
    const { token } = await pair("home");
    expect((await beat(token, { remoteAccess: REPORT })).statusCode).toBe(200);
    const s = await status();
    expect(s).toMatchObject({
      publicOrigin: t.config.publicOrigin,
      runnerName: "home",
      stale: false,
      report: REPORT,
    });
    expect(Date.now() - Date.parse(s.reportedAt!)).toBeLessThan(30_000);
  });

  it("keeps the report and its time through later heartbeats without one", async () => {
    const { token, runnerId } = await pair("home");
    await beat(token, { remoteAccess: REPORT });
    await reportedAgo(runnerId, 60_000);
    const before = (await status()).reportedAt;
    await beat(token, {});
    expect(await status()).toMatchObject({ reportedAt: before, report: REPORT });
  });

  it("marks a report older than the limit as stale, and not one just inside it", async () => {
    const { token, runnerId } = await pair("home");
    await beat(token, { remoteAccess: REPORT });
    await reportedAgo(runnerId, REMOTE_ACCESS_STALE_AFTER_MS - 5_000);
    expect((await status()).stale).toBe(false);
    await reportedAgo(runnerId, REMOTE_ACCESS_STALE_AFTER_MS + 5_000);
    expect(await status()).toMatchObject({ stale: true, report: REPORT });
  });

  it("uses the newest report across runners", async () => {
    const older = await pair("older");
    const newer = await pair("newer");
    await beat(newer.token, { remoteAccess: { ...REPORT, funnel: true } });
    await beat(older.token, { remoteAccess: REPORT });
    await reportedAgo(older.runnerId, 120_000);
    expect(await status()).toMatchObject({ runnerName: "newer", report: { funnel: true } });
  });

  it("ignores a revoked runner, however recent its report", async () => {
    const kept = await pair("kept");
    const revoked = await pair("revoked");
    await beat(kept.token, { remoteAccess: REPORT });
    await reportedAgo(kept.runnerId, 120_000);
    await beat(revoked.token, { remoteAccess: { ...REPORT, funnel: true } });
    expect((await status()).runnerName).toBe("revoked");

    await asOwner("POST", `/v1/runners/${revoked.runnerId}/revoke`);
    expect(await status()).toMatchObject({ runnerName: "kept", report: REPORT });

    await asOwner("POST", `/v1/runners/${kept.runnerId}/revoke`);
    expect(await status()).toMatchObject({ runnerName: null, report: null, stale: false });
  });

  it("refuses a heartbeat whose report has fields beyond the contract, such as an address", async () => {
    const { token } = await pair("home");
    const bad = { ...REPORT, devices: [{ ...REPORT.devices[0], tailscaleIp: "100.101.102.103" }] };
    expect((await beat(token, { remoteAccess: bad })).statusCode).toBe(400);
    expect((await status()).report).toBeNull();
  });
});
