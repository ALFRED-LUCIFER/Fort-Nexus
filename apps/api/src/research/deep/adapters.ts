// Deleted by the coordinator at merge: real modules replace these (docs/specs/p1-wave-5-researcher.md, "Cross-module
// signatures"). A: research/web/page.ts readPage, research/web/search.ts loadSearch, research/domains.ts domainPolicy;
// C: research/opportunities/service.ts recordOpportunity. Same signatures; minimal behaviour until then.
import { createHash } from "node:crypto";
import type { DeepDiveReport, SourceTier } from "@nexus/contracts";
import type { Db, Tx } from "../../db/index.ts";
import { HttpError } from "../../errors.ts";
import type { fetchSession, Skip } from "../fetch.ts";

type FetchSession = ReturnType<typeof fetchSession>;

export type PageResult = { ok: true; finalUrl: URL; title: string; text: string; sha256: string } | Skip;

const MAX_TEXT = 200_000;
const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** Readable text of one page (A replaces this with Readability). */
export async function readPage(get: FetchSession["get"], url: URL): Promise<PageResult> {
  const res = await get(url);
  if (!res.ok) return res;
  const html = /<html|<body|<p[\s>]/i.test(res.body);
  const title = html ? decode(/<title[^>]*>([^<]*)<\/title>/i.exec(res.body)?.[1] ?? "").trim() : "";
  const text = (
    html
      ? decode(
          res.body.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "),
        )
      : res.body
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
  return {
    ok: true,
    finalUrl: res.url,
    title: title.slice(0, 300),
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

export const SEARCH_RUNBOOK = "docs/runbooks/web-search.md";

export type SearchResult = { title: string; url: URL; snippet: string; publishedAt: Date | null };
export type SearchClient = {
  provider: "brave";
  search(query: string, opts: { count: number; signal: AbortSignal }): Promise<SearchResult[]>;
};
export class SearchError extends Error {
  readonly kind: "AUTH" | "RATE_LIMITED" | "UNAVAILABLE";
  constructor(kind: "AUTH" | "RATE_LIMITED" | "UNAVAILABLE", message: string) {
    super(message);
    this.kind = kind;
  }
}

/** The search provider (A replaces this with the Brave client): not configured until then. */
export async function loadSearch(file: string): Promise<SearchClient> {
  throw new HttpError(
    409,
    "CONFLICT",
    `NEXUS needs a web search provider for this. On the home machine create ${file} with mode 0600 (see ${SEARCH_RUNBOOK}), then try again.`,
    { reason: "search_provider_not_configured", file, runbook: SEARCH_RUNBOOK },
  );
}

/** The owner's domain rules (A replaces this): every domain is COMMUNITY tier and none is blocked until then. */
export async function domainPolicy(
  _db: Db | Tx,
  _workspaceId: string,
): Promise<(host: string) => { domain: string | null; tier: SourceTier; blocked: boolean }> {
  return () => ({ domain: null, tier: "COMMUNITY", blocked: false });
}

/** The opportunity a completed dive proposes (C replaces this): none until then. */
export async function recordOpportunity(
  _tx: Tx,
  _dive: { id: string; workspaceId: string; projectId: string },
  _report: DeepDiveReport,
): Promise<string | null> {
  return null;
}
