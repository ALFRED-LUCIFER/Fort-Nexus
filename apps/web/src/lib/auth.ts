import { createAuthClient } from "better-auth/react";
import { UNREACHABLE } from "./api.ts";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  // Resolve fetch per call (better-auth captures it at creation), so tests can stub it.
  fetchOptions: { customFetchImpl: (input, init) => fetch(input, init) },
});

/** Signs in with email + password. Resolves to an owner-facing error message, or null on success. */
export async function signIn(email: string, password: string): Promise<string | null> {
  try {
    const { error } = await authClient.signIn.email({ email, password });
    if (!error) return null;
    if (error.status === 401 || error.status === 403)
      return "That email and password don't match. Try again.";
    if (error.status === 429) return "Too many sign-in attempts. Wait a minute, then try again.";
    if (error.status >= 500) return UNREACHABLE;
    return error.message || `Sign-in failed (HTTP ${error.status}).`;
  } catch {
    return UNREACHABLE;
  }
}
