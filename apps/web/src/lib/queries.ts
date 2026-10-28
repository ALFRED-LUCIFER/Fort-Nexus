import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { JobStatus, Runner, RunnerStatus } from "@nexus/contracts";
import { api, keys } from "./api.ts";

const POLL_MS = 5_000;
// shortcut: the board shows the newest 12 runs only, add pagination (nextCursor) when the Code zone gets a list view.
const RECENT_RUNS = 12;
// shortcut: the held-jobs count reads one page of 100, shows "100+" beyond that; add a count endpoint if queues grow.
const QUEUED_PAGE = 100;

export const useRunners = () =>
  useQuery({ queryKey: keys.runners, queryFn: api.runners, refetchInterval: POLL_MS });

// The API caches GitHub for 60 s; polling faster would only re-read that cache.
const GITHUB_POLL_MS = 60_000;

export const useGithubStatus = () =>
  useQuery({ queryKey: keys.github, queryFn: api.githubStatus, refetchInterval: GITHUB_POLL_MS });

/** Repositories once the app is installed somewhere; disabled (no 409s) until then. */
export const useRepositories = (enabled: boolean) =>
  useQuery({
    queryKey: keys.repositories,
    queryFn: api.repositories,
    enabled,
    refetchInterval: GITHUB_POLL_MS,
  });

export const useRecentJobs = () =>
  useQuery({
    queryKey: [...keys.jobs, "recent"],
    queryFn: () => api.jobs({ limit: RECENT_RUNS }),
    refetchInterval: POLL_MS,
  });

export const useQueuedJobs = () =>
  useQuery({
    queryKey: [...keys.jobs, "queued"],
    queryFn: () => api.jobs({ limit: QUEUED_PAGE, status: "QUEUED" }),
    refetchInterval: POLL_MS,
    select: (l) => (l.nextCursor ? `${l.items.length}+` : String(l.items.length)),
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

export function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
