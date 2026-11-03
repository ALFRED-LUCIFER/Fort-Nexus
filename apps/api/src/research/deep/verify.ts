import { z } from "zod";
import {
  AiConfidence,
  Claim,
  DeepDiveReport,
  OpportunityDraft,
  type ClaimEvidence,
  type ClaimLabel,
  type SourceTier,
} from "@nexus/contracts";
import { urlsIn } from "../../ai.ts";
import { canonicalUrl, publisherOf } from "../findings.ts";

// FR-RES-06 truth rules: the model proposes claims with quotes; NEXUS decides what is verified. A quote counts only
// when the server finds it in the text of a page it fetched itself in this dive.

const QUOTE_MIN = 20;
const QUOTE_MAX = 500;
const LINK_REMOVED = "[link removed]";

/** What the model may send in record_report: no verification fields; NEXUS computes those. */
export const ReportInput = z
  .strictObject({
    summary: z.string().max(3000),
    claims: z
      .array(
        z.strictObject({
          id: Claim.shape.id,
          text: Claim.shape.text,
          basis: Claim.shape.basis,
          evidence: z
            .array(z.strictObject({ url: z.string().max(2000), quote: z.string().max(QUOTE_MAX) }))
            .max(5),
        }),
      )
      .max(40),
    contradictions: z
      .array(
        z.strictObject({
          claimIds: z.array(z.int().nonnegative()).min(2).max(5),
          note: z.string().max(500),
        }),
      )
      .max(10),
    openQuestions: z.array(z.string().max(300)).max(8),
    confidence: AiConfidence,
    opportunity: z.strictObject(OpportunityDraft.shape).nullable(),
  })
  .refine((r) => new Set(r.claims.map((c) => c.id)).size === r.claims.length, {
    message: "claim ids must be unique",
    path: ["claims"],
  });
export type ReportInput = z.infer<typeof ReportInput>;

export type Snapshot = { id: string; url: string; finalUrl: string; text: string };
export type Policy = (host: string) => { tier: SourceTier; blocked: boolean };

/** Quote matching: NFKC, one quote and one dash style, whitespace collapsed, case-folded. */
export const normalise = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const canonical = (raw: string) => {
  try {
    return canonicalUrl(new URL(raw));
  } catch {
    return null;
  }
};

/** Claim label (FR-RES-06): CONTESTED > PRIMARY > CORROBORATED > UNVERIFIED, from verified evidence only. */
function labelOf(evidence: readonly ClaimEvidence[], contested: boolean): ClaimLabel {
  const verified = evidence.filter((e) => e.verified);
  if (contested) return "CONTESTED";
  if (verified.some((e) => e.tier === "PRIMARY")) return "PRIMARY";
  return new Set(verified.map((e) => e.publisher)).size >= 2 ? "CORROBORATED" : "UNVERIFIED";
}

/**
 * The stored report: every quote checked against the dive's snapshots, labels from the rules, contradictions kept
 * only when every claim they name is verified, and model text limited to `[n]` claim ids and URLs NEXUS fetched.
 */
export function verifyReport(
  input: ReportInput,
  snapshots: readonly Snapshot[],
  policy: Policy,
): DeepDiveReport {
  const pages = new Map<string, { id: string; text: string }>();
  for (const s of snapshots) {
    const page = { id: s.id, text: normalise(s.text) };
    pages.set(s.url, page);
    const final = canonical(s.finalUrl);
    if (final && !pages.has(final)) pages.set(final, page);
  }

  // Any URL NEXUS didn't fetch in this dive is removed from model text (longest first: no partial replacements).
  const clean = (text: string, max: number) => {
    const foreign = [...new Set(urlsIn(text))]
      .filter((u) => {
        const c = canonical(u);
        return !c || !pages.has(c);
      })
      .sort((a, b) => b.length - a.length);
    let out = text;
    for (const u of foreign) out = out.replaceAll(u, LINK_REMOVED);
    return out.slice(0, max);
  };

  const claims = input.claims.map((c) => {
    const evidence: ClaimEvidence[] = [];
    for (const e of c.evidence) {
      const url = canonical(e.url);
      if (!url) continue; // not a URL at all: nothing to show or check
      const page = pages.get(url);
      const quote = normalise(e.quote);
      evidence.push({
        url,
        publisher: publisherOf(url),
        tier: policy(new URL(url).hostname).tier,
        quote: e.quote,
        verified:
          !!page && quote.length >= QUOTE_MIN && e.quote.length <= QUOTE_MAX && page.text.includes(quote),
        snapshotId: page?.id ?? null,
      });
    }
    return { id: c.id, text: clean(c.text, 600), basis: c.basis, evidence };
  });

  const ids = new Set(claims.map((c) => c.id));
  const verifiedIds = new Set(claims.filter((c) => c.evidence.some((e) => e.verified)).map((c) => c.id));
  const contradictions = input.contradictions
    .filter(
      (k) => new Set(k.claimIds).size === k.claimIds.length && k.claimIds.every((i) => verifiedIds.has(i)),
    )
    .map((k) => ({ claimIds: k.claimIds, note: clean(k.note, 500) }));
  const contested = new Set(contradictions.flatMap((k) => k.claimIds));

  const summary = clean(input.summary, 3000).replace(/\[(\d+)\]/g, (m, n: string) =>
    ids.has(Number(n)) ? m : "",
  );
  const o = input.opportunity;
  const claimIds = o ? [...new Set(o.claimIds)].filter((i) => ids.has(i)) : [];
  return DeepDiveReport.parse({
    summary,
    claims: claims.map((c) => ({ ...c, label: labelOf(c.evidence, contested.has(c.id)) })),
    contradictions,
    openQuestions: input.openQuestions.map((q) => clean(q, 300)),
    confidence: input.confidence,
    opportunity:
      o && claimIds.length > 0
        ? {
            ...o,
            title: clean(o.title, 140),
            problem: clean(o.problem, 800),
            targetUsers: clean(o.targetUsers, 300),
            impactEstimate: clean(o.impactEstimate, 200),
            claimIds,
            validationSteps: o.validationSteps.map((v) => clean(v, 300)),
          }
        : null,
  });
}
