import type { OwnerSession } from "@nexus/contracts";
import { audit } from "./audit.ts";
import type { Auth } from "./auth.ts";
import type { Db } from "./db/index.ts";
import { notFound } from "./errors.ts";
import { ownerActor } from "./jobs.ts";

// FR-ACC-04 / SEC-G02: the owner's browser sessions, through Better Auth's own session store. Its
// /list-sessions endpoint demands a session younger than a day, so the internal adapter is used instead.

const active = async (auth: Auth, userId: string) => {
  const now = new Date();
  const ctx = await auth.$context;
  return (await ctx.internalAdapter.listSessions(userId, { onlyActiveSessions: true })).filter(
    (s) => new Date(s.expiresAt) > now,
  );
};

export async function listOwnerSessions(
  auth: Auth,
  userId: string,
  currentSessionId: string,
): Promise<OwnerSession[]> {
  return (await active(auth, userId))
    .map((s) => ({
      id: s.id,
      createdAt: new Date(s.createdAt).toISOString(),
      expiresAt: new Date(s.expiresAt).toISOString(),
      userAgent: s.userAgent ?? null,
      ipAddress: s.ipAddress ?? null,
      current: s.id === currentSessionId,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Revokes one of the owner's sessions; the current one is signed out properly, so the returned Set-Cookie
 * headers clear this browser's cookies. Session tokens never leave the server.
 */
export async function revokeOwnerSession(
  db: Db,
  auth: Auth,
  input: {
    userId: string;
    sessionId: string;
    currentSessionId: string;
    headers: Headers;
    correlationId: string;
  },
): Promise<string[]> {
  const target = (await active(auth, input.userId)).find((s) => s.id === input.sessionId);
  if (!target) throw notFound("Session");
  const current = target.id === input.currentSessionId;
  let cookies: string[] = [];
  if (current) {
    const res = await auth.api.signOut({ headers: input.headers, returnHeaders: true });
    cookies = res.headers.getSetCookie();
  } else await (await auth.$context).internalAdapter.deleteSession(target.token);
  await audit(db, {
    actor: ownerActor(input.userId),
    action: "session.revoke",
    resourceType: "session",
    resourceId: target.id,
    correlationId: input.correlationId,
    metadata: { current },
  });
  return cookies;
}
