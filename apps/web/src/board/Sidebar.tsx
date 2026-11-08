import type { ReactNode } from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import { AreaLinks, type AreaKey, type Areas } from "./areas.tsx";
import { StopButton } from "./EmergencyStop.tsx";
import { ScopeNav, useScope } from "./scope.tsx";

// The overview of NEXUS (PRD §D.3): the scope, the areas with their live status, and the always-visible tools.
// Desktop and tablet show it as the left column; a phone gets the bottom navigation (PRD §8.4) instead.

const route = getRouteApi("/");

const toolBtn = "h-9 rounded-[10px] px-3 text-[13px] font-medium";

export function Sidebar({ areas, current }: { areas: Areas; current: AreaKey | "list" }) {
  const { keep } = useScope();
  const navigate = route.useNavigate();
  const drawer = (d: string) => void navigate({ search: { ...keep, drawer: d } });
  return (
    // Above the page so the scope menu opens over it; drawers (z-10) still cover everything.
    <div className="glass relative z-[6] flex w-[208px] flex-none flex-col gap-3 rounded-[22px] p-2.5 lg:w-[236px]">
      <div className="px-0.5 pt-0.5">
        <ScopeNav />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-hair pt-2">
        <AreaLinks areas={areas} current={current} />
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-hair pt-2.5">
        <button type="button" onClick={() => drawer("talk")} className={`${toolBtn} text-teal`}>
          Talk
        </button>
        <button type="button" onClick={() => drawer("settings")} className={`${toolBtn} text-ink2`}>
          Settings
        </button>
        <span className="ml-auto">
          <StopButton />
        </span>
      </div>
    </div>
  );
}

/** The phone's bottom navigation: Home · Inbox · Talk · Workspaces · Settings (PRD §8.4, C-06). */
export function PhoneNav({
  current,
  inbox,
}: {
  current: AreaKey | "list";
  inbox: { count: number; label: string };
}) {
  const { keep } = useScope();
  const navigate = route.useNavigate();
  const drawer = (d: string) => void navigate({ search: { ...keep, drawer: d } });
  // Sized by their words, then sharing what's left: five equal fifths of a 320px screen are narrower than
  // "Workspaces".
  const item =
    "flex min-h-[48px] flex-auto flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 text-[12px] font-medium";
  const dot = (on: boolean) => (
    <span aria-hidden="true" className={`size-1 rounded-full ${on ? "bg-teal" : "bg-transparent"}`} />
  );
  const link = (label: string, area: "list" | undefined, on: boolean): ReactNode => (
    <Link
      to="/"
      search={{ ...keep, area }}
      activeOptions={{ exact: true }}
      aria-current={on ? "page" : undefined}
      className={`${item} no-underline ${on ? "text-ink" : "text-ink2"}`}
    >
      {dot(on)}
      {label}
    </Link>
  );
  return (
    <nav
      aria-label="Phone"
      className="glass flex flex-none items-stretch gap-1 rounded-t-[22px] px-2 pt-1 pb-[max(6px,env(safe-area-inset-bottom))]"
    >
      {link("Home", undefined, current === "today")}
      <button
        type="button"
        aria-label={inbox.label}
        onClick={() => drawer("inbox")}
        className={`${item} text-ink2`}
      >
        {dot(false)}
        <span className="flex items-center gap-1">
          Inbox
          {!!inbox.count && (
            <span
              aria-hidden="true"
              className="min-w-[18px] rounded-full bg-amber px-1.5 py-[2px] text-center font-mono text-[11px] leading-none text-onacc"
            >
              {inbox.count}
            </span>
          )}
        </span>
      </button>
      <button type="button" onClick={() => drawer("talk")} className={`${item} text-teal`}>
        {dot(false)}
        Talk
      </button>
      {link("Workspaces", "list", current !== "today")}
      <button type="button" onClick={() => drawer("settings")} className={`${item} text-ink2`}>
        {dot(false)}
        Settings
      </button>
    </nav>
  );
}
