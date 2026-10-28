import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH_NOT_OWNER, GITHUB_SETUP_COMMAND } from "@nexus/contracts";
import {
  createTestApp,
  githubSignIn,
  githubUser,
  ownerSession,
  type TestApp,
} from "./helpers/owner-session.ts";

let t: TestApp;
let sql: pg.Pool;
const count = async (table: string) =>
  (await sql.query(`select count(*)::int as n from "${table}"`)).rows[0].n as number;

beforeAll(async () => {
  t = await createTestApp();
  sql = new pg.Pool({ connectionString: t.databaseUrl });
});

afterAll(async () => {
  await t?.app.close();
  await sql?.end();
});

describe("Sign in with GitHub", () => {
  it("signs the owner in, keeps no GitHub tokens, and reuses the user on the next sign-in", async () => {
    const cookie = await ownerSession(t);
    const me = await t.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: `${t.githubApp!.ownerGithubLogin}@example.com` });

    const accountRows = async () => (await sql.query(`select * from account`)).rows;
    const ownerAccount = expect.objectContaining({
      provider_id: "github",
      account_id: String(t.githubApp!.ownerGithubUserId),
      access_token: null,
      refresh_token: null,
      id_token: null,
      password: null,
    });
    expect(await accountRows()).toEqual([ownerAccount]);

    await ownerSession(t); // sign-in update path
    expect(await count("user")).toBe(1);
    expect(await accountRows()).toEqual([ownerAccount]);
  });

  it("denies any other GitHub account: no user, account or session, and an auth.denied audit record", async () => {
    const before = {
      user: await count("user"),
      account: await count("account"),
      session: await count("session"),
    };
    const intruder = githubUser({ login: "not-the-owner" });
    const res = await githubSignIn(t, intruder);

    expect(res.statusCode).toBe(302);
    const location = new URL(res.location);
    expect(location.origin + location.pathname).toBe(`${t.config.publicOrigin}/login`);
    expect(location.searchParams.get("error")).toBe(AUTH_NOT_OWNER);
    expect(res.cookie).not.toMatch(/session_token=/);
    expect({
      user: await count("user"),
      account: await count("account"),
      session: await count("session"),
    }).toEqual(before);

    const audit = await sql.query(`select * from audit_records where action = 'auth.denied'`);
    expect(audit.rows).toEqual([
      expect.objectContaining({
        actor: "github:not-the-owner",
        resource_type: "github_account",
        resource_id: String(intruder.id),
        outcome: "DENIED",
      }),
    ]);
    expect(audit.rows[0].correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(audit.rows[0])).not.toMatch(/token|secret/i);
  });

  it("denies a non-owner even when it uses the owner's email address", async () => {
    const res = await githubSignIn(t, githubUser({ email: `${t.githubApp!.ownerGithubLogin}@example.com` }));
    expect(new URL(res.location).searchParams.get("error")).toBe(AUTH_NOT_OWNER);
    expect(await count("account")).toBe(1);
  });

  it("has no password sign-in or sign-up", async () => {
    for (const url of ["/api/auth/sign-in/email", "/api/auth/sign-up/email"]) {
      const res = await t.app.inject({
        method: "POST",
        url,
        headers: { origin: t.config.publicOrigin },
        payload: { email: "owner@example.com", password: "a long enough password", name: "x" },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.headers["set-cookie"] ?? "").not.toMatch(/session_token=/);
    }
  });

  it("reports the configured owner login and nothing else", async () => {
    const res = await t.app.inject({ method: "GET", url: "/v1/auth/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ github: { configured: true, ownerLogin: t.githubApp!.ownerGithubLogin } });
  });
});

describe("without a GitHub App", () => {
  let bare: TestApp;
  beforeAll(async () => {
    bare = await createTestApp({}, { github: false });
  });
  afterAll(async () => {
    await bare?.app.close();
  });

  it("starts, reports github unconfigured and explains how to set it up", async () => {
    const status = await bare.app.inject({ method: "GET", url: "/v1/auth/status" });
    expect(status.json()).toEqual({ github: { configured: false } });

    const res = await bare.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/social",
      headers: { origin: bare.config.publicOrigin },
      payload: { provider: "github", callbackURL: "/" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toContain(GITHUB_SETUP_COMMAND);
  });
});
