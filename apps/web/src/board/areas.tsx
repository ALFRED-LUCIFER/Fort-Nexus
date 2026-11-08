import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { Runner } from "@nexus/contracts";
import {
  preferredRunner,
  useGithubStatus,
  useQueuedJobs,
  useRecentJobs,
  useRepositories,
  useRunners,
} from "../lib/queries.ts";
import type { Area } from "../router.tsx";
import { AgentsByAgent, AgentsZone, useAgents } from "./agents.tsx";
import { BUSINESS_AGENTS } from "./agentLabels.ts";
import { BusinessZone, bizSub, useConnectors } from "./business.tsx";
import { useHome } from "./home.tsx";
import { AppNodes, appsSub, useMonitoredApps } from "./monitoring.tsx";
import { PlansZone, plansSub, usePlans } from "./plans.tsx";
import { ResearchZone, researchSub, useWatchlists } from "./research.tsx";
import { useScope } from "./scope.tsx";
import { CodeZone, SystemsZone } from "./zones.tsx";

// The areas (PRD §D.3): the sidebar lists them with one live status line each; each one is a page in the middle
// column (`area=`), and Today is the page without `area`. They replace the zoomable board's zones.

export type AreaId = Exclude<Area, "list">;
export type AreaKey = AreaId | "today";

export interface AreaInfo {
  id: AreaKey;
  label: string;
  /** The sidebar's status line: short, live, in words. */
  line: string;
  /** Set when the line needs the owner (an open incident): the dot's colour, always next to the words. */
  alert?: string;
  /** Today's count of decisions waiting. */
  count?: number;
  /** The page's subtitle (longer than `line`) and title band tint. */
  sub: string;
  tint: string;
  /** The workspace the area belongs to: hidden with it ("Dev only"). */
  ws?: "dev" | "business";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function codeSub(repos: number | undefined, total: number | undefined, running: number | undefined) {
  const parts = repos === undefined ? [] : [plural(repos, "repo")];
  if (total !== undefined)
    parts.push(total === 0 ? "no runs yet" : `${plural(total, "recent run")} · ${running ?? 0} running`);
  return parts.join(" · ");
}

function sysSub(runners: readonly Runner[] | undefined) {
  if (!runners) return "";
  const active = runners.filter((r) => r.status !== "REVOKED");
  if (!active.length) return "no runner paired";
  const on = active.filter((r) => r.status === "ONLINE").length;
  return `${plural(active.length, "runner")} · ${on} online`;
}

/** Every query the areas read, once: the sidebar's status lines and the area pages share them. */
export function useAreas() {
  const scope = useScope();
  const projectId = scope.project?.id;
  const runners = useRunners();
  const jobs = useRecentJobs(projectId, scope.ready);
  const queued = useQueuedJobs();
  const github = useGithubStatus();
  const repos = useRepositories(
    github.data?.configured === true && github.data.installations.length > 0 && scope.ready,
    projectId,
  );
  const connectors = useConnectors();
  const watchlists = useWatchlists();
  const apps = useMonitoredApps(projectId, scope.ready);
  const agents = useAgents(projectId);
  const plans = usePlans();
  const home = useHome();
  const hiddenAgents = scope.shown.business ? undefined : BUSINESS_AGENTS;

  const waiting = home.data?.headline.decisionsWaiting;
  const repoCount = repos.data?.items.length;
  const running = jobs.data?.items.filter((j) => j.status === "RUNNING").length;
  const incidents = apps.data?.filter((a) => a.openIncidentId).length ?? 0;
  const failing = apps.data?.some((a) => a.health === "DOWN" || a.health === "DEGRADED");
  const agentCount = agents.data?.filter((a) => !hiddenAgents?.has(a.agent)).length;
  const plansLine = [plansSub(plans.data), queued.data && queued.data !== "0" ? `${queued.data} queued` : ""]
    .filter(Boolean)
    .join(" · ");
  const systems = [appsSub(apps.data), sysSub(runners.data)].filter(Boolean).join(" · ");

  const all: AreaInfo[] = [
    {
      id: "today",
      label: "Today",
      line: waiting === undefined ? "" : waiting ? `${waiting} waiting on you` : "nothing waiting",
      count: waiting,
      sub: "",
      tint: "transparent",
    },
    {
      id: "code",
      ws: "dev",
      label: "Code",
      line:
        running === undefined
          ? repoCount === undefined
            ? ""
            : plural(repoCount, "repo")
          : [`${running} running`, repoCount === undefined ? "" : plural(repoCount, "repo")]
              .filter(Boolean)
              .join(" · "),
      sub: codeSub(repoCount, jobs.data?.items.length, running),
      tint: "oklch(0.80 0.06 195 / .16)",
    },
    {
      id: "systems",
      ws: "dev",
      label: "Systems",
      line: incidents
        ? plural(incidents, "open incident")
        : failing
          ? appsSub(apps.data)
          : sysSub(runners.data) || appsSub(apps.data),
      alert: incidents ? "var(--coral)" : failing ? "var(--amber)" : undefined,
      sub: systems,
      tint: "oklch(0.80 0.07 32 / .14)",
    },
    {
      id: "business",
      ws: "business",
      label: "Business",
      line: bizSub(connectors.data),
      sub: bizSub(connectors.data),
      tint: "oklch(0.85 0.07 70 / .18)",
    },
    {
      id: "research",
      label: "Research",
      line: researchSub(watchlists.data),
      sub: researchSub(watchlists.data),
      tint: "oklch(0.80 0.05 290 / .14)",
    },
    {
      id: "agents",
      label: "Agents",
      line: agentCount === undefined ? (projectId ? "" : "pick a project") : plural(agentCount, "agent"),
      sub: agentCount === undefined ? "" : `${plural(agentCount, "agent")} · scoped tools`,
      tint: "oklch(0.80 0.06 155 / .14)",
    },
    {
      id: "plans",
      label: "Plans",
      line: plansLine,
      sub: plansLine,
      tint: "oklch(0.85 0.06 95 / .18)",
    },
  ];
  return {
    /** False until the workspaces are known: which areas exist depends on them ("Dev only"). */
    ready: scope.ready,
    list: all.filter((a) => !a.ws || scope.shown[a.ws]),
    runner: preferredRunner(runners.data),
    queries: { runners, jobs, queued, github, repos, watchlists, agents },
    hiddenAgents,
  };
}

export type Areas = ReturnType<typeof useAreas>;

/** The areas as links with their live status line: the sidebar, and the phone's Workspaces screen. */
export function AreaLinks({ areas, current }: { areas: Areas; current: AreaKey | "list" }) {
  const { keep } = useScope();
  // A neutral placeholder until the workspaces are known, never the areas of a workspace that may be hidden.
  if (!areas.ready)
    return (
      <div className="flex flex-col gap-0.5">
        <p role="status" className="sr-only">
          Loading areas…
        </p>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} aria-hidden="true" className="flex flex-col gap-1.5 px-3 py-2.5">
            <span className="h-[15px] w-20 rounded-md bg-hair" />
            <span className="h-[11px] w-28 rounded-md bg-hair" />
          </span>
        ))}
      </div>
    );
  return (
    <nav aria-label="Areas">
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {areas.list.map((a) => {
          const active = current === a.id;
          return (
            <li key={a.id}>
              <Link
                to="/"
                search={{ ...keep, area: a.id === "today" ? undefined : a.id }}
                activeOptions={{ exact: true }}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col gap-1 rounded-[14px] border px-3 py-2.5 no-underline transition-colors ${active ? "border-line bg-glass2 shadow-[0_1px_3px_rgba(0,0,0,.12)]" : "border-transparent hover:bg-hair"}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span
                    className={`text-[15px] leading-tight text-ink ${active ? "font-semibold" : "font-medium"}`}
                  >
                    {a.label}
                  </span>
                  {!!a.count && (
                    <span
                      aria-hidden="true"
                      className="min-w-[20px] rounded-full bg-amber px-1.5 py-[3px] text-center font-mono text-[11px] leading-none text-onacc"
                    >
                      {a.count}
                    </span>
                  )}
                </span>
                {a.line && (
                  <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] leading-snug text-ink2">
                    {a.alert && (
                      <span
                        aria-hidden="true"
                        className="size-2 flex-none rounded-full"
                        style={{ background: a.alert }}
                      />
                    )}
                    <span className={`truncate ${a.alert ? "font-medium text-ink" : ""}`}>{a.line}</span>
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** One area's page: a serif title on the area's tint, its subtitle, then everything in it (no item limits). */
export function AreaPage({
  area,
  areas,
  open,
}: {
  area: AreaId;
  areas: Areas;
  /** Opens a drawer over the page (`drawer=` value). */
  open: (drawer: string) => void;
}) {
  const scope = useScope();
  const info = areas.list.find((a) => a.id === area);
  const q = areas.queries;
  const body: Record<AreaId, () => ReactNode> = {
    code: () => (
      <CodeZone
        projectName={scope.project?.name}
        github={q.github}
        repos={q.repos}
        query={q.jobs}
        runners={q.runners.data}
        onOpen={(id) => open(`run:${id}`)}
        onOpenRepo={(id) => open(`repo:${id}`)}
      />
    ),
    systems: () => (
      <SystemsZone query={q.runners}>
        <AppNodes onOpenIncident={(id) => open(`incident:${id}`)} onOpenSystems={() => open("systems")} />
      </SystemsZone>
    ),
    business: () => <BusinessZone onOpen={() => open("business")} />,
    research: () => <ResearchZone watchlists={q.watchlists} onOpen={() => open("research")} />,
    agents: () => (
      <AgentsArea
        query={q.agents}
        projectId={scope.project?.id}
        onOpen={(k) => open(`agent:${k}`)}
        hide={areas.hiddenAgents}
      />
    ),
    plans: () => <PlansZone onOpen={(id) => open(`plan:${id}`)} />,
  };
  return (
    <div className="flex flex-col gap-6 pb-6">
      <div className="rounded-[28px] border border-hair px-6 py-5" style={{ background: info?.tint }}>
        <h2 className="m-0 font-serif text-[clamp(34px,4vw,48px)] leading-none font-normal">{info?.label}</h2>
        {info?.sub && <p className="m-0 mt-2.5 font-mono text-[12px] leading-snug text-ink2">{info.sub}</p>}
      </div>
      {body[area]()}
    </div>
  );
}

const seg = (on: boolean) =>
  `rounded-[9px] px-[11px] py-[9px] text-[12px] font-medium leading-none whitespace-nowrap ${on ? "bg-glass2 text-ink shadow-[0_1px_3px_rgba(0,0,0,.12)]" : "text-ink2"}`;

/** The Agents page: the agents' cards, or "By agent" with each one's autonomy and tools. */
function AgentsArea(props: Parameters<typeof AgentsZone>[0]) {
  const [by, setBy] = useState<"cards" | "agent">("cards");
  return (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label="Show agents" className="flex self-start rounded-xl bg-hair p-[3px]">
        {(["cards", "agent"] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={by === v}
            onClick={() => setBy(v)}
            className={seg(by === v)}
          >
            {v === "cards" ? "Cards" : "By agent"}
          </button>
        ))}
      </div>
      {by === "cards" ? <AgentsZone {...props} /> : <AgentsByAgent {...props} />}
    </div>
  );
}
