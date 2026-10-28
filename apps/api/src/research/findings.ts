import type { Finding, ScoringWeights, SourceTier, VerificationLabel } from "@nexus/contracts";

const TRACKING = new Set(["ref", "fbclid", "gclid"]);

/** RES-G02: lower-case host, no fragment/credentials/tracking params, no trailing slash, sorted query. */
export function canonicalUrl(u: URL): string {
  const c = new URL(u);
  c.hash = "";
  c.username = "";
  c.password = "";
  const params = [...c.searchParams]
    .filter(([k]) => !/^utm_/i.test(k) && !TRACKING.has(k.toLowerCase()))
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  c.search = new URLSearchParams(params).toString();
  c.pathname = c.pathname.replace(/\/+$/, "") || "/";
  return c.toString();
}

/** Publisher = host of the canonical URL; `www.` is the same publisher. */
export const publisherOf = (canonical: string) => new URL(canonical).hostname.replace(/^www\./, "");

const STOP = new Set("a an and are as at by for from in is it its new of on or the to with".split(" "));

export const titleTokens = (title: string) =>
  new Set((title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOP.has(t)));

// shortcut: lexical near-duplicate test (word-set Jaccard ≥ 0.6, ≥ 3 words each); switch to embeddings when they exist.
export function similar(a: Set<string>, b: Set<string>) {
  if (a.size < 3 || b.size < 3) return false;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared) >= 0.6;
}

/** RES-G03: PRIMARY if any source is PRIMARY tier, CORROBORATED with ≥ 2 distinct publishers, else UNVERIFIED. */
export function verificationLabel(
  sources: readonly { tier: SourceTier; publisher: string }[],
): VerificationLabel {
  if (sources.some((s) => s.tier === "PRIMARY")) return "PRIMARY";
  return new Set(sources.map((s) => s.publisher)).size >= 2 ? "CORROBORATED" : "UNVERIFIED";
}

const TIER_CREDIBILITY: Record<SourceTier, number> = { PRIMARY: 1, SECONDARY: 0.7, COMMUNITY: 0.4 };
const IMPACT = ["release", "breaking", "deprecat", "security", "vulnerab", "cve-", "end of life", "migrat"];
const OPPORTUNITY = [
  "problem",
  "pain",
  "alternative",
  "pricing",
  "expensive",
  "complain",
  "frustrat",
  "workaround",
];
const NOVELTY_DAYS = 14;
const DAY_MS = 86_400_000;

const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

/** Triage criteria in [0,1] (FR-RES-07). Not probabilities: fixed heuristics the owner weights. */
export function scoreBreakdown(f: {
  title: string;
  excerpt: string;
  publishedAt: Date | null;
  firstSeenAt: Date;
  tiers: readonly SourceTier[];
  keywords: readonly string[];
}): Finding["scoreBreakdown"] {
  const text = `${f.title} ${f.excerpt}`.toLowerCase();
  const hits = (words: readonly string[]) => words.filter((w) => text.includes(w.toLowerCase())).length;
  // How old the story already was when NEXUS first saw it.
  const ageDays = f.publishedAt ? Math.max(0, f.firstSeenAt.getTime() - f.publishedAt.getTime()) / DAY_MS : 0;
  return {
    credibility: Math.max(...f.tiers.map((t) => TIER_CREDIBILITY[t])),
    // No keywords configured: every item of an owner-picked source is equally (neutrally) relevant.
    relevance: round(f.keywords.length ? hits(f.keywords) / f.keywords.length : 0.5),
    novelty: round(1 - ageDays / NOVELTY_DAYS),
    impact: round(hits(IMPACT) / 2),
    opportunity: round(hits(OPPORTUNITY) / 2),
  };
}

/** Weighted mean × 100 with the watchlist's current weights (ratios only matter). */
export function score(b: Finding["scoreBreakdown"], w: ScoringWeights) {
  const keys = Object.keys(b) as (keyof ScoringWeights)[];
  const total = keys.reduce((s, k) => s + w[k], 0);
  return Math.round((100 * keys.reduce((s, k) => s + b[k] * w[k], 0)) / total);
}
