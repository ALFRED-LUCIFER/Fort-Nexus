import { z } from "zod";

// EPIC RES (FR-RES-01..12). Findings are triage aids from public sources; scores are not probabilities (PRD §9 RES).

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
export const TimeZone = z.string().min(1).max(64).refine(isTimeZone, "Unknown IANA time zone");

// Owner-assigned credibility of a source. PRIMARY = the vendor's own release notes / repo releases.
export const SourceTier = z.enum(["PRIMARY", "SECONDARY", "COMMUNITY"]);
export type SourceTier = z.infer<typeof SourceTier>;

export const ResearchSource = z.discriminatedUnion("kind", [
  // Any RSS 2.0 / Atom feed, including official release-notes feeds. https only; no credentials, ever (FR-RES-12).
  z.strictObject({
    kind: z.literal("FEED"),
    url: z.url({ protocol: /^https$/ }).max(2048),
    tier: SourceTier,
  }),
  // https://github.com/<repo>/releases.atom
  z.strictObject({
    kind: z.literal("GITHUB_RELEASES"),
    repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
    tier: SourceTier.default("PRIMARY"),
  }),
]);
export type ResearchSource = z.infer<typeof ResearchSource>;

const Weight = z.int().min(0).max(100);
// FR-RES-07; normalised server-side, so only the ratio matters.
export const ScoringWeights = z
  .strictObject({
    credibility: Weight,
    relevance: Weight,
    novelty: Weight,
    impact: Weight,
    opportunity: Weight,
  })
  .refine((w) => Object.values(w).some((v) => v > 0), "At least one weight must be above 0");
export type ScoringWeights = z.infer<typeof ScoringWeights>;

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  credibility: 25,
  relevance: 25,
  novelty: 20,
  impact: 15,
  opportunity: 15,
};

// 0 = Sunday … 6 = Saturday. Daily = all seven days; weekly = one day (FR-RES-02).
export const Weekday = z.int().min(0).max(6);

export const BriefSchedule = z.strictObject({
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24h"),
  timezone: TimeZone,
  days: z.array(Weekday).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  paused: z.boolean().default(false),
});
export type BriefSchedule = z.infer<typeof BriefSchedule>;

const Keyword = z.string().trim().min(1).max(80);

export const CreateWatchlistRequest = z.strictObject({
  name: z.string().trim().min(1).max(120),
  keywords: z.array(Keyword).max(50).default([]),
  sources: z.array(ResearchSource).min(1).max(50),
  weights: ScoringWeights.default(DEFAULT_SCORING_WEIGHTS),
  schedule: BriefSchedule,
});
export type CreateWatchlistRequest = z.infer<typeof CreateWatchlistRequest>;

export const UpdateWatchlistRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    keywords: z.array(Keyword).max(50),
    sources: z.array(ResearchSource).min(1).max(50),
    weights: ScoringWeights,
    schedule: BriefSchedule,
  })
  .partial()
  .refine((u) => Object.keys(u).length > 0, "Nothing to update");
export type UpdateWatchlistRequest = z.infer<typeof UpdateWatchlistRequest>;

export const Watchlist = z.object({
  id: z.uuid(),
  name: z.string(),
  keywords: z.array(z.string()),
  sources: z.array(ResearchSource),
  weights: ScoringWeights,
  schedule: BriefSchedule,
  // Null while paused.
  nextRunAt: z.iso.datetime({ offset: true }).nullable(),
  lastRunAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Watchlist = z.infer<typeof Watchlist>;

export const WatchlistList = z.object({ items: z.array(Watchlist) });
export type WatchlistList = z.infer<typeof WatchlistList>;

// FR-RES-06: PRIMARY = backed by a PRIMARY-tier source; CORROBORATED = ≥2 independent publishers; else UNVERIFIED.
export const VerificationLabel = z.enum(["PRIMARY", "CORROBORATED", "UNVERIFIED"]);
export type VerificationLabel = z.infer<typeof VerificationLabel>;

const Unit = z.number().min(0).max(1);

export const FindingSource = z.object({
  url: z.url(),
  publisher: z.string(), // host name of the canonical URL
  tier: SourceTier,
  title: z.string(),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  fetchedAt: z.iso.datetime({ offset: true }),
});
export type FindingSource = z.infer<typeof FindingSource>;

// One deduplicated story (FR-RES-05): every source that reported it stays linked.
export const Finding = z.object({
  id: z.uuid(),
  watchlistId: z.uuid(),
  title: z.string(),
  // Evidence excerpt from the source, plain text (markup stripped), ≤ 1000 chars. Untrusted text.
  excerpt: z.string(),
  canonicalUrl: z.url(),
  label: VerificationLabel,
  score: z.int().min(0).max(100),
  scoreBreakdown: z.object({
    credibility: Unit,
    relevance: Unit,
    novelty: Unit,
    impact: Unit,
    opportunity: Unit,
  }),
  sources: z.array(FindingSource).min(1),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  firstSeenAt: z.iso.datetime({ offset: true }),
  firstRunId: z.uuid(),
  readAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Finding = z.infer<typeof Finding>;

export const SkipReason = z.enum([
  "ROBOTS_DISALLOWED",
  "AUTH_REQUIRED",
  "HTTP_ERROR",
  "TIMEOUT",
  "TOO_LARGE",
  "INVALID_FEED",
  "RATE_LIMITED",
]);
export type SkipReason = z.infer<typeof SkipReason>;

export const ResearchRunStatus = z.enum(["RUNNING", "COMPLETED", "PARTIAL", "FAILED"]);
export type ResearchRunStatus = z.infer<typeof ResearchRunStatus>;

// A brief = one run of one watchlist. Scheduled runs are unique per (watchlist, local date) — RES-G01.
export const ResearchRun = z.object({
  id: z.uuid(),
  watchlistId: z.uuid(),
  trigger: z.enum(["SCHEDULED", "MANUAL"]),
  // Local date of the scheduled window (YYYY-MM-DD in the watchlist's time zone); null for manual runs.
  windowDate: z.iso.date().nullable(),
  status: ResearchRunStatus,
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  newFindings: z.int().nonnegative(),
  skippedSources: z.array(z.object({ source: z.string(), reason: SkipReason, detail: z.string().max(300) })),
  // Why a run FAILED without finishing (restart, shutdown, internal error); fixed server text, never exception detail.
  error: z.string().nullable(),
});
export type ResearchRun = z.infer<typeof ResearchRun>;

export const ResearchRunList = z.object({ items: z.array(ResearchRun) });
export type ResearchRunList = z.infer<typeof ResearchRunList>;

// The daily digest (FR-RES-08): new findings of one run, best first.
export const ResearchBrief = z.object({ run: ResearchRun, findings: z.array(Finding) });
export type ResearchBrief = z.infer<typeof ResearchBrief>;

// FR-RES-09: full-text search over title/excerpt, filters by watchlist, label and first-seen date.
export const FindingSearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  watchlistId: z.uuid().optional(),
  label: VerificationLabel.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  unread: z.stringbool().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type FindingSearchQuery = z.infer<typeof FindingSearchQuery>;

export const FindingList = z.object({ items: z.array(Finding), nextCursor: z.string().nullable() });
export type FindingList = z.infer<typeof FindingList>;
