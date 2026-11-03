import { setTimeout as sleep } from "node:timers/promises";
import type { SkipReason } from "@nexus/contracts";
import { guardedAgent, isBlockedHostError, type GuardOptions } from "../net-guard.ts";

// FR-RES-12 / RES-G04: public https sources only, robots.txt honoured, no credentials, no bypass, no retries. Every
// connection (robots.txt, the page, each redirect hop) goes through the net-guard dispatcher: one resolve, every
// address vetted, the socket dialled to the vetted address.
export const USER_AGENT = "NEXUS-Research/1.0 (self-hosted research digest; honours robots.txt)";
const ROBOTS_TOKEN = "nexus-research"; // the product token robots.txt groups are matched against
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
export const HOST_INTERVAL_MS = 1_000;
const FEED_ACCEPT = "application/atom+xml, application/rss+xml, */*;q=0.5";

export type Skip = { ok: false; reason: SkipReason; detail: string };
/** `contentType` is the response's media type without parameters, lower case ("" when the server sent none). */
export type Fetched = { ok: true; body: string; url: URL; contentType: string } | Skip;
export type Limiter = (host: string, signal: AbortSignal) => Promise<void>;
export type FetchSession = ReturnType<typeof fetchSession>;

const skip = (reason: SkipReason, detail: string): Skip => ({
  ok: false,
  reason,
  detail: detail.slice(0, 300),
});

/** Per-process request spacing per host. The slot is reserved synchronously, so concurrent callers queue up. */
export function hostLimiter(intervalMs = HOST_INTERVAL_MS): Limiter {
  const next = new Map<string, number>();
  return async (host, signal) => {
    const now = Date.now();
    const at = Math.max(now, next.get(host) ?? 0);
    next.set(host, at + intervalMs);
    if (at > now) await sleep(at - now, undefined, { signal });
  };
}

/** robots.txt (RFC 9309): our group if one names us, else `*`; longest matching rule wins, allow wins ties. */
export function parseRobots(txt: string): (path: string) => boolean {
  type Group = { agents: string[]; rules: [allow: boolean, pattern: string][] };
  const groups: Group[] = [];
  let group: Group | undefined;
  let inAgents = false;
  for (const raw of txt.split(/\r\n|\r|\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(raw.replace(/#.*/, ""));
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    if (key === "user-agent") {
      if (!inAgents || !group) groups.push((group = { agents: [], rules: [] }));
      group.agents.push(m[2]!.toLowerCase());
      inAgents = true;
    } else {
      inAgents = false;
      if ((key === "allow" || key === "disallow") && group && m[2]) group.rules.push([key === "allow", m[2]]);
    }
  }
  const pick = (agent: string) => groups.filter((g) => g.agents.includes(agent));
  const own = pick(ROBOTS_TOKEN);
  const rules = (own.length ? own : pick("*")).flatMap((g) => g.rules);
  return (path) => {
    let best: [allow: boolean, length: number] = [true, -1];
    for (const [allow, pattern] of rules)
      if (wildcardMatch(pattern, path) && (pattern.length > best[1] || (pattern.length === best[1] && allow)))
        best = [allow, pattern.length];
    return best[0];
  };
}

// `*` = any run of characters, a trailing `$` anchors the end, otherwise a prefix match. Linear-time two-pointer
// matcher: a hostile robots.txt can't make a regex backtrack.
function wildcardMatch(pattern: string, path: string) {
  const p = pattern.endsWith("$") ? pattern.slice(0, -1) : `${pattern}*`;
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < path.length) {
    if (i < p.length && p[i] !== "*" && p[i] === path[j]) {
      i++;
      j++;
    } else if (i < p.length && p[i] === "*") {
      star = i++;
      mark = j;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (p[i] === "*") i++;
  return i === p.length;
}

const BOMS: [bytes: number[], label: string][] = [
  [[0xef, 0xbb, 0xbf], "utf-8"],
  [[0xfe, 0xff], "utf-16be"],
  [[0xff, 0xfe], "utf-16le"],
];

/**
 * Text encoding per WHATWG order, simplified: a byte-order mark, then the Content-Type charset, then a `<meta>`
 * charset or XML encoding declaration in the first 1 KiB, else UTF-8. Unknown labels fall back to UTF-8.
 */
export function decodeBody(bytes: Uint8Array, contentTypeHeader: string | null): string {
  const bom = BOMS.find(([b]) => b.every((x, i) => bytes[i] === x))?.[1];
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  const label =
    bom ??
    /;\s*charset\s*=\s*"?([\w.:-]+)/i.exec(contentTypeHeader ?? "")?.[1] ??
    /<meta[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1] ??
    /^\s*<\?xml[^>]*?encoding\s*=\s*["']([\w.:-]+)/i.exec(head)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes); // RangeError: a label TextDecoder doesn't know
  }
}

/**
 * One run's fetch session: robots.txt is read before a host's first fetch and cached for the run, then every request
 * goes through the policy. `signal` aborts everything (API shutdown). `opts` are net-guard test seams only.
 */
export function fetchSession(wait: Limiter, signal: AbortSignal, opts: GuardOptions = {}) {
  const robots = new Map<string, Promise<((path: string) => boolean) | Skip>>();
  const dispatcher = guardedAgent({ ...opts, connectTimeoutMs: TIMEOUT_MS });

  async function request(start: URL, checkRobots: boolean, accept = FEED_ACCEPT): Promise<Fetched> {
    let url = start;
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "https:") return skip("HTTP_ERROR", `Refused a non-https URL (${url.protocol})`);
      if (url.username || url.password) return skip("HTTP_ERROR", "Refused a URL with credentials");
      if (checkRobots) {
        const allows = await robotsFor(url);
        if (typeof allows !== "function") return allows;
        if (!allows(url.pathname + url.search))
          return skip("ROBOTS_DISALLOWED", `robots.txt on ${url.host} disallows ${url.pathname}`);
      }
      await wait(url.host, signal);
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
      try {
        const res = await fetch(url, {
          redirect: "manual",
          credentials: "omit",
          headers: { "user-agent": USER_AGENT, accept },
          signal: timeout,
          dispatcher,
        });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel();
          if (hop >= MAX_REDIRECTS) return skip("HTTP_ERROR", "Too many redirects");
          url = new URL(location, url);
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel();
          if (res.status === 401 || res.status === 403)
            return skip("AUTH_REQUIRED", `HTTP ${res.status}: the source requires access NEXUS doesn't have`);
          if (res.status === 429)
            return skip("RATE_LIMITED", "HTTP 429: the source asked NEXUS to slow down");
          return skip("HTTP_ERROR", `HTTP ${res.status}`);
        }
        if (Number(res.headers.get("content-length")) > MAX_BYTES) {
          await res.body?.cancel();
          return skip("TOO_LARGE", "Larger than 2 MB");
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of res.body ?? []) {
          size += chunk.byteLength;
          if (size > MAX_BYTES) return skip("TOO_LARGE", "Larger than 2 MB"); // leaving the loop cancels the body
          chunks.push(chunk);
        }
        const header = res.headers.get("content-type");
        return {
          ok: true,
          body: decodeBody(Buffer.concat(chunks), header),
          url,
          contentType: (header ?? "").split(";")[0]!.trim().toLowerCase(),
        };
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof Error && err.name === "TimeoutError")
          return skip("TIMEOUT", "No response within 10 s");
        if (err instanceof Error && isBlockedHostError(err.cause))
          return skip("BLOCKED_HOST", `Refused: ${err.cause.message}`);
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
        return skip("HTTP_ERROR", `Network error${cause ? `: ${cause}` : ""}`);
      }
    }
  }

  function robotsFor(url: URL) {
    let entry = robots.get(url.host);
    if (!entry) {
      entry = request(new URL("/robots.txt", url.origin), false).then((r) => {
        if (r.ok) return parseRobots(r.body);
        if (r.reason === "BLOCKED_HOST") return r;
        // RFC 9309: an unavailable robots.txt (4xx) allows everything; an unreachable one (5xx, network) disallows.
        if (r.reason === "AUTH_REQUIRED" || /^HTTP 4\d\d$/.test(r.detail)) return () => true;
        return skip("ROBOTS_DISALLOWED", `robots.txt on ${url.host} is unreachable (${r.detail})`);
      });
      robots.set(url.host, entry);
    }
    return entry;
  }

  return { get: (url: URL, accept?: string) => request(url, true, accept) };
}
