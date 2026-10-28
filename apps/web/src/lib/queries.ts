import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Approval, JobStatus, Runner, RunnerStatus } from "@nexus/contracts";
import { api, keys } from "./api.ts";

const POLL_MS = 5_000;
// shortcut: the board shows the newest 12 runs only, add pagination (nextCursor) when the Code zone gets a list view.
const RECENT_RUNS = 12;
// shortcut: the held-jobs count reads one page of 100, shows "100+" beyond that; add a count endpoint if queues grow.
const QUEUED_PAGE = 100;

export const useRunners = () =>
  useQuery({ queryKey: keys.runners, queryFn: api.runners, refetchInterval: POLL_MS });

/** Emergency stop + today's budget (FR-INB-04, FR-SEC-08). */
export const useSystem = () =>
  useQuery({ queryKey: keys.system, queryFn: api.system, refetchInterval: POLL_MS });

/** Runs still holding a lease: an engaged stop isn't "nothing is running" until these are gone. */
export const useActiveJobs = (enabled: boolean) =>
  useQuery({
    queryKey: [...keys.jobs, "active"],
    queryFn: () =>
      Promise.all(RUNNING.map((status) => api.jobs({ limit: 100, status }))).then((ls) =>
        ls.flatMap((l) => l.items),
      ),
    enabled,
    refetchInterval: POLL_MS,
  });

// The API caches GitHub for 60 s; polling faster would only re-read that cache.
const GITHUB_POLL_MS = 60_000;

export const useGithubStatus = () =>
  useQuery({ queryKey: keys.github, queryFn: api.githubStatus, refetchInterval: GITHUB_POLL_MS });

/**
 * Repositories once the app is installed somewhere; disabled (no 409s) until then. With a project only the ones
 * bound to it; without, every installed repository.
 */
export const useRepositories = (enabled: boolean, projectId?: string) =>
  useQuery({
    queryKey: keys.repositoriesOf(projectId),
    queryFn: () => api.repositories(projectId),
    enabled,
    refetchInterval: GITHUB_POLL_MS,
  });

/** Dev + Business and their projects (FR-WKS-01..03). */
export const useWorkspaces = () => useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces });

/** Newest runs of one project, or of all projects (the read-only "All" view) when projectId is undefined. */
export const useRecentJobs = (projectId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...keys.jobs, "recent", projectId ?? "all"],
    queryFn: () => api.jobs({ limit: RECENT_RUNS, projectId }),
    enabled,
    refetchInterval: POLL_MS,
  });

export const useQueuedJobs = () =>
  useQuery({
    queryKey: [...keys.jobs, "queued"],
    queryFn: () => api.jobs({ limit: QUEUED_PAGE, status: "QUEUED" }),
    refetchInterval: POLL_MS,
    select: (l) => (l.nextCursor ? `${l.items.length}+` : String(l.items.length)),
  });

/** Pending approvals for the Inbox button and drawer (FR-INB-01), of one project or of all of them. */
export const usePendingApprovals = (projectId?: string, enabled = true) =>
  useQuery({
    queryKey: keys.approvalsBy({ status: "PENDING", ...(projectId && { projectId }) }),
    queryFn: () => api.approvals({ status: "PENDING", ...(projectId && { projectId }) }),
    enabled,
    refetchInterval: POLL_MS,
  });

/** Inbox, its unread badge and toasts (FR-NTF-02, FR-INB-01): the newest notifications of the scope. */
export const useNotifications = (projectId?: string, enabled = true) =>
  useQuery({
    queryKey: keys.notificationsOf(projectId),
    queryFn: () => api.notifications(projectId),
    enabled,
    refetchInterval: POLL_MS,
  });

const SETTLED: readonly Approval["status"][] = ["DENIED", "EXPIRED", "EXECUTED", "FAILED"];

const newest = (items: readonly Approval[]) =>
  items.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

/** The newest approval of a job; polls until it is settled (or the job ended without one). */
export const useJobApproval = (jobId: string, enabled: boolean, jobEnded: boolean) =>
  useQuery({
    queryKey: keys.approvalsBy({ jobId }),
    queryFn: () => api.approvals({ jobId }),
    enabled,
    select: newest,
    refetchInterval: (q) => {
      const a = q.state.data && newest(q.state.data);
      return (a ? SETTLED.includes(a.status) : jobEnded) ? false : POLL_MS;
    },
  });

/** Re-renders every `ms` so relative times ("3s ago") stay honest between polls. */
export function useNow(ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** The runner the owner most likely means: online first, then most recently seen; revoked runners never. */
export function preferredRunner(runners: readonly Runner[] | undefined): Runner | undefined {
  const rank: Record<RunnerStatus, number> = { ONLINE: 0, STALE: 1, OFFLINE: 2, REVOKED: 3 };
  return [...(runners ?? [])]
    .filter((r) => r.status !== "REVOKED")
    .sort(
      (a, b) =>
        rank[a.status] - rank[b.status] || (b.lastHeartbeatAt ?? "").localeCompare(a.lastHeartbeatAt ?? ""),
    )[0];
}

export const RUNNER_TONE: Record<RunnerStatus, string> = {
  ONLINE: "var(--green)",
  STALE: "var(--amber)",
  OFFLINE: "var(--coral)",
  REVOKED: "var(--ink3)",
};

const RUNNING: readonly JobStatus[] = ["PREPARING", "RUNNING", "VERIFYING"];
export const isActive = (s: JobStatus) => RUNNING.includes(s);

export function jobTone(s: JobStatus): string {
  if (s === "COMPLETED") return "var(--green)";
  if (s === "FAILED" || s === "RECOVERY_REQUIRED" || s === "REJECTED") return "var(--coral)";
  if (isActive(s)) return "var(--teal)";
  if (s === "AWAITING_APPROVAL" || s === "BLOCKED" || s === "BLOCKED_NEEDS_INFO") return "var(--amber)";
  return "var(--ink3)";
}

export const statusLabel = (s: JobStatus) => (s.charAt(0) + s.slice(1).toLowerCase()).replaceAll("_", " ");

export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });

const span = (s: number) =>
  s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m`
      : s < 86_400
        ? `${Math.floor(s / 3600)}h`
        : `${Math.floor(s / 86_400)}d`;

export function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  return `${span(Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000)))} ago`;
}

/** "in 3h" for a future time, "passed" once it is gone (the server still decides). */
export function until(iso: string, now: number): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  return s <= 0 ? "passed" : `in ${span(s)}`;
}

/** `7f3a91c2…4c91`: enough to compare by eye with what GitHub and the audit log show. */
export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
