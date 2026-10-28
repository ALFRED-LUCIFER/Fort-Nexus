import { useEffect, useId, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type { Approval, Project } from "@nexus/contracts";
import { useWorkspaces } from "../lib/queries.ts";
import type { Workspace } from "../router.tsx";

const route = getRouteApi("/");
const MODE = { dev: "DEV", business: "BUSINESS" } as const;

export const PICK_PROJECT = "Pick a project first: All is a read-only view across projects.";

export interface Scope {
  ws: Workspace;
  /** The selected project; undefined in All, without a project, or until the workspaces have loaded. */
  project: Project | undefined;
  /** False while a project in the URL can't be resolved yet: lists wait instead of showing another scope. */
  ready: boolean;
  /** Why nothing can be started or decided here; null when the project can run things. */
  blocked: string | null;
  /** Search params that keep this scope when navigating. */
  keep: { ws?: "dev" | "business"; project?: string };
}

/** The board's scope from the URL (`ws` + `project`). Never falls back to another project (FR-CSP-01). */
export function useScope(): Scope {
  const search = route.useSearch();
  const ws = search.ws ?? "all";
  const workspaces = useWorkspaces();
  const project =
    ws === "all" || !search.project
      ? undefined
      : workspaces.data?.items
          .find((w) => w.mode === MODE[ws])
          ?.projects.find((p) => p.id === search.project);
  const blocked = !project
    ? PICK_PROJECT
    : project.archivedAt
      ? `${project.name} is archived: it keeps its history but can't start or approve runs. Unarchive it in Settings → Workspaces.`
      : project.mode === "BUSINESS"
        ? `${project.name} is a Business project: business connectors and agents arrive in P1, so it has nothing to run yet.`
        : null;
  return {
    ws,
    project,
    ready: ws === "all" || !search.project || !workspaces.isPending,
    blocked,
    keep: { ws: search.ws === "all" ? undefined : search.ws, project: search.project },
  };
}

/** Why this approval can't be decided in the current scope (approvals belong to exactly one project). */
export const decisionBlocked = (scope: Scope, a: Approval): string | null =>
  scope.blocked ??
  (scope.project?.id === a.projectId
    ? null
    : "This approval belongs to another project: switch to it first.");

const LABEL = { all: "All workspaces", dev: "Dev", business: "Business" } as const;
const NO_PROJECT = { all: "cross-project", dev: "all repos", business: "all products" } as const;

/** SCOPE breadcrumb `Mode › Project ▾ › Environment` with the project switcher (design: projMenu). */
export function ScopeNav() {
  const scope = useScope();
  const navigate = route.useNavigate();
  const workspaces = useWorkspaces();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const menuId = useId();

  // Escape closes and returns focus; a click or focus outside closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onOutside = (e: Event) => {
      if (!navRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  // Switching scope closes any drawer: it showed the other project's data.
  const select = (p: Project | null) => {
    void navigate({
      search: p ? { ws: p.mode === "DEV" ? "dev" : "business", project: p.id } : { ws: undefined },
    });
    close();
  };

  const item = (p: Project | null, name: string, meta: string, active: boolean) => (
    <li key={p?.id ?? "all"}>
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={() => select(p)}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-xl px-2.5 py-[9px] text-left text-ink hover:bg-hair"
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-sans text-[13px] leading-tight font-medium">{name}</span>
          <span className="truncate font-mono text-[10.5px] leading-snug text-ink3">{meta}</span>
        </span>
        <span className="font-sans text-[10px] text-teal">{active ? "● active" : ""}</span>
      </button>
    </li>
  );
  const group = (mode: "DEV" | "BUSINESS", title: string, empty: string) => {
    const projects = workspaces.data?.items.find((w) => w.mode === mode)?.projects ?? [];
    return (
      <li key={mode}>
        <span className="block px-2.5 pt-2.5 pb-1.5 font-mono text-[10.5px] tracking-[.06em] text-ink3">
          {title}
        </span>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {projects.length === 0 && (
            <li className="px-2.5 py-1.5 font-sans text-[12px] text-ink3">{empty}</li>
          )}
          {projects.map((p) =>
            item(
              p,
              p.name,
              p.archivedAt
                ? "archived · read-only"
                : mode === "DEV"
                  ? `${p.repositoryIds.length} ${p.repositoryIds.length === 1 ? "repository" : "repositories"} bound`
                  : "no sources connected · P1",
              scope.project?.id === p.id,
            ),
          )}
        </ul>
      </li>
    );
  };

  return (
    <nav
      ref={navRef}
      aria-label="Scope"
      className="glass relative hidden h-10 items-center gap-[7px] rounded-[14px] pr-1.5 pl-3 font-mono text-[11.5px] whitespace-nowrap text-ink2 md:flex"
    >
      <span className="text-[10px] font-medium tracking-[.08em] text-ink3">SCOPE</span>
      <span className="font-medium text-teal">{LABEL[scope.ws]}</span>
      <span aria-hidden="true" className="text-ink3">
        ›
      </span>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Project: ${scope.project?.name ?? NO_PROJECT[scope.ws]}. Switch project`}
        onClick={() => setOpen(!open)}
        className="rounded-[9px] bg-hair px-2.5 py-2 font-mono text-[11.5px] font-medium text-ink"
      >
        {scope.project?.name ?? NO_PROJECT[scope.ws]} ▾
      </button>
      <span aria-hidden="true" className="text-ink3">
        ›
      </span>
      <span className="pr-1.5">{scope.blocked ? "read-only" : "home runner"}</span>
      {open && (
        <div
          id={menuId}
          className="glass2 absolute bottom-12 left-0 z-[8] flex w-[320px] flex-col gap-0.5 rounded-[18px] p-2 whitespace-normal"
        >
          {workspaces.error ? (
            <p role="alert" className="m-0 px-2.5 py-2 font-sans text-[12.5px] text-coral">
              {workspaces.error.message}
            </p>
          ) : !workspaces.data ? (
            <p className="m-0 px-2.5 py-2 font-sans text-[12.5px] text-ink3">Loading projects…</p>
          ) : (
            <ul aria-label="Projects" className="m-0 flex list-none flex-col p-0">
              {group("DEV", "DEV · PROJECTS", "No Dev projects. Create one in Settings → Workspaces.")}
              {group("BUSINESS", "BUSINESS · PROJECTS", "No Business projects yet.")}
              <li>
                <span className="block px-2.5 pt-2.5 pb-1.5 font-mono text-[10.5px] tracking-[.06em] text-ink3">
                  CHIEF OF STAFF
                </span>
                <ul className="m-0 flex list-none flex-col p-0">
                  {item(null, "All workspaces", "cross-project aggregate · read-only", scope.ws === "all")}
                </ul>
              </li>
            </ul>
          )}
          <span className="px-2.5 pt-2 pb-1 text-[10.5px] leading-[1.45] text-ink3">
            switching re-binds connectors and agent profile · the other project’s data leaves this session
          </span>
        </div>
      )}
    </nav>
  );
}
