import { createAuthClient } from "better-auth/react";
import { AUTH_NOT_OWNER, ApiError, AuthStatus } from "@nexus/contracts";
import { ApiRequestError, UNREACHABLE } from "./api.ts";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  // Resolve fetch per call (better-auth captures it at creation), so tests can stub it.
  fetchOptions: { customFetchImpl: (input, init) => fetch(input, init) },
});

export const RATE_LIMITED = "Too many sign-in attempts. Wait a minute, then try again.";
export const NOT_OWNER_MESSAGE = "This GitHub account isn't the owner of this NEXUS.";

/** Public: whether GitHub sign-in is set up and for whom. Throws ApiRequestError with an owner-facing message. */
export async function fetchAuthStatus(): Promise<AuthStatus> {
  let res: Response;
  try {
    res = await fetch("/v1/auth/status", { credentials: "same-origin" });
  } catch {
    throw new ApiRequestError(UNREACHABLE, 0, "UNREACHABLE");
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 429) throw new ApiRequestError(RATE_LIMITED, 429, "RATE_LIMITED");
  const status = AuthStatus.safeParse(body);
  if (res.ok && status.success) return status.data;
  const err = ApiError.safeParse(body);
  // The dev proxy answers 5xx without an ApiError body when the API is down.
  throw new ApiRequestError(err.success ? err.data.error.message : UNREACHABLE, res.status, "HTTP");
}

/** Starts "Sign in with GitHub"; on success the browser leaves for GitHub. Resolves to an owner-facing error or null. */
export async function signInWithGithub(): Promise<string | null> {
  try {
    const { error } = await authClient.signIn.social({ provider: "github", callbackURL: "/" });
    if (!error) return null;
    if (error.status === 429) return RATE_LIMITED;
    if (error.status >= 500) return UNREACHABLE;
    return error.message || `Sign-in failed (HTTP ${error.status}).`;
  } catch {
    return UNREACHABLE;
  }
}

/** Message for the `?error=` code Better Auth puts on the redirect back to /login. */
export function callbackErrorMessage(code: string): string {
  if (code === AUTH_NOT_OWNER) return NOT_OWNER_MESSAGE;
  if (code === "access_denied") return "GitHub sign-in was cancelled.";
  return `GitHub sign-in didn't complete (${code}). Try again.`;
}
