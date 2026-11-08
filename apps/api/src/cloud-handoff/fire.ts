import { z } from "zod";
import { FIRE_URL, type CloudRoutine } from "./routine-config.ts";

// The routine fire call (https://platform.claude.com/docs/en/api/claude-code/routines-fire, checked 2026-11-08).
// The endpoint has no idempotency key: every successful call is a new session, so this client never retries. It
// never throws for an upstream outcome, and nothing it returns carries the token or Anthropic's response body.

export const FIRE_TIMEOUT_MS = 20_000;
const ANTHROPIC_VERSION = "2026-10-21";
const ANTHROPIC_BETA = "experimental-cc-routine-2026-04-01";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_S = 24 * 3600;

const SessionUrl = z
  .string()
  .max(2048)
  .refine((raw) => {
    if (!URL.canParse(raw)) return false;
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "claude.ai" && !u.username && !u.password && !u.port;
  });
const FireResponse = z.object({
  type: z.literal("routine_fire"),
  claude_code_session_id: z.string().regex(/^[\x21-\x7e]{1,200}$/),
  claude_code_session_url: SessionUrl,
});

export type FireResult =
  | { kind: "started"; sessionId: string; sessionUrl: string }
  /** 400 / 401 / 403 / 404: Anthropic refused it; no session exists. */
  | { kind: "refused"; status: 400 | 401 | 403 | 404 }
  /** 429: the hourly fire limit; no session exists. */
  | { kind: "rateLimited"; retryAfterSeconds: number | null }
  /** A session may or may not exist. `status` is the HTTP status when there was one. */
  | { kind: "unknown"; reason: "timeout" | "network" | "status" | "body"; status: number | null };

/** Retry-After as seconds: delta-seconds or an HTTP-date (RFC 9110 §10.2.3); null when absent or unreadable. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | null {
  const v = header?.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Math.min(Number(v), MAX_RETRY_AFTER_S);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, Math.ceil((at - now) / 1000)), MAX_RETRY_AFTER_S);
}

/** The body as text, capped; null when it is larger or can't be read. */
async function readCapped(res: Response): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of res.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) return null;
      chunks.push(chunk);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

const discard = (res: Response) => res.body?.cancel().catch(() => undefined);

/** Fires `routine` once with `text`. `timeoutMs` is a test seam. */
export async function fireRoutine(
  routine: Pick<CloudRoutine, "fireUrl" | "token">,
  text: string,
  { timeoutMs = FIRE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<FireResult> {
  // routine-config.ts already checked it; the token must never go anywhere else, so check again right here.
  if (!FIRE_URL.test(routine.fireUrl))
    throw new Error("refusing to send a routine token to an unexpected URL");
  let res: Response;
  try {
    res = await fetch(routine.fireUrl, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: {
        authorization: `Bearer ${routine.token}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_BETA,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // The cause may echo request details: only its kind is kept.
    const name = err instanceof Error ? err.name : "";
    return {
      kind: "unknown",
      reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
      status: null,
    };
  }
  const status = res.status;
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    await discard(res);
    return { kind: "refused", status };
  }
  if (status === 429) {
    await discard(res);
    return { kind: "rateLimited", retryAfterSeconds: retryAfterSeconds(res.headers.get("retry-after")) };
  }
  if (status !== 200) {
    // 5xx, or anything the reference doesn't list: Anthropic may still have started a session.
    await discard(res);
    return { kind: "unknown", reason: "status", status };
  }
  const body = await readCapped(res);
  let raw: unknown = null;
  try {
    raw = body === null ? null : JSON.parse(body);
  } catch {
    raw = null;
  }
  const parsed = FireResponse.safeParse(raw);
  if (!parsed.success) return { kind: "unknown", reason: "body", status };
  return {
    kind: "started",
    sessionId: parsed.data.claude_code_session_id,
    sessionUrl: parsed.data.claude_code_session_url,
  };
}
