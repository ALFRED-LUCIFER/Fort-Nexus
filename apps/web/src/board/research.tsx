import { useState, type FormEvent, type ReactNode } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  CreateWatchlistRequest,
  type Finding,
  type ResearchRun,
  type ScoringWeights,
  type SkipReason,
  type SourceTier,
  type UpdateWatchlistRequest,
  type VerificationLabel,
  type Watchlist,
} from "@nexus/contracts";
import { api, keys, type FindingFilters } from "../lib/api.ts";
import { ago, clock, until, useNow } from "../lib/queries.ts";
import { Drawer, DrawerHeader } from "./Drawer.tsx";
import { EmptyZone } from "./zones.tsx";

const POLL_MS = 30_000;
const RUN_POLL_MS = 2_000;
const ZONE_FINDINGS = 4;
const PAGE = 20;

const field =
  "min-w-0 rounded-xl border border-hair bg-card px-3 py-2 text-[13px] text-ink placeholder:text-ink3";
const ghostBtn =
  "rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink disabled:opacity-45";
const primaryBtn = "rounded-xl bg-teal px-4 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60";

// Truth hierarchy: only a PRIMARY source or two independent publishers make a finding more than a claim (RES-G03).
const LABEL: Record<VerificationLabel, { text: string; tone: string }> = {
  PRIMARY: { text: "Primary source", tone: "var(--green)" },
  CORROBORATED: { text: "Corroborated", tone: "var(--teal)" },
  UNVERIFIED: { text: "Unverified claim", tone: "var(--amber)" },
};

const SKIP: Record<SkipReason, string> = {
  ROBOTS_DISALLOWED: "Blocked by robots.txt",
  AUTH_REQUIRED: "Needs sign-in, not attempted",
  HTTP_ERROR: "Fetch failed",
  TIMEOUT: "Timed out",
  TOO_LARGE: "Larger than 2 MB",
  INVALID_FEED: "Not an RSS or Atom feed",
  RATE_LIMITED: "Source asked NEXUS to slow down",
};

const STATUS: Record<ResearchRun["status"], string> = {
  RUNNING: "Running",
  COMPLETED: "Completed",
  PARTIAL: "Completed, some sources skipped",
  FAILED: "Failed",
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEIGHTS: [keyof ScoringWeights, string][] = [
  ["credibility", "Credibility"],
  ["relevance", "Relevance"],
  ["novelty", "Novelty"],
  ["impact", "Impact"],
  ["opportunity", "Opportunity"],
];

export const useWatchlists = () =>
  useQuery({ queryKey: keys.watchlists, queryFn: api.watchlists, refetchInterval: POLL_MS });

const scheduleText = (w: Watchlist) =>
  `${w.schedule.localTime} ${w.schedule.timezone} · ${
    w.schedule.days.length === 7 ? "daily" : w.schedule.days.map((d) => DAYS[d]).join(", ")
  }`;

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** Zone subtitle: how many watchlists and when the next brief is due. */
export function researchSub(watchlists: readonly Watchlist[] | undefined) {
  if (!watchlists) return "";
  if (watchlists.length === 0) return "no watchlists";
  const next = watchlists
    .map((w) => w.nextRunAt)
    .filter((t) => t !== null)
    .sort()[0];
  const n = `${watchlists.length} ${watchlists.length === 1 ? "watchlist" : "watchlists"}`;
  return next ? `${n} · next brief ${when(next)}` : `${n} · all paused`;
}

const linkable = (url: string) => /^https?:\/\//i.test(url);

function LabelChip({ label }: { label: VerificationLabel }) {
  return (
    <span className="kicker inline-flex items-center gap-1.5" style={{ color: LABEL[label].tone }}>
      <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: LABEL[label].tone }} />
      {LABEL[label].text}
    </span>
  );
}

/** RES-G03: an unverified finding reads as what its publisher claims, never as an established fact. */
function FindingTitle({ f }: { f: Finding }) {
  if (f.label !== "UNVERIFIED") return <>{f.title}</>;
  return (
    <>
      {f.sources[0]?.publisher ?? "A source"} claims: “{f.title}”
    </>
  );
}

function Stale({ query }: { query: { error: Error | null; data: unknown; dataUpdatedAt: number } }) {
  if (!query.error || query.data === undefined) return null;
  return (
    <p role="status" className="m-0 text-[12.5px] leading-normal text-amber">
      Can&apos;t refresh: {query.error.message} Showing what NEXUS had at{" "}
      {clock(new Date(query.dataUpdatedAt).toISOString())}.
    </p>
  );
}

function Pending({ error }: { error: Error | null }) {
  return error ? (
    <p role="alert" className="m-0 text-[14px] text-coral">
      {error.message}
    </p>
  ) : (
    <p role="status" className="m-0 text-[13px] text-ink3">
      Loading…
    </p>
  );
}

// ---------------------------------------------------------------- zone

export function ResearchZone({
  watchlists,
  onOpen,
}: {
  watchlists: UseQueryResult<Watchlist[]>;
  onOpen: () => void;
}) {
  const now = useNow(30_000);
  const has = !!watchlists.data?.length;
  const findings = useQuery({
    queryKey: keys.findings({ limit: PAGE }),
    queryFn: () => api.findings({ limit: PAGE }),
    enabled: has,
    refetchInterval: POLL_MS,
  });
  if (!watchlists.data) return <EmptyZone>{watchlists.error?.message ?? "Loading…"}</EmptyZone>;
  if (!has)
    return (
      <div className="flex flex-col items-start gap-4">
        <EmptyZone>
          No watchlists yet. Pick feeds and GitHub repositories to watch; NEXUS reads them on your schedule
          and briefs you with sources.
        </EmptyZone>
        <button type="button" onClick={onOpen} className={primaryBtn}>
          Create a watchlist
        </button>
      </div>
    );
  const top = (findings.data?.items ?? []).toSorted((a, b) => b.score - a.score).slice(0, ZONE_FINDINGS);
  return (
    <div className="flex flex-col gap-3">
      <h3 className="kicker m-0">Top recent findings · score is a triage aid</h3>
      <Stale query={findings} />
      {top.length === 0 ? (
        <EmptyZone>
          {findings.isPending
            ? "Loading…"
            : (findings.error?.message ?? "No findings yet. Open Research and run a watchlist now.")}
        </EmptyZone>
      ) : (
        <ul className="m-0 flex list-none flex-wrap content-start gap-[30px] p-0">
          {top.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={onOpen}
                className="flex w-[220px] flex-col gap-2 rounded-[20px] border border-line bg-card px-4 py-3.5 text-left shadow-nx transition-shadow hover:shadow-[0_0_0_2px_var(--teal),var(--shadow)]"
              >
                <LabelChip label={f.label} />
                <span className="line-clamp-3 text-[14px] leading-[1.3] font-medium text-pretty">
                  <FindingTitle f={f} />
                </span>
                <span className="font-mono text-[11.5px] leading-[1.45] text-ink2">
                  {f.sources.length} {f.sources.length === 1 ? "source" : "sources"} · score {f.score} · seen{" "}
                  {ago(f.firstSeenAt, now)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={onOpen}
        className="self-start text-[13px] font-medium text-teal underline"
      >
        Open research
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- drawer

export function ResearchDrawer({ banner, onClose }: { banner?: ReactNode; onClose: () => void }) {
  return (
    <Drawer banner={banner} onClose={onClose}>
      <ResearchBody />
    </Drawer>
  );
}

function ResearchBody() {
  const watchlists = useWatchlists();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const items = watchlists.data ?? [];
  const current = items.find((w) => w.id === selected) ?? items[0];
  return (
    <>
      <DrawerHeader kicker="Research · public sources · scores are triage aids, not facts" title="Research" />
      <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-7 overflow-auto px-6 pt-5 pb-6">
        <section aria-labelledby="res-watchlists" className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <h3 id="res-watchlists" className="kicker m-0 flex-1">
              Watchlists
            </h3>
            <button
              type="button"
              aria-expanded={creating}
              onClick={() => setCreating((c) => !c)}
              className={ghostBtn}
            >
              {creating ? "Close form" : "New watchlist"}
            </button>
          </div>
          {creating && (
            <CreateWatchlist
              onCreated={(w) => {
                setCreating(false);
                setSelected(w.id);
              }}
            />
          )}
          <Stale query={watchlists} />
          {!watchlists.data ? (
            <Pending error={watchlists.error} />
          ) : items.length === 0 ? (
            !creating && (
              <p className="m-0 text-[14px] leading-relaxed text-ink2">
                No watchlists yet. Create one with the feeds and GitHub repositories you want briefs about.
              </p>
            )
          ) : (
            <ul aria-label="Watchlists" className="m-0 flex list-none flex-col gap-2.5 p-0">
              {items.map((w) => (
                <WatchlistItem
                  key={w.id}
                  w={w}
                  selected={w.id === current?.id}
                  onSelect={() => setSelected(w.id)}
                />
              ))}
            </ul>
          )}
        </section>
        {current && <LatestBrief key={current.id} w={current} />}
        {items.length > 0 && <FindingSearch watchlists={items} />}
      </div>
    </>
  );
}

function WatchlistItem({ w, selected, onSelect }: { w: Watchlist; selected: boolean; onSelect: () => void }) {
  const now = useNow(30_000);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.research });
  // One key per click; a retried click reuses it, so the API returns the same run instead of a second one.
  const [runKey, setRunKey] = useState(() => crypto.randomUUID());
  const run = useMutation({
    mutationFn: () => api.runWatchlist(w.id, runKey),
    onSuccess: () => {
      setRunKey(crypto.randomUUID());
      onSelect();
      void refresh();
    },
  });
  const update = useMutation({
    mutationFn: (body: UpdateWatchlistRequest) => api.updateWatchlist(w.id, body),
    onSuccess: () => void refresh(),
  });
  const paused = w.schedule.paused;
  const error = run.error ?? update.error;
  return (
    <li
      className={`flex flex-col gap-2.5 rounded-2xl border px-4 py-3.5 ${selected ? "border-teal" : "border-hair"}`}
    >
      <div className="flex flex-wrap items-start gap-2">
        <button
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
          className="min-w-0 flex-1 text-left text-[15px] font-medium text-ink"
        >
          {w.name}
          <span className="sr-only">{selected ? ", brief shown below" : ", show its brief"}</span>
        </button>
        <button type="button" disabled={run.isPending} onClick={() => run.mutate()} className={primaryBtn}>
          {run.isPending ? "Starting…" : "Run now"}
          <span className="sr-only">, {w.name}</span>
        </button>
        <button
          type="button"
          disabled={update.isPending}
          onClick={() => update.mutate({ schedule: { ...w.schedule, paused: !paused } })}
          className={ghostBtn}
        >
          {paused ? "Resume schedule" : "Pause schedule"}
          <span className="sr-only">, {w.name}</span>
        </button>
      </div>
      <span className="font-mono text-[11.5px] leading-[1.5] text-ink2">
        {paused || !w.nextRunAt ? "paused" : `next brief ${until(w.nextRunAt, now)}`} · {scheduleText(w)} ·
        last run {ago(w.lastRunAt, now)}
      </span>
      <span className="text-[12.5px] leading-normal break-words text-ink2">
        {w.sources.length} {w.sources.length === 1 ? "source" : "sources"}:{" "}
        {w.sources.map((s) => (s.kind === "FEED" ? new URL(s.url).host : s.repo)).join(", ")}
        {w.keywords.length > 0 && <> · keywords: {w.keywords.join(", ")}</>}
      </span>
      <Weights w={w} saving={update.isPending} onSave={(weights) => update.mutate({ weights })} />
      {error && (
        <p role="alert" className="m-0 text-[13px] text-coral">
          {error.message}
        </p>
      )}
    </li>
  );
}

function Weights({
  w,
  saving,
  onSave,
}: {
  w: Watchlist;
  saving: boolean;
  onSave: (weights: ScoringWeights) => void;
}) {
  const [draft, setDraft] = useState(w.weights);
  const changed = WEIGHTS.some(([k]) => draft[k] !== w.weights[k]);
  const allZero = WEIGHTS.every(([k]) => draft[k] === 0);
  return (
    <details className="text-[12.5px] text-ink2">
      <summary className="cursor-pointer font-medium text-ink">Scoring weights</summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="m-0 leading-normal text-ink3">
          Only the ratio matters. Scores rank findings; they aren&apos;t probabilities.
        </p>
        {WEIGHTS.map(([k, label]) => (
          <label key={k} className="grid grid-cols-[110px_minmax(0,1fr)_36px] items-center gap-3">
            {label}
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={draft[k]}
              onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })}
            />
            <span className="text-right font-mono">{draft[k]}</span>
          </label>
        ))}
        {allZero && <p className="m-0 text-coral">At least one weight must be above 0.</p>}
        <button
          type="button"
          disabled={!changed || allZero || saving}
          onClick={() => onSave(draft)}
          className={`${ghostBtn} self-start`}
        >
          {saving ? "Saving…" : "Save weights"}
        </button>
      </div>
    </details>
  );
}

function CreateWatchlist({ onCreated }: { onCreated: (w: Watchlist) => void }) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: api.createWatchlist,
    onSuccess: (w) => {
      void queryClient.invalidateQueries({ queryKey: keys.research });
      onCreated(w);
    },
  });
  const lines = (v: FormDataEntryValue | null) =>
    String(v ?? "")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const tier = String(data.get("tier")) as SourceTier;
    const sources = [
      ...lines(data.get("feeds")).map((url) => ({ kind: "FEED" as const, url, tier })),
      ...lines(data.get("repos")).map((repo) => ({ kind: "GITHUB_RELEASES" as const, repo })),
    ];
    if (sources.length === 0) return setProblem("Add at least one feed or GitHub repository.");
    const parsed = CreateWatchlistRequest.safeParse({
      name: data.get("name"),
      keywords: lines(data.get("keywords")),
      sources,
      schedule: {
        localTime: data.get("localTime"),
        timezone: String(data.get("timezone")).trim(),
        days: data.getAll("days").map(Number),
      },
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const where = issue.path[0] === "sources" ? "Sources" : String(issue.path.at(-1) ?? "Form");
      return setProblem(`${where}: ${issue.message}`);
    }
    setProblem(null);
    create.mutate(parsed.data);
  };

  return (
    <form
      aria-label="New watchlist"
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-2xl border border-hair p-4 text-[12.5px] text-ink2"
    >
      <label className="flex flex-col gap-1.5">
        Name
        <input name="name" required maxLength={120} className={field} />
      </label>
      <label className="flex flex-col gap-1.5">
        Keywords (comma-separated, optional)
        <input name="keywords" placeholder="agents, sdk, pricing" className={field} />
      </label>
      <label className="flex flex-col gap-1.5">
        Feeds: RSS or Atom, https only, one per line
        <textarea name="feeds" rows={3} placeholder="https://example.com/feed.xml" className={field} />
      </label>
      <label className="flex flex-col gap-1.5">
        How credible are these feeds?
        <select name="tier" defaultValue="SECONDARY" className={field}>
          <option value="PRIMARY">Primary: the vendor&apos;s own announcements</option>
          <option value="SECONDARY">Secondary: press and analysts</option>
          <option value="COMMUNITY">Community: forums and posts</option>
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        GitHub releases: owner/repo, one per line (primary sources)
        <textarea
          name="repos"
          rows={2}
          placeholder="anthropics/claude-agent-sdk-typescript"
          className={field}
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1.5">
          Local time
          <input name="localTime" type="time" defaultValue="08:00" required className={field} />
        </label>
        <label className="flex min-w-[220px] flex-1 flex-col gap-1.5">
          Time zone (IANA)
          <input
            name="timezone"
            defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
            required
            className={field}
          />
        </label>
      </div>
      <fieldset className="m-0 flex flex-wrap gap-3 border-0 p-0">
        <legend className="mb-1.5 p-0">Days</legend>
        {DAYS.map((d, i) => (
          <label key={d} className="flex items-center gap-1.5">
            <input type="checkbox" name="days" value={i} defaultChecked />
            {d}
          </label>
        ))}
      </fieldset>
      {(problem ?? create.error) && (
        <p role="alert" className="m-0 text-[13px] text-coral">
          {problem ?? create.error?.message}
        </p>
      )}
      <button type="submit" disabled={create.isPending} className={`${primaryBtn} self-start`}>
        {create.isPending ? "Creating…" : "Create watchlist"}
      </button>
    </form>
  );
}

function LatestBrief({ w }: { w: Watchlist }) {
  const now = useNow(30_000);
  const runs = useQuery({
    queryKey: keys.researchRuns(w.id),
    queryFn: () => api.researchRuns(w.id),
    refetchInterval: (q) => (q.state.data?.[0]?.status === "RUNNING" ? RUN_POLL_MS : POLL_MS),
  });
  const latest = runs.data?.[0];
  const brief = useQuery({
    queryKey: keys.brief(latest?.id ?? ""),
    queryFn: () => api.brief(latest!.id),
    enabled: !!latest,
    refetchInterval: (q) => (q.state.data?.run.status === "RUNNING" ? RUN_POLL_MS : false),
  });
  const run = brief.data?.run;
  return (
    <section aria-labelledby="res-brief" className="flex flex-col gap-3">
      <h3 id="res-brief" className="kicker m-0">
        Latest brief · {w.name}
      </h3>
      <Stale query={runs} />
      {!runs.data ? (
        <Pending error={runs.error} />
      ) : !latest ? (
        <p className="m-0 text-[14px] leading-relaxed text-ink2">
          No brief yet. Run it now
          {w.nextRunAt ? `, or wait for the scheduled one ${until(w.nextRunAt, now)}` : ""}.
        </p>
      ) : !run ? (
        <Pending error={brief.error} />
      ) : (
        <>
          <p role="status" className="m-0 font-mono text-[11.5px] leading-[1.5] text-ink2">
            {run.trigger === "SCHEDULED" ? `Scheduled brief for ${run.windowDate}` : "Run on demand"} ·{" "}
            {STATUS[run.status]} · started {ago(run.startedAt, now)}
            {run.status !== "RUNNING" && ` · ${run.newFindings} new`}
          </p>
          {run.status === "RUNNING" ? (
            <p className="m-0 text-[14px] text-ink2">
              Reading sources. Findings appear here when the run finishes.
            </p>
          ) : run.status === "FAILED" && run.skippedSources.length === 0 ? (
            <p className="m-0 text-[14px] text-coral">
              This run failed before it finished and won&apos;t be retried. Run it again.
            </p>
          ) : brief.data!.findings.length === 0 ? (
            <p className="m-0 text-[14px] text-ink2">Nothing new in this run.</p>
          ) : (
            <ul aria-label="Brief findings" className="m-0 flex list-none flex-col gap-2.5 p-0">
              {brief.data!.findings.map((f) => (
                <FindingCard key={f.id} f={f} />
              ))}
            </ul>
          )}
          {run.skippedSources.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h4 className="kicker m-0">Skipped sources</h4>
              <ul aria-label="Skipped sources" className="m-0 flex list-none flex-col gap-1.5 p-0">
                {run.skippedSources.map((s) => (
                  <li key={s.source} className="text-[12.5px] leading-normal break-words text-ink2">
                    <span className="font-medium text-ink">{SKIP[s.reason]}</span> · {s.source}
                    <span className="block font-mono text-[11px] text-ink3">{s.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FindingCard({ f }: { f: Finding }) {
  const now = useNow(30_000);
  const queryClient = useQueryClient();
  const read = useMutation({
    mutationFn: () => api.readFinding(f.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.research }),
  });
  const b = f.scoreBreakdown;
  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-hair px-4 py-3.5">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <LabelChip label={f.label} />
        <span
          className="font-mono text-[11px] text-ink3"
          title={`credibility ${b.credibility} · relevance ${b.relevance} · novelty ${b.novelty} · impact ${b.impact} · opportunity ${b.opportunity}`}
        >
          triage score {f.score}/100
        </span>
        {!f.readAt && <span className="font-mono text-[11px] text-teal">unread</span>}
      </span>
      <span className="text-[14.5px] leading-[1.35] font-medium text-ink">
        <FindingTitle f={f} />
      </span>
      {f.excerpt && (
        <blockquote className="m-0 border-l-2 border-hair pl-3 text-[12.5px] leading-normal break-words text-ink2">
          {f.excerpt}
        </blockquote>
      )}
      <ul aria-label="Sources" className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] text-ink2">
        {f.sources.map((s) => (
          <li key={s.url} className="break-words">
            {linkable(s.url) ? (
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-teal underline"
              >
                {s.publisher}
                <span className="sr-only">, opens in a new tab</span>
              </a>
            ) : (
              s.publisher
            )}{" "}
            · {s.tier.toLowerCase()} ·{" "}
            {s.publishedAt ? `published ${ago(s.publishedAt, now)}` : "no publish date"}
          </li>
        ))}
      </ul>
      {f.readAt ? (
        <span className="font-mono text-[11px] text-ink3">read {ago(f.readAt, now)}</span>
      ) : (
        <button
          type="button"
          disabled={read.isPending}
          onClick={() => read.mutate()}
          className="self-start text-[12px] font-medium text-teal underline disabled:opacity-45"
        >
          Mark read
        </button>
      )}
      {read.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {read.error.message}
        </p>
      )}
    </li>
  );
}

function FindingSearch({ watchlists }: { watchlists: readonly Watchlist[] }) {
  const [filters, setFilters] = useState<FindingFilters>({});
  const results = useInfiniteQuery({
    queryKey: [...keys.findings(filters), "search"],
    queryFn: ({ pageParam }) => api.findings({ ...filters, limit: PAGE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = results.data?.pages.flatMap((p) => p.items) ?? [];

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const text = (k: string) => String(d.get(k) ?? "").trim() || undefined;
    setFilters({
      q: text("q"),
      watchlistId: text("watchlistId"),
      label: text("label") as VerificationLabel | undefined,
      from: text("from"),
      to: text("to"),
      unread: d.get("unread") ? true : undefined,
    });
  };

  return (
    <section aria-labelledby="res-search" className="flex flex-col gap-3">
      <h3 id="res-search" className="kicker m-0">
        Search findings
      </h3>
      <form
        role="search"
        aria-label="Search findings"
        onSubmit={submit}
        className="flex flex-wrap items-end gap-2.5 text-[12px] text-ink2"
      >
        <label className="flex min-w-[180px] flex-1 flex-col gap-1">
          Search text
          <input name="q" type="search" maxLength={200} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          Watchlist
          <select name="watchlistId" className={field}>
            <option value="">Any</option>
            {watchlists.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Label
          <select name="label" className={field}>
            <option value="">Any</option>
            {(Object.keys(LABEL) as VerificationLabel[]).map((l) => (
              <option key={l} value={l}>
                {LABEL[l].text}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          First seen from
          <input name="from" type="date" className={field} />
        </label>
        <label className="flex flex-col gap-1">
          to
          <input name="to" type="date" className={field} />
        </label>
        <label className="flex items-center gap-1.5 py-2">
          <input name="unread" type="checkbox" /> Unread only
        </label>
        <button type="submit" className={ghostBtn}>
          Search
        </button>
      </form>
      <Stale query={results} />
      {!results.data ? (
        <Pending error={results.error} />
      ) : items.length === 0 ? (
        <p className="m-0 text-[14px] text-ink2">No findings match.</p>
      ) : (
        <ul aria-label="Search results" className="m-0 flex list-none flex-col gap-2.5 p-0">
          {items.map((f) => (
            <FindingCard key={f.id} f={f} />
          ))}
        </ul>
      )}
      {results.hasNextPage && (
        <button
          type="button"
          disabled={results.isFetchingNextPage}
          onClick={() => void results.fetchNextPage()}
          className={`${ghostBtn} self-start`}
        >
          {results.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
