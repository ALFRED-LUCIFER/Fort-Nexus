import { useEffect, useId, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type { Approval, Project } from "@nexus/contracts";
import { useShownWorkspaces, useWorkspaces, type ShownWorkspaces } from "../lib/queries.ts";
import type { Area, Workspace } from "../router.tsx";

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
  /** Search params that keep this scope (and the page in the middle column) when navigating. */
  keep: { ws?: Workspace; project?: string; area?: Area };
  /** The workspace a URL without `ws` shows (see `fallbackWorkspace`). */
  fallback: Workspace;
  shown: ShownWorkspaces;
}

/** What a URL without `ws` shows: All while both workspaces are shown, else the one that is ("Dev only"). */
export const fallbackWorkspace = (s: ShownWorkspaces): Workspace =>
  s.dev && s.business ? "all" : s.business ? "business" : "dev";

/**
 * The board's scope from the URL (`ws` + `project`). Never falls back to another project (FR-CSP-01). A hidden
 * workspace in the URL shows the fallback instead, without the hidden workspace's project.
 */
export function useScope(): Scope {
  const search = route.useSearch();
  const shown = useShownWorkspaces();
  const fallback = fallbackWorkspace(shown);
  const hiddenWs = search.ws !== undefined && search.ws !== "all" && !shown[search.ws];
  const ws = search.ws && !hiddenWs ? search.ws : fallback;
  const projectId = hiddenWs ? undefined : search.project;
  const workspaces = useWorkspaces();
  const project =
    ws === "all" || !projectId
      ? undefined
      : workspaces.data?.items.find((w) => w.mode === MODE[ws])?.projects.find((p) => p.id === projectId);
  const blocked = !project
    ? PICK_PROJECT
    : project.archivedAt
      ? `${project.name} is archived: it keeps its history but can't start or approve runs. Unarchive it in Settings → Workspaces.`
      : project.mode === "BUSINESS"
        ? `${project.name} is a Business project: it reads its connected sources in the Business drawer, and runs belong to Dev projects.`
        : null;
  return {
    ws,
    project,
    // The workspaces decide the scope ("Dev only" picks Dev): nothing loads for a scope until they have arrived.
    ready: !workspaces.isPending,
    blocked,
    keep: { ws: ws === fallback ? undefined : ws, project: projectId, area: search.area },
    fallback,
    shown,
  };
}

/** Why this approval can't be decided in the current scope (approvals belong to exactly one project). */
export const decisionBlocked = (scope: Scope, a: Approval): string | null =>
  scope.blocked ??
  (scope.project?.id === a.projectId
    ? null
    : "This approval belongs to another project: switch to it first.");

const LABEL = { all: "All workspaces", dev: "Dev", business: "Business" } as const;
/** "All workspaces", or "All projects" while one workspace is hidden. */
export const allLabel = (s: ShownWorkspaces) => (s.dev && s.business ? LABEL.all : "All projects");
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

  // A workspace with exactly one active project opens on it: its "all repos" view would show the same data, but
  // read-only and without the project's agents, so nothing would look like it works.
  const only =
    scope.ws === "all" || scope.keep.project
      ? undefined
      : workspaces.data?.items
          .find((w) => w.mode === MODE[scope.ws as "dev" | "business"])
          ?.projects.filter((p) => !p.archivedAt);
  const onlyId = only?.length === 1 ? only[0]!.id : undefined;
  useEffect(() => {
    if (onlyId) void navigate({ search: (s) => ({ ...s, project: onlyId }), replace: true });
  }, [onlyId, navigate]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  // Switching scope closes any drawer (it showed the other project's data) and keeps the page.
  const area = scope.keep.area;
  const wsParam = (w: Workspace) => (w === scope.fallback ? undefined : w);
  const select = (p: Project | null) => {
    void navigate({
      search: p
        ? { ws: wsParam(p.mode === "DEV" ? "dev" : "business"), project: p.id, area }
        : { ws: wsParam("all"), area },
    });
    close();
  };
  // A whole workspace without a project: its read-only aggregate (or its only project, picked above).
  const selectWorkspace = (w: Workspace) => {
    void navigate({ search: { ws: wsParam(w), area } });
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
                  : "business · read-only sources",
              scope.project?.id === p.id,
            ),
          )}
        </ul>
      </li>
    );
  };

  const both = scope.shown.dev && scope.shown.business;
  return (
    <nav ref={navRef} aria-label="Scope" className="relative flex flex-col gap-1.5 font-mono text-ink2">
      <span className="flex items-baseline gap-1.5 px-1 text-[11px]">
        <span className="font-medium tracking-[.08em] text-ink3">SCOPE</span>
        <span className="font-medium text-teal">
          {scope.ws === "all" ? allLabel(scope.shown) : LABEL[scope.ws]}
        </span>
      </span>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Project: ${scope.project?.name ?? NO_PROJECT[scope.ws]}. Switch project`}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-2 rounded-xl bg-hair px-3 py-2.5 text-left font-sans text-[14px] font-medium text-ink"
      >
        <span className="truncate">{scope.project?.name ?? NO_PROJECT[scope.ws]}</span>
        <span aria-hidden="true" className="text-ink3">
          ▾
        </span>
      </button>
      <span className="px-1 text-[11px]">{scope.blocked ? "read-only" : "home runner"}</span>
      {open && (
        <div
          id={menuId}
          className="glass2 absolute top-full left-0 z-[8] mt-2 flex max-h-[min(560px,calc(100dvh-180px))] w-[min(320px,calc(100vw-32px))] flex-col gap-0.5 overflow-y-auto rounded-[18px] p-2"
        >
          {both && (
            <div role="group" aria-label="Workspace" className="flex rounded-xl bg-hair p-[3px]">
              {(["all", "dev", "business"] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={scope.ws === w}
                  onClick={() => selectWorkspace(w)}
                  className={`flex-1 rounded-[9px] px-2 py-2 font-sans text-[12px] leading-none font-medium ${scope.ws === w ? "bg-glass2 text-ink shadow-[0_1px_3px_rgba(0,0,0,.12)]" : "text-ink2"}`}
                >
                  {w === "all" ? "All" : LABEL[w]}
                </button>
              ))}
            </div>
          )}
          {workspaces.error ? (
            <p role="alert" className="m-0 px-2.5 py-2 font-sans text-[12.5px] text-coral">
              {workspaces.error.message}
            </p>
          ) : !workspaces.data ? (
            <p className="m-0 px-2.5 py-2 font-sans text-[12.5px] text-ink3">Loading projects…</p>
          ) : (
            <ul aria-label="Projects" className="m-0 flex list-none flex-col p-0">
              {scope.shown.dev &&
                group("DEV", "DEV · PROJECTS", "No Dev projects. Create one in Settings → Workspaces.")}
              {scope.shown.business && group("BUSINESS", "BUSINESS · PROJECTS", "No Business projects yet.")}
              <li>
                <span className="block px-2.5 pt-2.5 pb-1.5 font-mono text-[10.5px] tracking-[.06em] text-ink3">
                  CHIEF OF STAFF
                </span>
                <ul className="m-0 flex list-none flex-col p-0">
                  {item(
                    null,
                    allLabel(scope.shown),
                    "cross-project aggregate · read-only",
                    scope.ws === "all",
                  )}
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
