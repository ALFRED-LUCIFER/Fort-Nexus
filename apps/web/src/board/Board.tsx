import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Runner } from "@nexus/contracts";
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
import { CommandBar } from "./CommandBar.tsx";
import { StopButton, useStopBanner } from "./EmergencyStop.tsx";
import { P1Button } from "./P1Button.tsx";
import { IssueDrawer, RepoDrawer } from "./github.tsx";
import { InboxDrawer } from "./Inbox.tsx";
import { NotificationToasts, useScopeNotifications } from "./notifications.tsx";
import { RunDrawer } from "./RunDrawer.tsx";
import { ScopeNav, useScope } from "./scope.tsx";
import { SettingsDrawer } from "./Settings.tsx";
import { CodeZone, EmptyZone, SystemsZone, type ZoneProps } from "./zones.tsx";

const route = getRouteApi("/");
const BOARD_W = 2080;
const BOARD_H = 2340;
const MIN_Z = 0.22;
const MAX_Z = 1.8;

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
  const unread = useScopeNotifications().unread ?? 0;

  const openRun = (id: string) => void navigate({ search: { ...scope.keep, drawer: `run:${id}` } });
  const openRepo = (id: string) => void navigate({ search: { ...scope.keep, drawer: `repo:${id}` } });
  const closeDrawer = () => void navigate({ search: scope.keep });

  // Pan / zoom. Positions are in screen px; the board is scaled around its top-left corner.
  const vpRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 40, y: 90, z: 0.62 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const fit = () => {
    const el = vpRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight - 90;
    const z = Math.max(MIN_Z, Math.min(w / 2120, h / 2360));
    setView({ z, x: (w - BOARD_W * z) / 2, y: 84 + (h - BOARD_H * z) / 2 });
  };
  const zoomAt = (f: number, cx: number, cy: number) =>
    setView((v) => {
      const z = Math.min(MAX_Z, Math.max(MIN_Z, v.z * f));
      return { z, x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z };
    });
  const zoomBy = (f: number) =>
    zoomAt(f, (vpRef.current?.clientWidth ?? 1200) / 2, (vpRef.current?.clientHeight ?? 800) / 2);
  useLayoutEffect(fit, []);
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.08 : 0.926, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const panStart = (e: PointerEvent) => {
    if ((e.target as Element).closest("button,input,select,a,[data-nopan]")) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const panMove = (e: PointerEvent) => {
    const d = drag.current;
    if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const panEnd = () => {
    drag.current = null;
  };

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
      sub: "not connected",
      x: 40,
      y: 40,
      w: 2000,
      h: 400,
      tint: "oklch(0.86 0.07 85 / .22)",
      body: <EmptyZone>Nothing noticed yet. Risk and opportunity detection arrives in P1.</EmptyZone>,
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
      sub: "not connected",
      x: 880,
      y: 480,
      w: 540,
      h: 640,
      tint: "oklch(0.85 0.07 70 / .18)",
      body: (
        <EmptyZone>
          {scope.project?.mode === "BUSINESS"
            ? `No sources connected to ${scope.project.name}. Read-only business connectors arrive in P1.`
            : "No business sources connected. Read-only connectors arrive in P1."}
        </EmptyZone>
      ),
    },
    {
      id: "sys",
      ws: "dev",
      label: "Systems",
      sub: sysSub(runners.data),
      x: 1460,
      y: 480,
      w: 580,
      h: 640,
      tint: "oklch(0.80 0.07 32 / .14)",
      body: <SystemsZone query={runners} />,
    },
    {
      id: "res",
      label: "Research",
      sub: "not connected",
      x: 40,
      y: 1160,
      w: 800,
      h: 580,
      tint: "oklch(0.80 0.05 290 / .14)",
      body: <EmptyZone>No watchlists yet. The research agent arrives in P1.</EmptyZone>,
    },
    {
      id: "agt",
      label: "Agents",
      sub: "none configured",
      x: 880,
      y: 1160,
      w: 1160,
      h: 580,
      tint: "oklch(0.80 0.06 155 / .14)",
      body: <EmptyZone>No agents configured. Scoped agents arrive in P1.</EmptyZone>,
    },
    {
      id: "auto",
      label: "Automations",
      sub: "not connected",
      x: 40,
      y: 1780,
      w: 800,
      h: 520,
      tint: "oklch(0.80 0.05 250 / .14)",
      body: <EmptyZone>No n8n workflows connected. Automations arrive in P1.</EmptyZone>,
    },
    {
      id: "plan",
      label: "Plans & queue",
      sub: queued.data ? `${queued.data} queued` : "",
      x: 880,
      y: 1780,
      w: 1160,
      h: 520,
      tint: "oklch(0.85 0.06 95 / .18)",
      body: <EmptyZone>No plans yet. Plans arrive in P1; queued runs show in Code.</EmptyZone>,
    },
  ];

  const glass = "glass pointer-events-auto flex items-center rounded-[18px]";
  return (
    <div className="fixed inset-0 overflow-hidden">
      <div
        ref={vpRef}
        onPointerDown={panStart}
        onPointerMove={panMove}
        onPointerUp={panEnd}
        onPointerLeave={panEnd}
        className="absolute inset-0 cursor-grab overflow-hidden touch-none"
        style={{
          backgroundImage: "radial-gradient(var(--dot) 1px, transparent 1.3px)",
          backgroundSize: `${22 * view.z}px ${22 * view.z}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        {/* shortcut: phone width still shows the scaled canvas; the §8 mobile layout (bottom nav) replaces it in P1. */}
        <main
          aria-label="Board"
          className="absolute top-0 left-0 origin-top-left will-change-transform"
          style={{
            width: BOARD_W,
            height: BOARD_H,
            transform: `translate(${view.x}px,${view.y}px) scale(${view.z})`,
          }}
        >
          {zones.map(({ ws: zws, body, ...z }) => (
            <Zone key={z.id} {...z} dim={ws !== "all" && !!zws && zws !== ws}>
              {body}
            </Zone>
          ))}
        </main>
      </div>

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
          <div role="group" aria-label="Workspace" className="ml-2 hidden rounded-xl bg-hair p-[3px] md:flex">
            {(["all", "dev", "business"] as const).map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={ws === w}
                onClick={() =>
                  void navigate({
                    search: (s) => ({ ...s, ws: w === "all" ? undefined : w, project: undefined }),
                  })
                }
                className={seg(ws === w)}
              >
                {w === "all" ? "All" : w === "dev" ? "Dev" : "Business"}
              </button>
            ))}
          </div>
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
          <div role="group" aria-label="Board grouping" className="hidden rounded-xl bg-hair p-[3px] lg:flex">
            <button type="button" aria-pressed="true" className={seg(true)}>
              Domains
            </button>
            <P1Button why="The Agents view arrives in P1 with agents." className={seg(false)}>
              Agents
            </P1Button>
          </div>
          <P1Button
            why="The daily brief arrives in P1."
            className="rounded-xl px-2.5 py-2 font-serif text-[17px] leading-none italic"
          >
            Brief
          </P1Button>
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
        <div className="glass flex items-center gap-0.5 rounded-[14px] p-1">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomBy(0.8)}
            className="size-8 rounded-[10px] text-[18px] leading-none"
          >
            −
          </button>
          <span aria-live="polite" className="min-w-[46px] text-center font-mono text-[11.5px] text-ink2">
            {Math.round(view.z * 100)}%
          </span>
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
            onClick={fit}
            className="h-8 rounded-[10px] px-2.5 text-[12px] font-medium text-ink2"
          >
            Fit
          </button>
        </div>
        <ScopeNav />
      </div>

      <div className="glass absolute right-4 bottom-4 flex items-center gap-0.5 rounded-[14px] p-1">
        <P1Button
          why="Talk (voice conversation) arrives in P1."
          className="h-8 rounded-[10px] px-2.5 text-[12px] font-medium text-teal"
        >
          Talk
        </P1Button>
        <P1Button
          why="Knowledge search arrives in P1."
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
          why="The phone approvals preview arrives in P1."
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

function Zone({ id, label, sub, x, y, w, h, tint, dim, children }: ZoneProps) {
  return (
    <section
      aria-labelledby={`zone-${id}`}
      className="absolute rounded-[32px] border border-hair transition-opacity duration-700"
      style={{ left: x, top: y, width: w, height: h, background: tint, opacity: dim ? 0.35 : 1 }}
    >
      <div className="absolute top-[22px] left-7 flex items-baseline gap-3 whitespace-nowrap">
        <h2 id={`zone-${id}`} className="m-0 font-serif text-[48px] leading-none font-normal">
          {label}
        </h2>
        <span className="font-mono text-[12px] text-ink3">{sub}</span>
      </div>
      <div className="absolute inset-x-10 top-[90px] bottom-8 overflow-hidden">{children}</div>
    </section>
  );
}
