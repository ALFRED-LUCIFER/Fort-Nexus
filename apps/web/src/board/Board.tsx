import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  AnimatePresence,
  animate,
  m,
  useMotionTemplate,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import { AgentKey, type Runner } from "@nexus/contracts";
import { authClient } from "../lib/auth.ts";
import { currentTheme, toggleTheme } from "../lib/theme.ts";
import {
  RUNNER_TONE,
  clock,
  preferredRunner,
  useGithubStatus,
  usePendingApprovals,
  useQueuedJobs,
  useRecentJobs,
  useRepositories,
  useRunners,
} from "../lib/queries.ts";
import { AgentDrawer, AgentsZone, agentLanes, useAgents } from "./agents.tsx";
import { CommandBar } from "./CommandBar.tsx";
import { StopButton, useStopBanner } from "./EmergencyStop.tsx";
import { P1Button } from "./P1Button.tsx";
import { BusinessDrawer, BusinessZone, bizSub, useConnectors } from "./business.tsx";
import { IssueDrawer, RepoDrawer } from "./github.tsx";
import { InboxDrawer } from "./Inbox.tsx";
import { HomeView } from "./home.tsx";
import { JobsDrawer } from "./jobs.tsx";
import { AppNodes, IncidentDrawer, SystemsDrawer, appsSub, useMonitoredApps } from "./monitoring.tsx";
import { JobDraftDrawer, NewJobDrawer } from "./newJob.tsx";
import { NotificationToasts, useScopeNotifications } from "./notifications.tsx";
import { NoticedZone, OpportunityDrawer, noticedSub, useOpportunities } from "./opportunities.tsx";
import { PlanDrawer, PlansZone, plansSub, usePlans } from "./plans.tsx";
import { ResearchDrawer, ResearchZone, researchSub, useWatchlists } from "./research.tsx";
import { RunDrawer } from "./RunDrawer.tsx";
import { ScopeNav, useScope } from "./scope.tsx";
import { BUSINESS_AGENTS } from "./agentLabels.ts";
import { RepositoriesDrawer } from "./repos.tsx";
import { SettingsDrawer, useOpenSettings } from "./Settings.tsx";
import { TalkDrawer } from "./Talk.tsx";
import { CodeZone, EmptyZone, SystemsZone, type ZoneProps } from "./zones.tsx";

const route = getRouteApi("/");
const BOARD_W = 2080;
const BOARD_H = 2340;
const MIN_Z = 0.22;
const MAX_Z = 1.8;
// The camera's glide to a zone or back to the overview; reduced motion jumps instead.
const GLIDE = { type: "spring", stiffness: 170, damping: 26, mass: 1 } as const;
// Screen space a focused zone keeps clear: the header above, the controls below.
const TOP = 84;
const BOTTOM = 76;
const PAD = 28;
// A press that moves further than this is a pan, not a click on the zone.
const CLICK_SLOP = 5;

type View = { x: number; y: number; z: number };
type Camera = { x: MotionValue<number>; y: MotionValue<number>; z: MotionValue<number> };

const viewOf = (c: Camera): View => ({ x: c.x.get(), y: c.y.get(), z: c.z.get() });
const jumpTo = (c: Camera, v: View) => {
  for (const k of ["x", "y", "z"] as const) {
    c[k].stop();
    c[k].set(v[k]);
  }
};
/** The whole board, centred under the header. */
function overviewOf(el: HTMLElement): View {
  const w = el.clientWidth;
  const h = el.clientHeight - 90;
  const z = Math.max(MIN_Z, Math.min(w / 2120, h / 2360));
  return { z, x: (w - BOARD_W * z) / 2, y: TOP + (h - BOARD_H * z) / 2 };
}
/** Zoom by `f` around the screen point (cx, cy), which stays put. */
function zoomedAt(v: View, f: number, cx: number, cy: number): View {
  const z = Math.min(MAX_Z, Math.max(MIN_Z, v.z * f));
  return { z, x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z };
}

type ZoneDef = Omit<ZoneProps, "dim" | "children"> & { ws?: "dev" | "business"; body: ReactNode };

const pillBtn = "rounded-xl px-2.5 py-2 text-[12.5px] font-medium text-ink2 whitespace-nowrap";
const seg = (on: boolean) =>
  `rounded-[9px] px-[11px] py-[9px] text-[12px] font-medium leading-none whitespace-nowrap ${on ? "bg-glass2 text-ink shadow-[0_1px_3px_rgba(0,0,0,.12)]" : "text-ink3"}`;

export function Board() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const scope = useScope();
  const ws = scope.ws;
  const projectId = scope.project?.id;
  // drawer = run:<jobId> | repo:<repoId> | issue:<repoId>:<number> (validated by BoardSearch).
  const [drawerKind, drawerId, drawerNumber] = search.drawer?.split(":") ?? [];

  const runners = useRunners();
  const jobs = useRecentJobs(projectId, scope.ready);
  const queued = useQueuedJobs();
  const runner = preferredRunner(runners.data);
  const github = useGithubStatus();
  const repos = useRepositories(
    github.data?.configured === true && github.data.installations.length > 0 && scope.ready,
    projectId,
  );
  const approvals = usePendingApprovals(projectId, scope.ready);
  const pending = approvals.data?.length;
  const connectors = useConnectors();
  const watchlists = useWatchlists();
  const unread = useScopeNotifications().unread ?? 0;
  const apps = useMonitoredApps(projectId, scope.ready);
  const agents = useAgents(projectId);
  const [group, setGroup] = useState<"domains" | "agents">("domains");
  // The Cofounder home is the landing view (PRD §D.4); the zone board stays one click away.
  const { defaultView } = route.useRouteContext();
  const view = search.view ?? defaultView;
  const onBoard = view === "board";
  const agentKey = AgentKey.safeParse(drawerId);
  const hiddenAgents = scope.shown.business ? undefined : BUSINESS_AGENTS;
  const openSettings = useOpenSettings();
  const plans = usePlans();
  const noticed = useOpportunities();

  const openRun = (id: string) => void navigate({ search: { ...scope.keep, drawer: `run:${id}` } });
  const openRepo = (id: string) => void navigate({ search: { ...scope.keep, drawer: `repo:${id}` } });
  const openResearch = () => void navigate({ search: { ...scope.keep, drawer: "research" } });
  const openIncident = (id: string) => void navigate({ search: { ...scope.keep, drawer: `incident:${id}` } });
  const openSystems = () => void navigate({ search: { ...scope.keep, drawer: "systems" } });
  const openAgent = (k: AgentKey) => void navigate({ search: { ...scope.keep, drawer: `agent:${k}` } });
  const openPlan = (id: string) => void navigate({ search: { ...scope.keep, drawer: `plan:${id}` } });
  const openOpportunity = (id: string, focus?: "preview") =>
    void navigate({ search: { ...scope.keep, drawer: `opp:${id}${focus ? `:${focus}` : ""}` } });
  const closeDrawer = () => void navigate({ search: scope.keep });

  // Pan / zoom. Positions are in screen px; the board is scaled around its top-left corner. Motion values, so a
  // glide animates the transform and the dot grid without re-rendering the board every frame.
  const vpRef = useRef<HTMLDivElement>(null);
  const vx = useMotionValue(40);
  const vy = useMotionValue(90);
  const vz = useMotionValue(0.62);
  const reduced = useReducedMotion();
  const [focused, setFocused] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const moved = useRef(false);
  const camera: Camera = { x: vx, y: vy, z: vz };
  const glide = (v: View) => {
    if (reduced) return jumpTo(camera, v);
    for (const k of ["x", "y", "z"] as const) void animate(camera[k], v[k], GLIDE);
  };
  const fit = () => {
    if (!vpRef.current) return;
    setFocused(null);
    glide(overviewOf(vpRef.current));
  };
  /** Flies the camera to one zone so it fills the screen (design: click a zone to work in it). */
  const focusZone = (zone: Pick<ZoneProps, "id" | "x" | "y" | "w" | "h">) => {
    const el = vpRef.current;
    if (!el) return;
    const w = el.clientWidth - 2 * PAD;
    const h = el.clientHeight - TOP - BOTTOM - 2 * PAD;
    const z = Math.max(MIN_Z, Math.min(MAX_Z, w / zone.w, h / zone.h));
    setFocused(zone.id);
    glide({
      z,
      x: PAD + (w - zone.w * z) / 2 - zone.x * z,
      y: TOP + PAD + (h - zone.h * z) / 2 - zone.y * z,
    });
  };
  const zoomBy = (f: number) => {
    const el = vpRef.current;
    glide(zoomedAt(viewOf(camera), f, (el?.clientWidth ?? 1200) / 2, (el?.clientHeight ?? 800) / 2));
  };
  useLayoutEffect(() => {
    if (onBoard && vpRef.current) jumpTo({ x: vx, y: vy, z: vz }, overviewOf(vpRef.current));
  }, [vx, vy, vz, onBoard]);
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const c = { x: vx, y: vy, z: vz };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      jumpTo(c, zoomedAt(viewOf(c), e.deltaY < 0 ? 1.08 : 0.926, e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [vx, vy, vz, onBoard]);
  // Esc leaves a focused zone, unless a drawer or a field has it (they close or clear themselves first).
  const hasDrawer = !!search.drawer;
  useEffect(() => {
    if (!focused || hasDrawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if ((e.target as Element | null)?.closest?.("input,textarea,select,[role=dialog]")) return;
      fit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const panStart = (e: PointerEvent) => {
    moved.current = false;
    if ((e.target as Element).closest("button,input,select,a,[data-nopan]")) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: vx.get(), vy: vy.get(), moved: false };
  };
  const panMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
    d.moved = moved.current = true;
    jumpTo(camera, { z: vz.get(), x: d.vx + dx, y: d.vy + dy });
  };
  const panEnd = () => {
    drag.current = null;
  };
  /** A click on a zone's empty area focuses it; a drag that started there was a pan. */
  const zoneClick = (zone: ZoneDef) => (e: MouseEvent) => {
    if (moved.current) return;
    if ((e.target as Element).closest("button,input,select,textarea,a,label,[data-nopan]")) return;
    if (focused !== zone.id) focusZone(zone);
  };
  const gridSize = useTransform(vz, (z) => `${22 * z}px ${22 * z}px`);
  const gridPos = useMotionTemplate`${vx}px ${vy}px`;

  const [theme, setTheme] = useState(currentTheme);
  const signOut = async () => {
    await authClient.signOut().catch(() => undefined);
    queryClient.clear();
    await navigate({ to: "/login" });
  };

  // Offline banner: only when no runner can take work right now.
  const offline =
    runners.data && !runners.data.some((r) => r.status === "ONLINE" || r.status === "STALE")
      ? runners.data.find((r) => r.status === "OFFLINE")
      : undefined;

  // One banner: inside the open drawer (a modal drawer hides the board), above the board otherwise.
  // An engaged emergency stop outranks everything else (design: killed before offline).
  const stopBanner = useStopBanner();
  const offlineBanner = offline && (
    <div
      role="status"
      className="pointer-events-auto flex items-center gap-3 rounded-2xl py-3 pr-3.5 pl-[18px] text-white shadow-nx"
      style={{ background: "oklch(0.45 0.03 70)" }}
    >
      <span aria-hidden="true" className="nx-pulse size-2 flex-none rounded-full bg-white" />
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="text-[13.5px] leading-snug font-medium">
          {offline.name} is offline. {queued.data ?? "Any"} queued{" "}
          {queued.data === "1" ? "job is" : "jobs are"} held, not lost.
        </span>
        <span className="font-mono text-[11.5px] opacity-85">
          last heartbeat {offline.lastHeartbeatAt ? clock(offline.lastHeartbeatAt) : "never"} · they start
          when it reconnects
        </span>
      </div>
    </div>
  );

  const banner = stopBanner ?? offlineBanner;

  const zones: ZoneDef[] = [
    {
      id: "opp",
      label: "Noticed for you",
      sub: noticedSub(noticed.data),
      x: 40,
      y: 40,
      w: 2000,
      h: 400,
      tint: "oklch(0.86 0.07 85 / .22)",
      body: <NoticedZone onOpen={openOpportunity} />,
    },
    {
      id: "code",
      ws: "dev",
      label: "Code",
      sub: codeSub(
        repos.data?.items.length,
        jobs.data?.items.length,
        jobs.data?.items.filter((j) => j.status === "RUNNING").length,
      ),
      x: 40,
      y: 480,
      w: 800,
      h: 640,
      tint: "oklch(0.80 0.06 195 / .16)",
      body: (
        <CodeZone
          projectName={scope.project?.name}
          github={github}
          repos={repos}
          query={jobs}
          runners={runners.data}
          onOpen={openRun}
          onOpenRepo={openRepo}
        />
      ),
    },
    {
      id: "biz",
      ws: "business",
      label: "Business",
      sub: bizSub(connectors.data),
      x: 880,
      y: 480,
      w: 540,
      h: 640,
      tint: "oklch(0.85 0.07 70 / .18)",
      body: <BusinessZone onOpen={() => void navigate({ search: { ...scope.keep, drawer: "business" } })} />,
    },
    {
      id: "sys",
      ws: "dev",
      label: "Systems",
      sub: [appsSub(apps.data), sysSub(runners.data)].filter(Boolean).join(" · "),
      x: 1460,
      y: 480,
      w: 580,
      h: 640,
      tint: "oklch(0.80 0.07 32 / .14)",
      body: (
        <SystemsZone query={runners}>
          <AppNodes onOpenIncident={openIncident} onOpenSystems={openSystems} />
        </SystemsZone>
      ),
    },
    {
      id: "res",
      label: "Research",
      sub: researchSub(watchlists.data),
      x: 40,
      y: 1160,
      w: 800,
      h: 580,
      tint: "oklch(0.80 0.05 290 / .14)",
      body: <ResearchZone watchlists={watchlists} onOpen={openResearch} />,
    },
    {
      id: "agt",
      label: "Agents",
      sub: agents.data ? `${agents.data.length} agents · scoped tools` : "",
      x: 880,
      y: 1160,
      w: 1160,
      h: 580,
      tint: "oklch(0.80 0.06 155 / .14)",
      body: <AgentsZone query={agents} projectId={projectId} onOpen={openAgent} hide={hiddenAgents} />,
    },
    {
      id: "auto",
      label: "Automations",
      sub: "n8n triggers",
      x: 40,
      y: 1780,
      w: 800,
      h: 520,
      tint: "oklch(0.80 0.05 250 / .14)",
      body: (
        <div className="flex flex-col items-start gap-4">
          <EmptyZone>
            n8n sends signed, typed triggers into a project; nothing else gets in. Its clients and what they
            triggered are in Settings → Automations.
          </EmptyZone>
          <button
            type="button"
            onClick={() => openSettings("auto")}
            className="rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink"
          >
            Open Automations
          </button>
        </div>
      ),
    },
    {
      id: "plan",
      label: "Plans & queue",
      sub: [plansSub(plans.data), queued.data ? `${queued.data} queued runs` : ""]
        .filter(Boolean)
        .join(" · "),
      x: 880,
      y: 1780,
      w: 1160,
      h: 520,
      tint: "oklch(0.85 0.06 95 / .18)",
      body: <PlansZone onOpen={openPlan} />,
    },
  ];

  const glass = "glass pointer-events-auto flex items-center rounded-[18px]";
  return (
    <div className="fixed inset-0 overflow-hidden">
      {onBoard ? (
        <m.div
          ref={vpRef}
          onPointerDown={panStart}
          onPointerMove={panMove}
          onPointerUp={panEnd}
          onPointerLeave={panEnd}
          className="absolute inset-0 cursor-grab overflow-hidden touch-none"
          style={{
            backgroundImage: "radial-gradient(var(--dot) 1px, transparent 1.3px)",
            backgroundSize: gridSize,
            backgroundPosition: gridPos,
          }}
        >
          {/* shortcut: phone width still shows the scaled canvas; the §8 mobile layout (bottom nav) replaces it in P1. */}
          <m.main
            aria-label="Board"
            className="absolute top-0 left-0 will-change-transform"
            style={{ width: BOARD_W, height: BOARD_H, x: vx, y: vy, scale: vz, originX: 0, originY: 0 }}
          >
            {/* Regrouping cross-fades the zone sets (opacity only, so it also suits reduced motion). */}
            <AnimatePresence initial={false} mode="wait">
              <m.div key={group} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {(group === "agents"
                  ? agentLanes(agents, projectId, openAgent, hiddenAgents)
                  : zones.filter((z) => !z.ws || scope.shown[z.ws])
                ).map((zone: ZoneDef) => {
                  const { ws: zws, body, ...z } = zone;
                  return (
                    <Zone
                      key={z.id}
                      {...z}
                      dim={ws !== "all" && !!zws && zws !== ws}
                      focused={focused === z.id}
                      onZoneClick={zoneClick(zone)}
                      onFocusZone={() => focusZone(z)}
                    >
                      {body}
                    </Zone>
                  );
                })}
              </m.div>
            </AnimatePresence>
          </m.main>
        </m.div>
      ) : (
        <HomeView />
      )}

      <header className="pointer-events-none absolute top-3.5 right-4 left-4 flex items-center gap-2.5">
        <div className={`${glass} h-[52px] gap-2.5 pr-1.5 pl-3.5`}>
          <span
            aria-hidden="true"
            className="size-[22px] rounded-full"
            style={{ background: "conic-gradient(from 200deg, var(--teal), var(--amber), var(--teal))" }}
          />
          <h1 className="m-0 font-serif text-[25px] leading-none font-normal italic">nexus</h1>
          <span
            role="img"
            aria-label={runner ? `Runner ${runner.name}: ${runner.status.toLowerCase()}` : "No runner paired"}
            title={runner ? `${runner.name} · ${runner.status.toLowerCase()}` : "no runner paired"}
            className="ml-0.5 size-[7px] rounded-full"
            style={{ background: runner ? RUNNER_TONE[runner.status] : "var(--ink3)" }}
          />
          {/* Hidden while a workspace is hidden ("Dev only"): the scope menu still offers All projects. */}
          {scope.shown.dev && scope.shown.business && (
            <div
              role="group"
              aria-label="Workspace"
              className="ml-2 hidden rounded-xl bg-hair p-[3px] md:flex"
            >
              {(["all", "dev", "business"] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={ws === w}
                  onClick={() =>
                    void navigate({
                      search: (s) => ({ ...s, ws: w === scope.fallback ? undefined : w, project: undefined }),
                    })
                  }
                  className={seg(ws === w)}
                >
                  {w === "all" ? "All" : w === "dev" ? "Dev" : "Business"}
                </button>
              ))}
            </div>
          )}
        </div>

        <CommandBar runners={runners.data} projectId={projectId} blocked={scope.blocked} onQueued={openRun}>
          {!search.drawer && banner}
          {runners.error && (
            <div
              role="alert"
              className="pointer-events-auto rounded-2xl px-[18px] py-3 text-[13.5px] font-medium text-white shadow-nx"
              style={{ background: "oklch(0.52 0.15 32)" }}
            >
              {runners.error.message} Retrying every few seconds.
            </div>
          )}
        </CommandBar>

        <div className={`${glass} h-[52px] gap-0.5 px-1.5`}>
          <div role="group" aria-label="View" className="flex rounded-xl bg-hair p-[3px]">
            {(["home", "board"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() =>
                  void navigate({ search: (s) => ({ ...s, view: v === "home" ? undefined : v }) })
                }
                className={seg(view === v)}
              >
                {v === "home" ? "Home" : "Board"}
              </button>
            ))}
          </div>
          <div
            role="group"
            aria-label="Board grouping"
            className={`hidden rounded-xl bg-hair p-[3px] ${onBoard ? "lg:flex" : ""}`}
          >
            {(["domains", "agents"] as const).map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={group === g}
                onClick={() => setGroup(g)}
                className={seg(group === g)}
              >
                {g === "domains" ? "Domains" : "Agents"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={openResearch}
            className="rounded-xl px-2.5 py-2 font-serif text-[17px] leading-none italic"
          >
            Brief
          </button>
          <button
            type="button"
            aria-label={
              pending === undefined
                ? "Inbox"
                : `Inbox, ${pending} pending ${pending === 1 ? "approval" : "approvals"}, ${unread} unread`
            }
            onClick={() => void navigate({ search: { ...scope.keep, drawer: "inbox" } })}
            className={`${pillBtn} flex items-center gap-1.5`}
          >
            Inbox
            {!!((pending ?? 0) + unread) && (
              <span
                aria-hidden="true"
                className="min-w-[18px] rounded-full bg-amber px-1.5 py-[3px] text-center font-mono text-[10.5px] leading-none text-onacc"
              >
                {(pending ?? 0) + unread}
              </span>
            )}
          </button>
          <button
            type="button"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() => setTheme(toggleTheme())}
            className="flex size-9 items-center justify-center rounded-xl"
          >
            <span
              aria-hidden="true"
              className="size-4 rounded-full border-[1.5px] border-ink"
              style={{ background: "linear-gradient(90deg, var(--ink) 50%, transparent 50%)" }}
            />
          </button>
          <button type="button" onClick={() => void signOut()} className={pillBtn}>
            Sign out
          </button>
        </div>
      </header>

      <div className="absolute bottom-4 left-4 flex items-center gap-2">
        <div className={`glass items-center gap-0.5 rounded-[14px] p-1 ${onBoard ? "flex" : "hidden"}`}>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomBy(0.8)}
            className="size-8 rounded-[10px] text-[18px] leading-none"
          >
            −
          </button>
          <ZoomLevel z={vz} />
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoomBy(1.25)}
            className="size-8 rounded-[10px] text-[18px] leading-none"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => fit()}
            className={`h-8 rounded-[10px] px-2.5 text-[12px] font-medium ${focused ? "bg-teal text-onacc" : "text-ink2"}`}
          >
            {focused ? "Overview" : "Fit"}
            {focused && <span className="ml-1.5 font-mono text-[10.5px] opacity-80">esc</span>}
          </button>
        </div>
        <ScopeNav />
      </div>

      <div className="glass absolute right-4 bottom-4 flex items-center gap-0.5 rounded-[14px] p-1">
        <button
          type="button"
          onClick={() => void navigate({ search: { ...scope.keep, drawer: "talk" } })}
          className="h-8 rounded-[10px] px-2.5 text-[12px] font-medium text-teal"
        >
          Talk
        </button>
        <P1Button
          why="Knowledge search isn't built yet."
          className="hidden h-8 rounded-[10px] px-2.5 text-[12px] font-medium text-ink2 sm:block"
        >
          Knowledge
        </P1Button>
        <button
          type="button"
          onClick={() => void navigate({ search: { ...scope.keep, drawer: "settings" } })}
          className="h-8 rounded-[10px] px-2.5 text-[12px] font-medium text-ink2"
        >
          Settings
        </button>
        <P1Button
          why="The phone approvals preview isn't built yet."
          className="hidden h-8 rounded-[10px] px-2.5 text-[12px] font-medium text-ink2 sm:block"
        >
          Phone
        </P1Button>
        <StopButton />
      </div>

      <NotificationToasts hidden={!!search.drawer} />
      {drawerKind === "run" && drawerId && (
        <RunDrawer jobId={drawerId} banner={banner} onClose={closeDrawer} />
      )}
      {drawerKind === "repo" && drawerId && (
        <RepoDrawer repoId={drawerId} banner={banner} onClose={closeDrawer} />
      )}
      {drawerKind === "inbox" && <InboxDrawer banner={banner} onClose={closeDrawer} />}
      {drawerKind === "settings" && <SettingsDrawer banner={banner} onClose={closeDrawer} />}
      {drawerKind === "business" && <BusinessDrawer banner={banner} onClose={closeDrawer} />}
      {drawerKind === "talk" && <TalkDrawer threadId={drawerId} banner={banner} onClose={closeDrawer} />}
      {drawerKind === "research" && (
        <ResearchDrawer deepDiveId={drawerId} banner={banner} onClose={closeDrawer} />
      )}
      {drawerKind === "systems" && (
        <SystemsDrawer banner={banner} onClose={closeDrawer} onOpenIncident={openIncident} />
      )}
      {drawerKind === "incident" && drawerId && (
        <IncidentDrawer id={drawerId} banner={banner} onClose={closeDrawer} />
      )}
      {drawerKind === "agent" && agentKey.success && (
        <AgentDrawer agent={agentKey.data} banner={banner} onClose={closeDrawer} />
      )}
      {drawerKind === "plan" && drawerId && (
        <PlanDrawer id={drawerId} banner={banner} onClose={closeDrawer} />
      )}
      {drawerKind === "opp" && drawerId && (
        <OpportunityDrawer
          id={drawerId}
          focus={drawerNumber === "preview" ? "preview" : undefined}
          banner={banner}
          onClose={closeDrawer}
        />
      )}
      {drawerKind === "jobs" && <JobsDrawer banner={banner} onClose={closeDrawer} />}
      {drawerKind === "repos" && <RepositoriesDrawer banner={banner} onClose={closeDrawer} />}
      {drawerKind === "newjob" && <NewJobDrawer banner={banner} onClose={closeDrawer} />}
      {drawerKind === "jobdraft" && drawerId && (
        <JobDraftDrawer id={drawerId} banner={banner} onClose={closeDrawer} />
      )}
      {drawerKind === "issue" && drawerId && drawerNumber && (
        <IssueDrawer repoId={drawerId} number={Number(drawerNumber)} banner={banner} onClose={closeDrawer} />
      )}
    </div>
  );
}

function codeSub(repos: number | undefined, total: number | undefined, running: number | undefined) {
  const parts = repos === undefined ? [] : [`${repos} ${repos === 1 ? "repo" : "repos"}`];
  if (total !== undefined)
    parts.push(
      total === 0
        ? "no runs yet"
        : `${total} recent ${total === 1 ? "run" : "runs"} · ${running ?? 0} running`,
    );
  return parts.join(" · ");
}

function sysSub(runners: readonly Runner[] | undefined) {
  if (!runners) return "";
  const active = runners.filter((r) => r.status !== "REVOKED");
  if (!active.length) return "no runner paired";
  const on = active.filter((r) => r.status === "ONLINE").length;
  return `${active.length} ${active.length === 1 ? "runner" : "runners"} · ${on} online`;
}

// Zones move by transform, not `layout`: layout measures screen px, which the zoomed board scale would skew.
const ZONE_MOVE = { duration: 0.7, ease: [0.2, 0.8, 0.2, 1] } as const;

/** The zoom % for the controls; subscribes to the camera itself so a glide re-renders only this. */
function ZoomLevel({ z }: { z: MotionValue<number> }) {
  const [pct, setPct] = useState(() => Math.round(z.get() * 100));
  useMotionValueEvent(z, "change", (v) => setPct(Math.round(v * 100)));
  return (
    <span className="min-w-[46px] text-center font-mono text-[11.5px] text-ink2" aria-label={`Zoom ${pct}%`}>
      {pct}%
    </span>
  );
}

function Zone({
  id,
  label,
  sub,
  x,
  y,
  w,
  h,
  tint,
  dim,
  focused,
  onZoneClick,
  onFocusZone,
  children,
}: ZoneProps & { focused: boolean; onZoneClick: (e: MouseEvent) => void; onFocusZone: () => void }) {
  return (
    <m.section
      aria-labelledby={`zone-${id}`}
      onClick={onZoneClick}
      className={`absolute top-0 left-0 rounded-[32px] border ${focused ? "border-teal" : "border-hair"} ${focused ? "" : "cursor-zoom-in"}`}
      style={{ width: w, height: h, background: tint }}
      initial={false}
      animate={{ x, y, opacity: dim ? 0.35 : 1 }}
      transition={ZONE_MOVE}
      whileHover={focused ? undefined : { boxShadow: "0 0 0 2px var(--teal)" }}
    >
      <div className="absolute top-[22px] left-7 flex items-baseline gap-3 whitespace-nowrap">
        <h2
          id={`zone-${id}`}
          className={`m-0 font-serif leading-none font-normal ${w < 400 ? "text-[24px]" : "text-[48px]"}`}
        >
          {label}
        </h2>
        <span className="font-mono text-[12px] text-ink3">{sub}</span>
        {!focused && (
          <button
            type="button"
            onClick={onFocusZone}
            className="self-center rounded-lg bg-hair px-2 py-1 font-sans text-[12px] font-medium text-ink2 opacity-70 hover:opacity-100 focus-visible:opacity-100"
          >
            Expand
          </button>
        )}
      </div>
      <div className="absolute inset-x-10 top-[90px] bottom-8 overflow-hidden">{children}</div>
    </m.section>
  );
}
