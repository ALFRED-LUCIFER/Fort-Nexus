import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";
import { account, session, user, verification } from "./db/schema.ts";

export const MIN_PASSWORD_LENGTH = 12;

export function createAuth(config: Config, db: Db) {
  return betterAuth({
    appName: "NEXUS",
    baseURL: config.publicOrigin,
    basePath: "/api/auth",
    secret: config.authSecret,
    trustedOrigins: config.trustedOrigins,
    database: drizzleAdapter(db, { provider: "pg", schema: { user, session, account, verification } }),
    // shortcut: password only; passkeys/TOTP MFA (FR-ACC-04, Part A) come with the Better Auth passkey plugin.
    // Single owner: accounts are created only by the create-owner CLI.
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: MIN_PASSWORD_LENGTH },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Creates the single owner account. Refuses if any user exists (NEXUS is single-owner). */
export async function createOwner(
  auth: Auth,
  db: Db,
  input: { email: string; name: string; password: string },
) {
  if (input.password.length < MIN_PASSWORD_LENGTH)
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const existing = await db.select({ id: user.id }).from(user).limit(1);
  if (existing.length > 0) throw new Error("An owner account already exists");
  const ctx = await auth.$context;
  const created = await ctx.internalAdapter.createUser(
    {
      email: input.email.toLowerCase(),
      name: input.name,
      emailVerified: true,
    },
    { method: "admin" },
  );
  try {
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: "credential",
      accountId: created.id,
      password: await ctx.password.hash(input.password),
    });
  } catch (err) {
    // Don't leave a password-less owner behind that would block a retry.
    await db.delete(user).where(eq(user.id, created.id));
    throw err;
  }
  return { id: created.id, email: created.email };
}
