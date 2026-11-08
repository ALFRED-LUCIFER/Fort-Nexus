import { useId, useState, type FormEvent } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CreateDeepDiveRequest,
  DEEP_DIVE_DEPTH_LIMITS,
  type Claim,
  type ClaimLabel,
  type DeepDive,
  type DeepDiveDepth,
  type DeepDiveDetail,
  type DeepDiveStatus,
  type DeepDiveStep,
  type DeepDiveStop,
} from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { ago, clock, useNow, useWorkspaces } from "../lib/queries.ts";
import { useAgents } from "./agents.tsx";
import { AiError, AiLabel } from "./aiInference.tsx";
import { useScope } from "./scope.tsx";

// The AI researcher's deep dives (P1 wave 5, PRD §10.1 RESEARCH_DEEP_DIVE): start one, watch it live, read its report.
// Every claim carries the evidence NEXUS checked on the page it fetched itself; the summary is AI inference.

const route = getRouteApi("/");
const LIVE_POLL_MS = 2_000;
const LIST_POLL_MS = 30_000;

export const field =
  "min-w-0 rounded-xl border border-hair bg-card px-3 py-2 text-[13px] text-ink placeholder:text-ink3";
export const ghostBtn =
  "rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink disabled:opacity-45";
export const primaryBtn =
  "rounded-xl bg-teal px-4 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60";

/** A refresh failed while older data is shown: say so, with its time. */
export function Stale({ query }: { query: { error: Error | null; data: unknown; dataUpdatedAt: number } }) {
  if (!query.error || query.data === undefined) return null;
  return (
    <p role="status" className="m-0 text-[12.5px] leading-normal text-amber">
      Can&apos;t refresh: {query.error.message} Showing what NEXUS had at{" "}
      {clock(new Date(query.dataUpdatedAt).toISOString())}.
    </p>
  );
}

export function Pending({ error }: { error: Error | null }) {
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

const DEPTH: Record<DeepDiveDepth, string> = {
  QUICK: "Quick",
  STANDARD: "Standard",
  THOROUGH: "Thorough",
};
const depthMeans = (d: DeepDiveDepth) =>
  `up to ${DEEP_DIVE_DEPTH_LIMITS[d].maxSearches} web searches and ${DEEP_DIVE_DEPTH_LIMITS[d].maxFetches} page reads`;

const STATUS: Record<DeepDiveStatus, { text: string; tone: string }> = {
  QUEUED: { text: "Queued", tone: "var(--ink3)" },
  RUNNING: { text: "Running", tone: "var(--teal)" },
  COMPLETED: { text: "Completed", tone: "var(--green)" },
  FAILED: { text: "Failed", tone: "var(--coral)" },
  CANCELLED: { text: "Cancelled", tone: "var(--ink3)" },
};
const live = (s: DeepDiveStatus | undefined) => s === "QUEUED" || s === "RUNNING";

const STOP: Record<DeepDiveStop, string> = {
  COST: "the cost cap",
  TURNS: "the model-turn limit",
  SEARCHES: "the search limit",
  FETCHES: "the page-read limit",
  TIME: "the 15-minute time limit",
};

// FR-RES-06: only a verified quote earns more than "unverified"; the text says it, the colour only repeats it.
const CLAIM: Record<ClaimLabel, { text: string; tone: string }> = {
  PRIMARY: { text: "Primary source", tone: "var(--green)" },
  CORROBORATED: { text: "Corroborated", tone: "var(--teal)" },
  UNVERIFIED: { text: "Unverified", tone: "var(--amber)" },
  CONTESTED: { text: "Contested", tone: "var(--coral)" },
};

const STEP_KIND: Record<DeepDiveStep["kind"], string> = {
  SEARCH: "Search",
  FETCH: "Read page",
  MODEL: "Model",
};
const STEP_OUTCOME: Record<DeepDiveStep["outcome"], { text: string; tone: string }> = {
  OK: { text: "ok", tone: "var(--green)" },
  SKIPPED: { text: "skipped", tone: "var(--ink3)" },
  BLOCKED: { text: "blocked", tone: "var(--coral)" },
  ERROR: { text: "error", tone: "var(--coral)" },
};

const https = (url: string) => url.startsWith("https://");
const money = (n: number) => `$${n.toFixed(2)}`;

function Tag({ tone, children }: { tone: string; children: string }) {
  return (
    <span className="kicker inline-flex items-center gap-1.5" style={{ color: tone }}>
      <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: tone }} />
      {children}
    </span>
  );
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium break-all text-teal underline"
    >
      {children}
      <span className="sr-only">, opens in a new tab</span>
    </a>
  );
}

export type SeedFinding = { id: string; title: string };

/**
 * The Deep dives tab. `projectId` undefined = the read-only All view; `blocked` says why nothing can start here.
 * `seed` holds the findings the owner picked on the Findings tab ("Investigate selected findings").
 */
export function DeepDivesPanel({
  projectId,
  blocked,
  seed,
  onSeedChange,
  focusId,
  onFocus,
}: {
  projectId: string | undefined;
  blocked: string | null;
  seed: readonly SeedFinding[];
  onSeedChange: (seed: SeedFinding[]) => void;
  focusId: string | null;
  onFocus: (id: string) => void;
}) {
  const scope = useScope();
  const list = useQuery({
    queryKey: keys.deepDivesOf(projectId),
    queryFn: () => api.deepDives(projectId),
    enabled: scope.ready,
    // Live while anything runs: steps and status stream in every 2 s.
    refetchInterval: (q) => (q.state.data?.items.some((d) => live(d.status)) ? LIVE_POLL_MS : LIST_POLL_MS),
  });
  const items = list.data?.items ?? [];
  const current = focusId ?? items[0]?.id ?? null;
  return (
    <div className="flex flex-col gap-6">
      <SearchProviderBanner />
      {blocked || !projectId ? (
        <p className="m-0 text-[12.5px] leading-snug text-ink2">{blocked}</p>
      ) : (
        <StartDeepDive projectId={projectId} seed={seed} onSeedChange={onSeedChange} onStarted={onFocus} />
      )}
      <section aria-labelledby="dd-list" className="flex flex-col gap-3">
        <h3 id="dd-list" className="kicker m-0">
          Deep dives{projectId ? "" : " · all projects, read-only"}
        </h3>
        <Stale query={list} />
        {!list.data ? (
          <Pending error={list.error} />
        ) : items.length === 0 ? (
          <p className="m-0 text-[14px] leading-relaxed text-ink2">
            No deep dives yet.{" "}
            {projectId && !blocked
              ? "Ask the AI researcher a question above."
              : "Pick a project to start one."}
          </p>
        ) : (
          <ul aria-label="Deep dives" className="m-0 flex list-none flex-col gap-2 p-0">
            {items.map((d) => (
              <DiveItem
                key={d.id}
                d={d}
                showProject={!projectId}
                selected={d.id === current}
                onSelect={() => onFocus(d.id)}
              />
            ))}
          </ul>
        )}
      </section>
      {current && <DiveDetail key={current} id={current} readOnly={!projectId || !!blocked} />}
    </div>
  );
}

function SearchProviderBanner() {
  const status = useQuery({ queryKey: keys.searchProvider, queryFn: api.searchProvider });
  if (status.data?.configured !== false) return null;
  return (
    <div role="status" className="flex flex-col gap-1 rounded-xl bg-hair px-3 py-2.5">
      <span className="text-[13px] font-medium text-ink">Web search isn&apos;t set up</span>
      <span className="text-[12.5px] leading-snug text-ink2">
        {status.data.reason} Until it is, a deep dive can only read the findings you select. Set it up on the
        home machine: <span className="font-mono">{status.data.runbook}</span>.
      </span>
    </div>
  );
}

const PROBLEM: Record<string, string> = {
  question: "Ask a question of at least 10 characters (up to 2000).",
  maxCostUsd: "The cost cap must be more than $0 and at most $50.",
  findingIds: "Pick at most 10 findings to investigate.",
};

function StartDeepDive({
  projectId,
  seed,
  onSeedChange,
  onStarted,
}: {
  projectId: string;
  seed: readonly SeedFinding[];
  onSeedChange: (seed: SeedFinding[]) => void;
  onStarted: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const hintId = useId();
  const agents = useAgents(projectId);
  const profile = agents.data?.find((a) => a.agent === "AI_RESEARCHER")?.effective.settings;
  const [question, setQuestion] = useState("");
  const [depth, setDepth] = useState<DeepDiveDepth>("STANDARD");
  // Prefilled with the researcher's cap once its profile loads; the dive uses the lower of the two anyway.
  const [cap, setCap] = useState<string | null>(null);
  const capValue = cap ?? (profile ? String(profile.maxCostUsdPerTask) : "");
  const [problem, setProblem] = useState<string | null>(null);
  // One Idempotency-Key per request: resubmitting the same request after a failure can't start (or pay for) two.
  const [attempt, setAttempt] = useState<{ body: string; key: string } | null>(null);
  const create = useMutation({
    mutationFn: (a: { body: CreateDeepDiveRequest; key: string }) => api.createDeepDive(a.body, a.key),
    onSuccess: (d) => {
      setAttempt(null);
      setQuestion("");
      onSeedChange([]);
      void queryClient.invalidateQueries({ queryKey: keys.deepDivesOf(projectId) });
      void queryClient.invalidateQueries({ queryKey: keys.homeAll });
      onStarted(d.id);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const parsed = CreateDeepDiveRequest.safeParse({
      projectId,
      question,
      depth,
      findingIds: seed.map((f) => f.id),
      maxCostUsd: capValue.trim() === "" ? Number.NaN : Number(capValue),
    });
    if (!parsed.success)
      return setProblem(PROBLEM[String(parsed.error.issues[0]!.path[0])] ?? parsed.error.issues[0]!.message);
    setProblem(null);
    const body = JSON.stringify(parsed.data);
    const a = attempt?.body === body ? attempt : { body, key: crypto.randomUUID() };
    setAttempt(a);
    create.mutate({ body: parsed.data, key: a.key });
  };

  return (
    <form
      aria-label="Start a deep dive"
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3 rounded-2xl border border-hair p-4 text-[12.5px] text-ink2"
    >
      <p className="m-0 leading-normal">
        The AI researcher searches the public web, reads pages, and checks every quote it cites against the
        page NEXUS fetched. It writes nothing outside NEXUS.
      </p>
      <label className="flex flex-col gap-1.5">
        Question
        <textarea
          name="question"
          rows={3}
          maxLength={2000}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Which checkout changes reduce cart abandonment for small shops?"
          className={field}
        />
      </label>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1.5 p-0">Depth</legend>
        {(Object.keys(DEPTH) as DeepDiveDepth[]).map((d) => (
          <label key={d} className="flex items-center gap-2">
            <input type="radio" name="depth" value={d} checked={depth === d} onChange={() => setDepth(d)} />
            <span>
              <span className="font-medium text-ink">{DEPTH[d]}</span>: {depthMeans(d)}
            </span>
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1.5">
        Cost cap (USD)
        <input
          name="maxCostUsd"
          type="number"
          inputMode="decimal"
          min={0.01}
          max={50}
          step={0.01}
          value={capValue}
          onChange={(e) => setCap(e.target.value)}
          aria-describedby={hintId}
          className={`${field} w-32`}
        />
      </label>
      <span id={hintId} className="leading-snug text-ink3">
        {profile
          ? `The AI researcher's profile caps a task at $${profile.maxCostUsdPerTask} and ${profile.maxTurns} model turns; the dive uses the lower cap. It is reserved against today's budget when it starts.`
          : agents.error
            ? `Can't read the AI researcher's profile: ${agents.error.message}`
            : "Reading the AI researcher's profile…"}
      </span>
      {seed.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span>
            Investigating {seed.length} selected {seed.length === 1 ? "finding" : "findings"}: their sources
            are read first.
          </span>
          <ul aria-label="Selected findings" className="m-0 flex list-none flex-col gap-1 p-0">
            {seed.map((f) => (
              <li key={f.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-ink">{f.title}</span>
                <button
                  type="button"
                  onClick={() => onSeedChange(seed.filter((x) => x.id !== f.id))}
                  className="text-[12px] font-medium text-teal underline"
                >
                  Remove<span className="sr-only">, {f.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {problem && (
        <p role="alert" className="m-0 text-[13px] text-coral">
          {problem}
        </p>
      )}
      {!problem && create.error && <AiError error={create.error} />}
      <button type="submit" disabled={create.isPending} className={`${primaryBtn} self-start`}>
        {create.isPending ? "Starting…" : "Start deep dive"}
      </button>
    </form>
  );
}

function DiveItem({
  d,
  showProject,
  selected,
  onSelect,
}: {
  d: DeepDive;
  showProject: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const now = useNow(30_000);
  const workspaces = useWorkspaces();
  const project = showProject
    ? (workspaces.data?.items.flatMap((w) => w.projects).find((p) => p.id === d.projectId)?.name ??
      "another project")
    : null;
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={`flex w-full flex-col gap-1.5 rounded-2xl border px-4 py-3 text-left ${selected ? "border-teal" : "border-hair"}`}
      >
        <Tag tone={STATUS[d.status].tone}>{STATUS[d.status].text}</Tag>
        <span className="line-clamp-2 text-[14px] leading-[1.35] font-medium text-ink">{d.question}</span>
        <span className="font-mono text-[11.5px] text-ink2">
          {project && `${project} · `}
          {DEPTH[d.depth].toLowerCase()} · {money(d.usage.costUsd)} of {money(d.limits.maxCostUsd)} · started{" "}
          {ago(d.startedAt ?? d.createdAt, now)}
        </span>
        <span className="sr-only">{selected ? ", shown below" : ", show it"}</span>
      </button>
    </li>
  );
}

function DiveDetail({ id, readOnly }: { id: string; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: keys.deepDive(id),
    queryFn: () => api.deepDive(id),
    refetchInterval: (query) => (live(query.state.data?.status) ? LIVE_POLL_MS : false),
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelDeepDive(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.research }),
  });
  const d = q.data;
  return (
    <section aria-labelledby="dd-detail" className="flex flex-col gap-4">
      <h3 id="dd-detail" className="kicker m-0">
        Deep dive
      </h3>
      <Stale query={q} />
      {!d ? (
        <Pending error={q.error} />
      ) : (
        <>
          <p className="m-0 text-[15px] leading-[1.4] font-medium text-ink">{d.question}</p>
          <p role="status" className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1">
            <Tag tone={STATUS[d.status].tone}>{STATUS[d.status].text}</Tag>
            <span className="font-mono text-[11.5px] leading-[1.5] text-ink2">
              {DEPTH[d.depth].toLowerCase()} · cost {money(d.usage.costUsd)} of {money(d.limits.maxCostUsd)} ·{" "}
              {d.usage.searches}/{d.limits.maxSearches} searches · {d.usage.fetches}/{d.limits.maxFetches}{" "}
              page reads · {d.usage.turns}/{d.limits.maxTurns} turns
            </span>
          </p>
          {d.stoppedBy && (
            <p className="m-0 text-[12.5px] leading-snug text-ink2">
              Stopped at {STOP[d.stoppedBy]}; the report is written from what was gathered by then.
            </p>
          )}
          {d.error && <p className="m-0 text-[13px] leading-snug text-coral">{d.error}</p>}
          {live(d.status) && !readOnly && (
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
                className={`${ghostBtn} self-start`}
              >
                {cancel.isPending ? "Cancelling…" : "Cancel deep dive"}
              </button>
              {cancel.error && (
                <p role="alert" className="m-0 text-[13px] text-coral">
                  {cancel.error.message}
                </p>
              )}
            </div>
          )}
          {d.report ? (
            <Report d={d} report={d.report} />
          ) : (
            live(d.status) && (
              <p className="m-0 text-[14px] text-ink2">
                Researching. The report appears here when the dive finishes.
              </p>
            )
          )}
          <Steps steps={d.steps} />
        </>
      )}
    </section>
  );
}

function Steps({ steps }: { steps: DeepDiveStep[] }) {
  return (
    <details open className="text-[12.5px] text-ink2">
      <summary className="cursor-pointer font-medium text-ink">Step log · {steps.length} steps</summary>
      {steps.length === 0 ? (
        <p className="m-0 mt-2">No steps yet.</p>
      ) : (
        <ol aria-label="Step log" className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
          {steps.map((s) => (
            <li key={s.index} className="flex flex-col gap-0.5 break-words">
              <span>
                <span className="font-mono text-[11px] text-ink3">{clock(s.at)}</span>{" "}
                <span className="font-medium text-ink">{STEP_KIND[s.kind]}</span> ·{" "}
                <span style={{ color: STEP_OUTCOME[s.outcome].tone }}>{STEP_OUTCOME[s.outcome].text}</span> ·{" "}
                {/* Untrusted text: a link only for a page NEXUS read itself. */}
                {s.kind === "FETCH" && s.outcome === "OK" && https(s.detail) ? (
                  <ExternalLink href={s.detail}>{s.detail}</ExternalLink>
                ) : (
                  s.detail
                )}
              </span>
              {s.note && <span className="text-ink3">{s.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

function Report({ d, report }: { d: DeepDiveDetail; report: NonNullable<DeepDiveDetail["report"]> }) {
  const ref = (ids: number[]) => ids.map((i) => `[${i}]`).join(", ");
  return (
    <section aria-label="Report" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5 rounded-xl bg-hair px-3 py-2.5 text-[13px] leading-normal text-ink2">
        <AiLabel confidence={report.confidence} model={d.model} />
        <p className="m-0 break-words whitespace-pre-wrap text-ink">{report.summary}</p>
      </div>
      {report.opportunity && d.status === "COMPLETED" && (
        <OpportunityLink opportunityId={d.opportunityId} title={report.opportunity.title} />
      )}
      <div className="flex flex-col gap-2">
        <h4 className="kicker m-0">Claims · checked against the pages NEXUS read</h4>
        {report.claims.length === 0 ? (
          <p className="m-0 text-[13px] text-ink2">The report makes no claims.</p>
        ) : (
          <ol aria-label="Claims" className="m-0 flex list-none flex-col gap-2.5 p-0">
            {report.claims.map((c) => (
              <ClaimItem key={c.id} c={c} />
            ))}
          </ol>
        )}
      </div>
      {report.contradictions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="kicker m-0">Contradictions</h4>
          <ul
            aria-label="Contradictions"
            className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-ink2"
          >
            {report.contradictions.map((x) => (
              <li key={x.claimIds.join(",")} className="break-words">
                <span className="font-medium text-ink">Claims {ref(x.claimIds)} disagree:</span> {x.note}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.openQuestions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="kicker m-0">Open questions</h4>
          <ul
            aria-label="Open questions"
            className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink2"
          >
            {report.openQuestions.map((oq) => (
              <li key={oq} className="break-words">
                {oq}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ClaimItem({ c }: { c: Claim }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-2xl border border-hair px-4 py-3">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[11px] text-ink3">[{c.id}]</span>
        <Tag tone={CLAIM[c.label].tone}>{CLAIM[c.label].text}</Tag>
        <span className="font-mono text-[11px] text-ink3">
          {c.basis === "OBSERVED" ? "stated by its sources" : "AI inference: the researcher's reasoning"}
        </span>
      </span>
      <span className="text-[14px] leading-[1.4] break-words text-ink">{c.text}</span>
      {c.evidence.length === 0 ? (
        <span className="text-[12.5px] text-ink3">No quoted evidence.</span>
      ) : (
        <ul aria-label={`Evidence for claim ${c.id}`} className="m-0 flex list-none flex-col gap-2 p-0">
          {c.evidence.map((e, i) => (
            <li key={`${e.url}:${i}`} className="flex flex-col gap-1 text-[12.5px] text-ink2">
              <blockquote className="m-0 border-l-2 border-hair pl-3 leading-normal break-words">
                “{e.quote}”
              </blockquote>
              <span className="flex flex-wrap items-center gap-x-2">
                {e.verified ? (
                  <span className="font-medium text-green">✓ found on page</span>
                ) : (
                  <span className="font-medium text-amber">not found on page</span>
                )}
                <span aria-hidden="true">·</span>
                {https(e.url) ? <ExternalLink href={e.url}>{e.publisher}</ExternalLink> : e.publisher}
                <span>· {e.tier.toLowerCase()}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** The opportunity NEXUS recorded from this dive (only when its claims have verified evidence). */
function OpportunityLink({ opportunityId, title }: { opportunityId: string | null; title: string }) {
  const navigate = route.useNavigate();
  const { keep } = useScope();
  if (!opportunityId)
    return (
      <p className="m-0 text-[12.5px] leading-snug text-ink2">
        The researcher drafted an opportunity (“{title}”), but NEXUS records one only when its claims have
        verified evidence on the page.
      </p>
    );
  return (
    <button
      type="button"
      onClick={() => void navigate({ search: { ...keep, drawer: `opp:${opportunityId}` } })}
      className="self-start text-[13px] font-medium text-teal underline"
    >
      Opportunity noticed → {title}
    </button>
  );
}
