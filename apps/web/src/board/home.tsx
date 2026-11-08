import type { ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { m, useReducedMotion, type Variants } from "motion/react";
import {
  HomeResultKind,
  RunStage,
  type AgentKey,
  type HomeAgentActivity,
  type HomeDecisions,
  type HomeExecution,
  type HomeRef,
  type HomeResult,
  type HomeSummary,
} from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { ago, clock, statusLabel, until, useNow, useSetup } from "../lib/queries.ts";
import { AGENT_LABEL, BUSINESS_AGENTS } from "./agentLabels.ts";
import { BusinessZone } from "./business.tsx";
import { KpiCards } from "./home/kpis.tsx";
import { NoticedZone, useOpportunities } from "./opportunities.tsx";
import { RepoAttention } from "./repos.tsx";
import { SetupSteps, setupMeta } from "./setup.tsx";
import { useScope } from "./scope.tsx";

// Today (PRD §D.4, the Cofounder home): the landing page, one read of the owner's day from GET /v1/home. Every number
// and sentence comes from NEXUS's own records (assembled by the server, not a model); costs are estimates. Rows open
// drawers; nothing here writes except what the reused opportunity cards already do, and approvals stay in drawers.

const route = getRouteApi("/");
const POLL_MS = 30_000;
const EASE = [0.2, 0.8, 0.2, 1] as const;
const OFFLINE = "You're offline. NEXUS will load your cofounder’s read when the connection is back.";

const STAGGER: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
};
const RISE: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
};

const card = "rounded-[20px] border border-line bg-card p-[18px] shadow-nx";
const rowBtn = "rounded-[14px] text-left transition-shadow hover:shadow-[0_0_0_2px_var(--teal)]";

// What waits on the owner: a pending push approval arrives as its JOB (the run drawer holds the approval).
const WAITING_KIND: Record<HomeRef["kind"], string> = {
  JOB: "Push approval",
  PLAN: "Plan",
  JOB_DRAFT: "Job draft",
  OPPORTUNITY: "Opportunity",
  DEEP_DIVE: "Deep dive",
  INCIDENT: "Incident",
};
const REF_DRAWER: Record<HomeRef["kind"], string> = {
  JOB: "run",
  PLAN: "plan",
  OPPORTUNITY: "opp",
  DEEP_DIVE: "research",
  JOB_DRAFT: "jobdraft",
  INCIDENT: "incident",
};
const drawerOf = (ref: HomeRef) => `${REF_DRAWER[ref.kind]}:${ref.id}`;

const INITIALS: Record<AgentKey, string> = {
  CHIEF_OF_STAFF: "CS",
  DEVELOPER: "DV",
  QA: "QA",
  DEVOPS: "DO",
  PRODUCT: "PM",
  AI_RESEARCHER: "AR",
  FINANCIAL_ANALYST: "FA",
};
const AGENT_STATE: Record<HomeAgentActivity["state"], { text: string; tone: string; live?: boolean }> = {
  WORKING: { text: "working", tone: "var(--teal)", live: true },
  WAITING_ON_YOU: { text: "waiting on you", tone: "var(--amber)" },
  IDLE: { text: "idle", tone: "var(--ink3)" },
};

const STAGES = RunStage.options;
const STAGE_LABEL: Record<RunStage, string> = {
  qualify: "Qualify",
  plan: "Plan",
  implement: "Implement",
  test: "Test",
  review: "Review",
  publish: "Publish",
};

const money = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// `date` is a calendar date in the owner's timezone: format it as a date, never shift it through UTC.
const dateLine = (s: HomeSummary) =>
  `${new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${s.date}T00:00:00Z`))} · ${s.time} · your cofounder’s read`;

/** GET /v1/home for the current scope; the sidebar's Today count reads the same cached query. */
export function useHome() {
  const scope = useScope();
  const projectId = scope.project?.id;
  return useQuery({
    queryKey: keys.home(projectId),
    queryFn: () => api.home(projectId),
    enabled: scope.ready,
    refetchInterval: POLL_MS,
  });
}

export function TodayView() {
  const scope = useScope();
  const navigate = route.useNavigate();
  const reduced = useReducedMotion();
  const now = useNow(30_000);
  const home = useHome();
  const noticed = useOpportunities();
  const open = (drawer: string) => void navigate({ search: { ...scope.keep, drawer } });
  const openRef = (ref: HomeRef) => open(drawerOf(ref));
  const s = home.data;
  const setup = useSetup(scope.ready, scope.project?.id);
  const business = scope.ws === "business";
  // "Dev only": a hidden Business workspace hides its agents here too.
  const agents = s?.agents.filter((a) => scope.shown.business || !BUSINESS_AGENTS.has(a.agent)) ?? [];
  const readOnly = !scope.project || !!scope.project.archivedAt;
  // GET /v1/home without a project reads every project of the owner, whichever workspace is picked.
  const where = scope.project?.name ?? "all projects";

  return (
    <m.div
      variants={STAGGER}
      initial={reduced ? false : "hidden"}
      animate="show"
      className="flex flex-col gap-7 pb-6"
    >
      {setup.data && !setup.data.ready && (
        <Section id="home-setup" title="Before NEXUS can work" meta={setupMeta(setup.data)}>
          <SetupSteps status={setup.data} />
        </Section>
      )}

      <m.section variants={RISE} aria-labelledby="home-brief" className="flex flex-col gap-2.5 pt-1">
        {s ? (
          <>
            <p className="kicker m-0 tracking-[.1em] text-ink2">{dateLine(s)}</p>
            <h2
              id="home-brief"
              className="m-0 max-w-[820px] font-serif text-[clamp(22px,2.4vw,30px)] leading-[1.18] font-normal tracking-[-.005em] text-pretty"
            >
              {s.headline.segments.map((seg, i) =>
                seg.emphasis ? (
                  <em key={i} className="text-teal">
                    {seg.text}
                  </em>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </h2>
            <p className="m-0 font-mono text-[12px] leading-snug text-ink2">
              prepared {s.time} · {plural(s.headline.sources, "source")} ·{" "}
              {plural(s.headline.decisionsWaiting, "decision")} waiting on you
              {readOnly && ` · ${where} · read-only`}
            </p>
          </>
        ) : (
          <h2 id="home-brief" className="sr-only">
            Your cofounder’s read
          </h2>
        )}
        <ReadState q={home} />
      </m.section>

      {s && (
        <Section
          id="home-waiting"
          title="Waiting on you"
          meta={decisionsMeta(s.decisions)}
          empty={s.decisions.top.length ? undefined : "nothing right now"}
        >
          <Waiting top={s.decisions.top} now={now} onOpen={openRef} />
        </Section>
      )}

      {s && <RunningNow runs={s.execution} agents={agents} now={now} onOpen={open} onOpenRef={openRef} />}

      {/* These two read the scope themselves: they wait for it, rather than show "all installed" first. */}
      {scope.ready && !business && (
        <Section
          id="home-repos"
          title={scope.project ? `Your repositories · ${scope.project.name}` : "Repositories · all installed"}
          meta="failing CI and pull requests to review first · GitHub"
        >
          <RepoAttention onOpenAll={() => open("repos")} />
        </Section>
      )}

      {scope.ready && (
        <Section
          id="home-noticed"
          title="Noticed for you"
          meta="ranked by confidence, then verified evidence · impact is est."
          empty={
            noticed.data?.length === 0
              ? "nothing yet: a deep dive turns what it verifies into cards here"
              : undefined
          }
        >
          {/* The cards keep their width: the row scrolls sideways inside itself rather than squeezing them. */}
          <div className="overflow-x-auto pb-1">
            <NoticedZone onOpen={(id, focus) => open(`opp:${id}${focus ? `:${focus}` : ""}`)} />
          </div>
        </Section>
      )}

      {(business || s) && (
        <Section
          id="home-kpis"
          title={`Live · ${where}`}
          meta={business ? "read-only business sources" : "7-day window · NEXUS’s own records"}
        >
          {business ? <BusinessZone onOpen={() => open("business")} /> : s && <KpiCards kpis={s.kpis} />}
        </Section>
      )}

      {s && (
        <Section
          id="home-results"
          title="Results this week"
          meta="last 7 days · from the source"
          empty={s.results.some((r) => r.value > 0) ? undefined : "nothing confirmed yet"}
        >
          <Results results={s.results} />
        </Section>
      )}
    </m.div>
  );
}

/** A headed section; with `empty` it shrinks to one line ("Waiting on you · nothing right now"). */
function Section({
  id,
  title,
  meta,
  empty,
  children,
}: {
  id: string;
  title: string;
  meta: string;
  empty?: string;
  children: ReactNode;
}) {
  if (empty !== undefined)
    return (
      <m.section
        variants={RISE}
        aria-labelledby={id}
        className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
      >
        <h2 id={id} className="kicker m-0 tracking-[.12em] text-ink2">
          {title}
        </h2>
        <p className="m-0 text-[13px] text-ink3">
          <span aria-hidden="true">· </span>
          {empty}
        </p>
      </m.section>
    );
  return (
    <m.section variants={RISE} aria-labelledby={id} className="flex min-w-0 flex-col gap-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2.5 gap-y-1">
        <h2 id={id} className="kicker m-0 tracking-[.12em] text-ink2">
          {title}
        </h2>
        <span className="font-mono text-[11px] text-ink3">{meta}</span>
      </div>
      {children}
    </m.section>
  );
}

/** Loading, error, offline and stale lines, like the rest of the app. */
function ReadState({ q }: { q: UseQueryResult<HomeSummary> }) {
  const offline = q.fetchStatus === "paused";
  if (!q.data)
    return q.error ? (
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="m-0 text-[14px] text-coral">
          {q.error.message}
        </p>
        <button
          type="button"
          onClick={() => void q.refetch()}
          className="rounded-xl border border-hair px-3 py-2 text-[12.5px] font-medium text-ink"
        >
          Try again
        </button>
      </div>
    ) : (
      <p role="status" className="m-0 text-[14px] text-ink3">
        {offline ? OFFLINE : "Loading your cofounder’s read…"}
      </p>
    );
  if (!q.error && !offline) return null;
  return (
    <p role="status" className="m-0 text-[12.5px] leading-normal text-amber">
      {offline ? "You're offline." : `Can't refresh: ${q.error!.message}`} Showing what NEXUS had at{" "}
      {clock(new Date(q.dataUpdatedAt).toISOString())}.
    </p>
  );
}

function decisionsMeta(d: HomeDecisions): string {
  const parts = [
    d.incidents && plural(d.incidents, "open incident"),
    d.approvals && plural(d.approvals, "approval"),
    d.plans && plural(d.plans, "plan"),
    d.jobDrafts && plural(d.jobDrafts, "job draft"),
    d.opportunities && plural(d.opportunities, "opportunity", "opportunities"),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "nothing waiting";
}

function Waiting({
  top,
  now,
  onOpen,
}: {
  top: HomeDecisions["top"];
  now: number;
  onOpen: (ref: HomeRef) => void;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {top.map((t) => {
        const left = t.expiresAt && until(t.expiresAt, now);
        return (
          <li key={`${t.ref.kind}:${t.ref.id}`}>
            <button
              type="button"
              onClick={() => onOpen(t.ref)}
              title={t.title}
              className={`${rowBtn} flex w-full flex-wrap items-center gap-x-3 gap-y-1 border border-line bg-card px-4 py-3 shadow-nx`}
            >
              <span className="kicker flex items-center gap-1.5 text-ink2">
                <span
                  aria-hidden="true"
                  className={`size-1.5 rounded-full ${t.ref.kind === "INCIDENT" ? "nx-pulse bg-coral" : "bg-amber"}`}
                />
                {WAITING_KIND[t.ref.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{t.title}</span>
              {left && (
                <span className="font-mono text-[11px] text-ink2">
                  {left === "passed" ? "expired" : `expires ${left}`}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function agentsMeta(agents: readonly HomeAgentActivity[]): string {
  const working = agents.filter((a) => a.state === "WORKING").length;
  const waiting = agents.filter((a) => a.state === "WAITING_ON_YOU").length;
  return `on your home machine · ${working} working · ${waiting} waiting on you`;
}

/**
 * The runs in flight with their stage bars, then the agents busy with something that isn't one of those runs; idle
 * agents fold into one line.
 */
function RunningNow({
  runs,
  agents,
  now,
  onOpen,
  onOpenRef,
}: {
  runs: readonly HomeExecution[];
  agents: readonly HomeAgentActivity[];
  now: number;
  onOpen: (drawer: string) => void;
  onOpenRef: (ref: HomeRef) => void;
}) {
  const runIds = new Set(runs.map((r) => r.jobId));
  const busy = agents.filter((a) => a.state !== "IDLE" && !(a.ref?.kind === "JOB" && runIds.has(a.ref.id)));
  const idle = agents.length - agents.filter((a) => a.state !== "IDLE").length;
  const idleLine = idle ? plural(idle, "agent") + " idle" : "";
  return (
    <Section
      id="home-running"
      title="Running now"
      meta={agentsMeta(agents)}
      empty={
        runs.length || busy.length ? undefined : ["nothing running", idleLine].filter(Boolean).join(" · ")
      }
    >
      <div className={`${card} flex flex-col gap-4`}>
        {runs.length > 0 && <Execution runs={runs} now={now} onOpen={(id) => onOpen(`run:${id}`)} />}
        {busy.length > 0 && <Agents agents={busy} onOpen={onOpen} onOpenRef={onOpenRef} />}
        {idleLine && <p className="m-0 font-mono text-[11.5px] text-ink3">{idleLine}</p>}
      </div>
    </Section>
  );
}

function Agents({
  agents,
  onOpen,
  onOpenRef,
}: {
  agents: readonly HomeAgentActivity[];
  onOpen: (drawer: string) => void;
  onOpenRef: (ref: HomeRef) => void;
}) {
  return (
    <ul aria-label="Agents at work" className="m-0 flex list-none flex-col gap-3 p-0">
      {agents.map((a) => {
        const st = AGENT_STATE[a.state];
        const ref = a.ref;
        return (
          <li key={a.agent} className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-3">
            <span
              aria-hidden="true"
              className="size-8 rounded-full text-center font-mono text-[11px] leading-8 text-violet"
              style={{ background: "color-mix(in oklch, var(--violet) 13%, transparent)" }}
            >
              {INITIALS[a.agent]}
            </span>
            <span className="flex min-w-0 flex-col items-start gap-[3px]">
              <button
                type="button"
                onClick={() => onOpen(`agent:${a.agent}`)}
                className="text-left text-[13px] leading-tight font-medium hover:underline"
              >
                {AGENT_LABEL[a.agent]}
              </button>
              {a.doing && ref ? (
                <button
                  type="button"
                  onClick={() => onOpenRef(ref)}
                  title={a.doing}
                  className="max-w-full truncate text-left text-[12px] text-ink2 hover:underline"
                >
                  {a.doing}
                </button>
              ) : (
                <span className="max-w-full truncate text-[12px] text-ink2" title={a.doing ?? undefined}>
                  {a.doing ?? "nothing right now"}
                </span>
              )}
            </span>
            <span className="flex flex-col items-end gap-1 font-mono text-[11px]">
              <span
                className={`flex items-center gap-1.5 ${a.state === "WAITING_ON_YOU" ? "font-medium text-ink" : "text-ink2"}`}
              >
                <span
                  aria-hidden="true"
                  className={`size-1.5 rounded-full ${st.live ? "nx-pulse" : ""}`}
                  style={{ background: st.tone }}
                />
                {st.text}
              </span>
              <span className="text-ink3">{money(a.costTodayUsd)} est. today</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Execution({
  runs,
  now,
  onOpen,
}: {
  runs: readonly HomeExecution[];
  now: number;
  onOpen: (jobId: string) => void;
}) {
  return (
    <ul aria-label="Runs" className="m-0 flex list-none flex-col gap-3 p-0">
      {runs.map((r) => {
        const at = r.stage ? STAGES.indexOf(r.stage) : -1;
        const seg = (i: number) =>
          i < at ? "var(--green)" : i === at ? (r.needsYou ? "var(--amber)" : "var(--teal)") : "var(--hair)";
        return (
          <li key={r.jobId}>
            <button
              type="button"
              onClick={() => onOpen(r.jobId)}
              className={`${rowBtn} flex w-full flex-col gap-2 p-1`}
            >
              <span className="flex w-full items-baseline justify-between gap-2.5">
                <span className="min-w-0 truncate text-[13px] font-medium" title={r.title}>
                  {r.title}
                </span>
                {r.needsYou && (
                  <span
                    className="kicker flex-none rounded-[6px] px-1.5 py-[3px] text-ink"
                    style={{ background: "color-mix(in oklch, var(--amber) 22%, transparent)" }}
                  >
                    needs you
                  </span>
                )}
              </span>
              <span aria-hidden="true" className="grid w-full grid-cols-6 gap-[3px]">
                {STAGES.map((st, i) => (
                  <span key={st} className="h-1 rounded-sm" style={{ background: seg(i) }} />
                ))}
              </span>
              <span className="font-mono text-[11px] leading-snug text-ink2">
                {r.stage ? `${STAGE_LABEL[r.stage]} · stage ${at + 1} of ${STAGES.length}` : "not started"} ·{" "}
                {AGENT_LABEL[r.agent]} · {statusLabel(r.status).toLowerCase()} · {ago(r.createdAt, now)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Results({ results }: { results: readonly HomeResult[] }) {
  const order = HomeResultKind.options;
  const sorted = results.toSorted((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return (
    <ul
      className={`${card} m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-3.5 gap-y-4`}
    >
      {sorted.map((r) => (
        <li key={r.kind} className="flex min-w-0 flex-col gap-1">
          <span className="font-serif text-[30px] leading-none">
            {r.kind === "AI_SPEND" ? (
              <>
                {money(r.value)}
                <span className="text-[14px] text-ink2"> est.</span>
              </>
            ) : (
              r.value
            )}
          </span>
          <span className="text-[12px] leading-snug font-medium text-ink2">{r.label}</span>
          <span className="font-mono text-[11px] leading-snug text-green">
            <span aria-hidden="true">✓ </span>
            <span className="sr-only">source: </span>
            {r.source}
          </span>
        </li>
      ))}
    </ul>
  );
}
