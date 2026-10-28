import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { AUTH_NOT_OWNER } from "@nexus/contracts";
import { audit } from "./audit.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";
import { account, session, user, verification } from "./db/schema.ts";
import type { GithubAppConfig } from "./github/app-config.ts";

// NEXUS never calls GitHub as the user (repo access uses installation tokens), so user OAuth tokens are dropped
// before they reach the database.
const dropOAuthTokens = async () => ({
  data: {
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  },
});

/**
 * Sign-in is "Sign in with GitHub" through the NEXUS GitHub App's OAuth client only; GitHub's own 2FA is the
 * MFA (FR-ACC-04). Without an app config the API still runs, but no one can sign in.
 */
export function createAuth(config: Config, db: Db, github: GithubAppConfig | null) {
  return betterAuth({
    appName: "NEXUS",
    baseURL: config.publicOrigin,
    basePath: "/api/auth",
    secret: config.authSecret,
    trustedOrigins: config.trustedOrigins,
    database: drizzleAdapter(db, { provider: "pg", schema: { user, session, account, verification } }),
    socialProviders: github
      ? { github: { clientId: github.clientId, clientSecret: github.clientSecret } }
      : {},
    user: {
      // Single owner: Better Auth calls this before it creates a user, links an account or signs in an existing
      // OAuth user, and fails closed. Anyone but the app's creator gets no user, account or session.
      // shortcut: sessions issued before the app was re-created for another owner stay valid until they expire or
      // sign out; revoke them on owner change once session management (FR-ACC-04 list/revoke) lands.
      validateUserInfo: async ({ source }, ctx) => {
        const profile = source.oauth?.profile;
        if (github && source.oauth?.providerId === "github" && profile?.id === github.ownerGithubUserId)
          return;
        await audit(db, {
          actor: `github:${String(profile?.login ?? "unknown").slice(0, 100)}`,
          action: "auth.denied",
          resourceType: "github_account",
          resourceId: String(profile?.id ?? "unknown"),
          correlationId: ctx?.request?.headers.get("x-request-id") ?? randomUUID(),
          outcome: "DENIED",
          metadata: { stage: source.action, provider: source.oauth?.providerId ?? source.method },
        });
        return {
          error: AUTH_NOT_OWNER,
          errorDescription: "This GitHub account isn't the owner of this NEXUS.",
        };
      },
    },
    databaseHooks: { account: { create: { before: dropOAuthTokens }, update: { before: dropOAuthTokens } } },
    // OAuth failures (denied owner, cancelled consent, expired state) land on the SPA login page with ?error=<code>.
    onAPIError: { errorURL: `${config.publicOrigin}/login` },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
