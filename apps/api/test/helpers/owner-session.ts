// Test helpers for a real API instance and real Better Auth sessions.
//   const t = await createTestApp();          // fresh database + NEXUS GitHub App config + built app
//   const cookie = await ownerSession(t);      // Cookie header of the signed-in owner, for app.inject
//   await githubSignIn(t, githubUser({ id: 7 })); // any GitHub account through the real OAuth callback
// GitHub's HTTP endpoints are stubbed for the duration of a sign-in; everything else is production code.
import { generateKeyPairSync, randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { expect, inject, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import type { GithubAppConfig } from "../../src/github/app-config.ts";

export type TestApp = {
  app: FastifyInstance;
  config: Config;
  /** null when created with `{ github: false }` (sign-in not set up). */
  githubApp: GithubAppConfig | null;
  databaseUrl: string;
};

export type GithubUser = { id: number; login: string; email: string; name: string };

export const githubUser = (over: Partial<GithubUser> = {}): GithubUser => {
  const login = over.login ?? `user-${randomBytes(3).toString("hex")}`;
  return { id: randomInt(1, 2 ** 31), login, email: `${login}@example.com`, name: login, ...over };
};

export async function freshDatabaseUrl() {
  const admin = inject("pgAdminUrl");
  const name = `t_${randomUUID().replaceAll("-", "")}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`create database ${name}`);
  await c.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return url.toString();
}

/** A throwaway app config; every secret is generated at runtime. */
export const testGithubApp = (owner: GithubUser = githubUser({ login: "nexus-owner" })): GithubAppConfig => ({
  appId: randomInt(1, 2 ** 31),
  slug: "nexus-test",
  htmlUrl: "https://github.com/apps/nexus-test",
  clientId: `Iv1.${randomBytes(8).toString("hex")}`,
  clientSecret: randomBytes(20).toString("hex"),
  privateKey: generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey,
  webhookSecret: randomBytes(32).toString("base64url"),
  ownerGithubUserId: owner.id,
  ownerGithubLogin: owner.login,
});

/** Builds the API on a fresh database. `env` overrides config; `github: false` leaves sign-in unconfigured. */
export async function createTestApp(
  env: Record<string, string> = {},
  { github = true }: { github?: boolean } = {},
): Promise<TestApp> {
  const databaseUrl = await freshDatabaseUrl();
  const dir = mkdtempSync(join(tmpdir(), "nexus-test-"));
  const githubApp = github ? testGithubApp() : null;
  const file = join(dir, "github-app.json");
  if (githubApp) writeFileSync(file, JSON.stringify(githubApp), { mode: 0o600 });
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    GITHUB_APP_FILE: file,
    ...env,
  });
  try {
    const app = await buildApp(config);
    await app.ready();
    return { app, config, githubApp, databaseUrl };
  } finally {
    rmSync(dir, { recursive: true, force: true }); // read once at startup
  }
}

const cookieHeader = (setCookie: string | string[] | undefined) =>
  [setCookie ?? []]
    .flat()
    .map((c) => c.split(";", 1)[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");

/**
 * Runs "Sign in with GitHub" as `user`: Better Auth's /sign-in/social, then its /callback/github with GitHub's
 * token and user endpoints stubbed. Returns the callback response; `cookie` is empty when no session was issued.
 */
export async function githubSignIn(t: TestApp, user: GithubUser) {
  const start = await t.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/social",
    headers: { origin: t.config.publicOrigin },
    payload: { provider: "github", callbackURL: "/" },
  });
  expect(start.statusCode, start.body).toBe(200);
  const state = new URL(start.json<{ url: string }>().url).searchParams.get("state")!;

  const github = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://github.com/login/oauth/access_token")
      return Response.json({
        access_token: randomBytes(20).toString("hex"),
        token_type: "bearer",
        scope: "",
      });
    if (url === "https://api.github.com/user")
      return Response.json({ id: user.id, login: user.login, name: user.name, email: user.email });
    if (url === "https://api.github.com/user/emails")
      return Response.json([{ email: user.email, primary: true, verified: true }]);
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  try {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/auth/callback/github?${new URLSearchParams({ code: randomUUID(), state })}`,
      headers: { cookie: cookieHeader(start.headers["set-cookie"]) },
    });
    return {
      statusCode: res.statusCode,
      location: String(res.headers.location ?? ""),
      cookie: cookieHeader(res.headers["set-cookie"]),
    };
  } finally {
    github.mockRestore();
  }
}

/** Signs in as the app's owner and returns the Cookie header value for `app.inject`. */
export async function ownerSession(t: TestApp): Promise<string> {
  if (!t.githubApp) throw new Error("ownerSession needs a test app with GitHub configured");
  const res = await githubSignIn(
    t,
    githubUser({ id: t.githubApp.ownerGithubUserId, login: t.githubApp.ownerGithubLogin, name: "Owner" }),
  );
  expect(res.statusCode).toBe(302);
  expect(res.cookie).toMatch(/session_token=/);
  return res.cookie;
}
