import { z } from "zod";

/** `GET /v1/auth/status` (public): what the login page needs before anyone is signed in. Never ids or secrets. */
export const AuthStatus = z.object({
  github: z.object({ configured: z.boolean(), ownerLogin: z.string().optional() }),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

/** The command that creates the NEXUS GitHub App; shown wherever sign-in isn't set up yet. */
export const GITHUB_SETUP_COMMAND = "pnpm --filter @nexus/api github:setup";

/** `?error=` code on the `/login` redirect when a GitHub account other than the owner tries to sign in. */
export const AUTH_NOT_OWNER = "not_owner";
