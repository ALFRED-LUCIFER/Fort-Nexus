import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AgentKey } from "@nexus/contracts";
import { authClient } from "../lib/auth.ts";
import { MD, XL, useMedia } from "../lib/media.ts";
import { RUNNER_TONE, clock, usePendingApprovals } from "../lib/queries.ts";
import { currentTheme, toggleTheme } from "../lib/theme.ts";
import { AgentDrawer } from "./agents.tsx";
import { AreaLinks, AreaPage, useAreas, type AreaKey } from "./areas.tsx";
import { BusinessDrawer } from "./business.tsx";
import { CofounderPanel } from "./cofounder.tsx";
import { CommandBar } from "./CommandBar.tsx";
import { StopButton, useStopBanner } from "./EmergencyStop.tsx";
import { IssueDrawer, RepoDrawer } from "./github.tsx";
import { TodayView } from "./home.tsx";
import { InboxDrawer } from "./Inbox.tsx";
import { JobsDrawer } from "./jobs.tsx";
import { IncidentDrawer, SystemsDrawer } from "./monitoring.tsx";
import { JobDraftDrawer, NewJobDrawer } from "./newJob.tsx";
import { NotificationToasts, useScopeNotifications } from "./notifications.tsx";
import { OpportunityDrawer } from "./opportunities.tsx";
import { PlanDrawer } from "./plans.tsx";
import { RepositoriesDrawer } from "./repos.tsx";
import { ResearchDrawer } from "./research.tsx";
import { RunDrawer } from "./RunDrawer.tsx";
import { ScopeNav, useOnlyProjectInUrl, useScope } from "./scope.tsx";
import { SettingsDrawer } from "./Settings.tsx";
import { PhoneNav, Sidebar } from "./Sidebar.tsx";
import { TalkDrawer } from "./Talk.tsx";

// The one page of NEXUS: header, the areas (sidebar on desktop, bottom nav on a phone), the active area in the middle
// column, the Cofounder panel docked on the right on wide screens, and every drawer over it (PRD §D.2–D.4).

const route = getRouteApi("/");
const COLLAPSED_KEY = "nexus.cofounder.collapsed";

const glass = "glass flex items-center rounded-[18px]";
const pillBtn = "rounded-xl px-2.5 py-2 text-[12.5px] font-medium text-ink2 whitespace-nowrap";

export function Shell() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const scope = useScope();
  useOnlyProjectInUrl();
  const projectId = scope.project?.id;
  const wide = useMedia(MD);
  // Without matchMedia nothing is docked: the panel is a wide-screen extra, Talk opens the drawer everywhere.
  const docked = useMedia(XL, false);
  const areas = useAreas();
  const runners = areas.queries.runners;
  const queued = areas.queries.queued;
  const runner = areas.runner;
  const approvals = usePendingApprovals(projectId, scope.ready);
  const pending = approvals.data?.length;
  const unread = useScopeNotifications().unread ?? 0;

  // An area that isn't shown (its workspace is hidden) falls back to Today; so does the phone's areas screen on a
  // wide screen, where the sidebar is that list. Until the workspaces are known the URL's area waits for them.
  const shownArea = areas.list.some((a) => a.id === search.area) ? search.area : undefined;
  const current: AreaKey | "list" =
    search.area === "list" ? (wide ? "today" : "list") : ((areas.ready ? shownArea : search.area) ?? "today");
  // An area's page waits for the workspaces (they decide whether it is shown); Today shows its own loading state.
  const waiting = !areas.ready && current !== "today" && current !== "list";
  const pageLabel = waiting
    ? "Loading"
    : current === "list"
      ? "Workspaces"
      : (areas.list.find((a) => a.id === current)?.label ?? "Today");

  // drawer = run:<jobId> | repo:<repoId> | issue:<repoId>:<number> (validated by BoardSearch).
  const [drawerKind, drawerId, drawerNumber] = search.drawer?.split(":") ?? [];
  const agentKey = AgentKey.safeParse(drawerId);
  const open = (drawer: string) => void navigate({ search: { ...scope.keep, drawer } });
  const closeDrawer = () => void navigate({ search: scope.keep });

  // Each page starts at its top; the middle column scrolls, the header and the sidebar don't.
  const mainRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [current]);

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

  // One banner: inside the open drawer (a modal drawer hides the page), under the command bar otherwise.
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

  const inboxCount = (pending ?? 0) + unread;
  const inboxLabel =
    pending === undefined
      ? "Inbox"
      : `Inbox, ${pending} pending ${pending === 1 ? "approval" : "approvals"}, ${unread} unread`;
  const themeButton = (
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
  );
  const signOutButton = (
    <button type="button" onClick={() => void signOut()} className={pillBtn}>
      Sign out
    </button>
  );

  let page: ReactNode;
  if (current === "today") page = <TodayView />;
  else if (waiting)
    page = (
      <p role="status" className="m-0 pt-2 text-[14px] text-ink3">
        Loading…
      </p>
    );
  else if (current === "list")
    page = (
      <div className="flex flex-col gap-5 pb-6">
        <h2 className="m-0 font-serif text-[34px] leading-none font-normal">Workspaces</h2>
        <ScopeNav />
        <AreaLinks areas={areas} current={current} />
        <div className="flex flex-wrap items-center gap-2 border-t border-hair pt-4">
          {themeButton}
          {signOutButton}
        </div>
      </div>
    );
  else page = <AreaPage area={current} areas={areas} open={open} />;

  return (
    <div className="fixed inset-0 flex flex-col">
      {/* A phone puts the logo and STOP on the first row and gives the command bar the whole second row; wider
          screens keep one row. The bar stays at one place in the tree, so what was typed survives a rotation. */}
      <header className="relative flex flex-none flex-wrap items-center gap-x-2.5 gap-y-2 px-4 pt-3 pb-2 md:flex-nowrap md:pt-3.5 md:pb-3">
        <div className={`${glass} h-11 flex-none gap-2.5 pr-3 pl-3.5 md:h-[52px]`}>
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
            className="size-[7px] rounded-full"
            style={{ background: runner ? RUNNER_TONE[runner.status] : "var(--ink3)" }}
          />
        </div>

        <div className="order-last flex w-full min-w-0 md:order-none md:w-auto md:flex-[1_1_0]">
          <CommandBar
            runners={runners.data}
            projectId={projectId}
            blocked={scope.blocked}
            onQueued={(id) => open(`run:${id}`)}
          >
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
        </div>

        {wide ? (
          <div className={`${glass} h-[52px] flex-none gap-0.5 px-1.5`}>
            <button
              type="button"
              aria-label={inboxLabel}
              onClick={() => open("inbox")}
              className={`${pillBtn} flex items-center gap-1.5`}
            >
              Inbox
              {!!inboxCount && (
                <span
                  aria-hidden="true"
                  className="min-w-[18px] rounded-full bg-amber px-1.5 py-[3px] text-center font-mono text-[11px] leading-none text-onacc"
                >
                  {inboxCount}
                </span>
              )}
            </button>
            {themeButton}
            {signOutButton}
          </div>
        ) : (
          // A phone has no sidebar: the emergency stop stays in reach here.
          <div className="glass ml-auto flex flex-none items-center rounded-[14px] p-1">
            <StopButton />
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1 gap-4 px-4 md:pb-4">
        {wide && <Sidebar areas={areas} current={current} />}
        <main ref={mainRef} aria-label={pageLabel} className="min-w-0 flex-1 overflow-y-auto px-1 pt-1">
          <div className="mx-auto w-full max-w-[1120px]">{page}</div>
        </main>
        {docked && <CofounderDock projectId={projectId} />}
      </div>

      {!wide && <PhoneNav current={current} inbox={{ count: inboxCount, label: inboxLabel }} />}

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
        <SystemsDrawer
          banner={banner}
          onClose={closeDrawer}
          onOpenIncident={(id) => open(`incident:${id}`)}
        />
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
      {drawerKind === "repos" && (
        <RepositoriesDrawer choose={drawerId === "choose"} banner={banner} onClose={closeDrawer} />
      )}
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

const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * The Cofounder panel docked beside every page on wide screens; collapsing it is remembered on this device. One
 * button toggles it in both states, so focus stays on it and its expanded state is announced.
 */
function CofounderDock({ projectId }: { projectId: string | undefined }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const id = useId();
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Storage blocked (private mode, policy): the choice holds until the page reloads.
    }
  };
  return (
    <div className={`flex flex-none flex-col gap-2 ${collapsed ? "w-11" : "w-[360px]"}`}>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={id}
        aria-label={collapsed ? "Show cofounder panel" : "Hide cofounder panel"}
        onClick={toggle}
        className={
          collapsed
            ? "glass flex w-11 flex-col items-center gap-3 rounded-[18px] px-1 py-4 text-[13px] font-medium text-ink2 hover:text-ink"
            : "self-end rounded-xl px-2.5 py-1.5 text-[12.5px] font-medium text-ink2 hover:bg-hair hover:text-ink"
        }
      >
        {collapsed ? (
          <>
            <span aria-hidden="true">‹</span>
            <span className="[writing-mode:vertical-rl]">Cofounder</span>
          </>
        ) : (
          <>
            Hide <span aria-hidden="true">›</span>
          </>
        )}
      </button>
      <div id={id} hidden={collapsed} className="flex min-h-0 flex-1 flex-col">
        {!collapsed && <CofounderPanel projectId={projectId} />}
      </div>
    </div>
  );
}
