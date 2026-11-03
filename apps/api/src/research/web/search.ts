import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { SearchProviderStatus } from "@nexus/contracts";
import { HttpError } from "../../errors.ts";
import { guardedAgent, type GuardOptions } from "../../net-guard.ts";
import { plainText } from "../feed.ts";
import { USER_AGENT, hostLimiter } from "../fetch.ts";

// FR-RES-03: web search through the Brave Search API, called and audited by NEXUS itself (owner decision
// 2026-11-03). The key lives in ~/.nexus/search.json, is read per call (rotation needs no restart) and is never
// logged, returned or put in an error. Results are untrusted data.

export const SEARCH_RUNBOOK = "docs/runbooks/web-search.md";
// https://api-dashboard.search.brave.com/api-reference/web/search/get (checked 2026-11-03).
const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const TIMEOUT_MS = 10_000;
const INTERVAL_MS = 1_000;
const MAX_COUNT = 20; // Brave's documented maximum per request
// Well inside Brave's documented query limit (600 characters, 75 words).
const MAX_QUERY = 400;
const MAX_WORDS = 50;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type SearchResult = { title: string; url: URL; snippet: string; publishedAt: Date | null };
export type SearchClient = {
  provider: "brave";
  search(query: string, opts: { count: number; signal: AbortSignal }): Promise<SearchResult[]>;
};

/** A search that didn't produce results. `message` is owner-safe: never the key, a provider body or a stack. */
export class SearchError extends Error {
  readonly kind: "AUTH" | "RATE_LIMITED" | "UNAVAILABLE";
  constructor(kind: SearchError["kind"], message: string) {
    super(message);
    this.name = "SearchError";
    this.kind = kind;
  }
}

// Printable ASCII without spaces: it goes into a header, so nothing that could split one.
const SearchConfig = z.strictObject({
  provider: z.literal("brave"),
  apiKey: z.string().regex(/^[\x21-\x7e]{16,256}$/),
});

// Only the fields NEXUS uses; anything else in Brave's response is ignored.
const BraveResult = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string().optional(),
  page_age: z.string().optional(),
});
const BraveResponse = z.object({
  web: z.object({ results: z.array(z.unknown()) }).optional(),
});
const BraveError = z.object({ error: z.object({ code: z.string().optional() }) });

/**
 * Reads and checks the search config on every call. Missing or unusable → 409 naming the file and runbook; messages
 * never include the file's content.
 */
// shortcut: repeats loadAi's file checks (ai.ts); fold both into one helper when a third provider file appears.
export async function loadSearch(file: string): Promise<SearchClient> {
  const fail = (
    reason: "search_provider_not_configured" | "search_provider_config_invalid",
    message: string,
  ) => new HttpError(409, "CONFLICT", message, { reason, file, runbook: SEARCH_RUNBOOK });
  const invalid = (why: string) =>
    fail("search_provider_config_invalid", `${file} ${why}. See ${SEARCH_RUNBOOK} on the home machine.`);

  const st = await stat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT")
      throw fail(
        "search_provider_not_configured",
        `Web search isn't set up. On the home machine create ${file} with mode 0600 (see ${SEARCH_RUNBOOK}), then try again.`,
      );
    throw invalid(`could not be read (${err.code ?? "error"})`);
  });
  if (!st.isFile()) throw invalid("is not a regular file");
  if ((st.mode & 0o077) !== 0) throw invalid("must not be readable by group or others: run chmod 600");
  if (process.getuid && st.uid !== process.getuid()) throw invalid("must be owned by the API user");

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw invalid("is not valid JSON"); // JSON.parse messages quote the input: never pass them on
  }
  const parsed = SearchConfig.safeParse(raw);
  if (!parsed.success)
    throw invalid(
      `is invalid (${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`).join("; ")})`,
    );
  return braveClient(parsed.data.apiKey);
}

/** GET /v1/research/search-provider: whether search.json is usable, never the key. */
export async function searchProviderStatus(file: string): Promise<SearchProviderStatus> {
  try {
    const client = await loadSearch(file);
    return { configured: true, provider: client.provider };
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 409)
      return { configured: false, reason: err.message, runbook: SEARCH_RUNBOOK };
    throw err;
  }
}

/** Brave's page_age is an ISO date-time, usually without an offset (UTC). Anything else is unknown. */
function publishedAt(v: string | undefined): Date | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) return null;
  const d = new Date(/T[\d:.]+$/.test(v) ? `${v}Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toResult(raw: unknown): SearchResult | null {
  const r = BraveResult.safeParse(raw);
  if (!r.success || !URL.canParse(r.data.url)) return null;
  const url = new URL(r.data.url);
  if (url.protocol !== "https:" || url.username || url.password) return null; // FR-RES-12: https sources only
  return {
    title: plainText(r.data.title, 300) || url.hostname,
    url,
    snippet: plainText(r.data.description ?? "", 1000),
    publishedAt: publishedAt(r.data.page_age),
  };
}

/** The body as text, capped (a provider can't make NEXUS buffer an unbounded response). */
async function readCapped(res: Response): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const json = (text: string | null): unknown => {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
};

const unavailable = () =>
  new SearchError(
    "UNAVAILABLE",
    "Brave Search couldn't be reached or answered unexpectedly. Try again shortly.",
  );

/**
 * A Brave Search client: 1 request/s, 10 s timeout, the net-guard dispatcher, no redirects, https results only.
 * `opts` are net-guard test seams only.
 */
export function braveClient(apiKey: string, opts: GuardOptions = {}): SearchClient {
  const wait = hostLimiter(INTERVAL_MS);
  const dispatcher = guardedAgent({ ...opts, connectTimeoutMs: TIMEOUT_MS });
  return {
    provider: "brave",
    async search(query, { count, signal }) {
      const q = query.trim().split(/\s+/).slice(0, MAX_WORDS).join(" ").slice(0, MAX_QUERY);
      if (!q) return [];
      const n = Math.min(Math.max(Math.trunc(count), 1), MAX_COUNT);
      await wait("brave", signal);
      const url = new URL(ENDPOINT);
      url.search = new URLSearchParams({ q, count: String(n), text_decorations: "false" }).toString();
      let res: Response;
      try {
        res = await fetch(url, {
          redirect: "manual",
          credentials: "omit",
          headers: { accept: "application/json", "user-agent": USER_AGENT, "x-subscription-token": apiKey },
          signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
          dispatcher,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        throw unavailable(); // network, TLS, timeout: the cause may echo request details, so it isn't passed on
      }
      const body = await readCapped(res).catch(() => null);
      if (res.status === 401 || res.status === 403)
        throw new SearchError(
          "AUTH",
          "Brave Search rejected NEXUS's key. Check ~/.nexus/search.json on the home machine.",
        );
      if (res.status === 429)
        throw new SearchError(
          "RATE_LIMITED",
          "Brave Search is rate limiting NEXUS or the plan's quota is used up. Try again later.",
        );
      if (
        res.status === 422 &&
        /TOKEN|SUBSCRIPTION/i.test(BraveError.safeParse(json(body)).data?.error.code ?? "")
      )
        throw new SearchError(
          "AUTH",
          "Brave Search rejected NEXUS's key. Check ~/.nexus/search.json on the home machine.",
        );
      if (!res.ok) throw unavailable();
      const parsed = BraveResponse.safeParse(json(body));
      if (!parsed.success) throw unavailable();
      return (parsed.data.web?.results ?? [])
        .map(toResult)
        .filter((r): r is SearchResult => r !== null)
        .slice(0, n);
    },
  };
}
