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
import { ago, clock, statusLabel, until, useNow } from "../lib/queries.ts";
import { AGENT_LABEL } from "./agentLabels.ts";
import { BusinessZone } from "./business.tsx";
import { CofounderPanel } from "./cofounder.tsx";
import { KpiCards } from "./home/kpis.tsx";
import { NoticedZone } from "./opportunities.tsx";
import { useScope } from "./scope.tsx";

// The Cofounder home (PRD §D.4): the landing view, one read of the owner's day from GET /v1/home. Every number and
// sentence comes from NEXUS's own records (assembled by the server, not a model); costs are estimates. Rows open the
// same drawers as the board; nothing here writes except what the reused opportunity cards already do.

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
};
const REF_DRAWER: Record<HomeRef["kind"], string> = {
  JOB: "run",
  PLAN: "plan",
  OPPORTUNITY: "opp",
  DEEP_DIVE: "research",
  JOB_DRAFT: "jobdraft",
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

export function HomeView() {
  const scope = useScope();
  const projectId = scope.project?.id;
  const navigate = route.useNavigate();
  const reduced = useReducedMotion();
  const now = useNow(30_000);
  const home = useQuery({
    queryKey: keys.home(projectId),
    queryFn: () => api.home(projectId),
    enabled: scope.ready,
    refetchInterval: POLL_MS,
  });
  const open = (drawer: string) => void navigate({ search: { ...scope.keep, drawer } });
  const openRef = (ref: HomeRef) => open(drawerOf(ref));
  const s = home.data;
  const business = scope.ws === "business";
  const readOnly = !scope.project || !!scope.project.archivedAt;
  // GET /v1/home without a project reads every project of the owner, whichever workspace is picked.
  const where = scope.project?.name ?? "all projects";

  return (
    <div className="absolute inset-x-0 top-[76px] bottom-[64px] overflow-y-auto">
      <div className="mx-auto flex max-w-[1560px] flex-col gap-5 px-4 pt-3 pb-6 lg:flex-row lg:items-start lg:px-6">
        <main aria-label="Home" className="min-w-0 flex-1">
          <m.div
            variants={STAGGER}
            initial={reduced ? false : "hidden"}
            animate="show"
            className="flex flex-col gap-7"
          >
            <m.section variants={RISE} aria-labelledby="home-brief" className="flex flex-col gap-3 pt-1">
              {s ? (
                <>
                  <p className="kicker m-0 tracking-[.1em] text-ink2">{dateLine(s)}</p>
                  <h2
                    id="home-brief"
                    className="m-0 max-w-[880px] font-serif text-[clamp(28px,3.4vw,44px)] leading-[1.12] font-normal tracking-[-.01em] text-pretty"
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

            {(business || s) && (
              <Section
                id="home-kpis"
                title={`Live · ${where}`}
                meta={business ? "read-only business sources" : "7-day window · NEXUS’s own records"}
              >
                {business ? (
                  <BusinessZone onOpen={() => open("business")} />
                ) : (
                  s && <KpiCards kpis={s.kpis} />
                )}
              </Section>
            )}

            {s && (
              <Section id="home-waiting" title="Waiting on you" meta={decisionsMeta(s.decisions)}>
                <Waiting top={s.decisions.top} now={now} onOpen={openRef} />
              </Section>
            )}

            <Section
              id="home-noticed"
              title="Your cofounder noticed"
              meta="ranked by confidence, then verified evidence · impact is est."
            >
              {/* The board's cards at their fixed width: the row scrolls sideways rather than squeezing them. */}
              <div className="overflow-x-auto pb-1">
                <NoticedZone onOpen={(id, focus) => open(`opp:${id}${focus ? `:${focus}` : ""}`)} />
              </div>
            </Section>

            {s && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(290px,1fr))] gap-3">
                <Section id="home-agents" title="Agent activity" meta={agentsMeta(s.agents)} className={card}>
                  <Agents agents={s.agents} onOpen={open} onOpenRef={openRef} />
                </Section>
                <Section id="home-execution" title="Execution" meta="on your home machine" className={card}>
                  <Execution runs={s.execution} now={now} onOpen={(id) => open(`run:${id}`)} />
                </Section>
                <Section
                  id="home-results"
                  title="Results · this week"
                  meta="last 7 days · from the source"
                  className={card}
                >
                  <Results results={s.results} />
                </Section>
              </div>
            )}
          </m.div>
        </main>
        <div className="flex h-[560px] flex-col lg:sticky lg:top-3 lg:h-[calc(100dvh-164px)] lg:w-[380px] lg:flex-none">
          <CofounderPanel projectId={projectId} />
        </div>
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  meta,
  className = "",
  children,
}: {
  id: string;
  title: string;
  meta: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <m.section variants={RISE} aria-labelledby={id} className={`flex min-w-0 flex-col gap-3.5 ${className}`}>
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
  if (!top.length) return <p className="m-0 text-[14px] text-ink3">Nothing waits on you right now.</p>;
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
                <span aria-hidden="true" className="size-1.5 rounded-full bg-amber" />
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
  return `${working} working · ${waiting} waiting on you`;
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
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
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
            <span className="flex flex-col items-end gap-1 font-mono text-[10.5px]">
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
  if (!runs.length) return <p className="m-0 text-[14px] text-ink3">Nothing running.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
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
    <ul className="m-0 grid list-none grid-cols-2 gap-x-3.5 gap-y-4 p-0">
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
          <span className="font-mono text-[10.5px] leading-snug text-green">
            <span aria-hidden="true">✓ </span>
            <span className="sr-only">source: </span>
            {r.source}
          </span>
        </li>
      ))}
    </ul>
  );
}
