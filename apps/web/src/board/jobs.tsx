import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  AgentKey,
  AgentPerformanceRow,
  JobHistoryItem,
  JobHistoryQuery,
  JobOutcome,
  JobStatusGroup,
  JobTests,
} from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import {
  clock,
  duration,
  jobTone,
  statusLabel,
  useGithubStatus,
  useRepositories,
  useWorkspaces,
} from "../lib/queries.ts";
import { field, ghostBtn, primaryBtn } from "./deepDive.tsx";
import { Drawer, DrawerHeader } from "./Drawer.tsx";
import { RunAgain } from "./RunAgain.tsx";
import { useScope } from "./scope.tsx";
import { AGENT_LABEL } from "./agentLabels.ts";

// Jobs wave C: every job with its evidence (FR-OBS-03/04) and per-agent results. Everything shown comes from the API's
// source records; costs are provider-reported estimates, never invoices.

const route = getRouteApi("/");
const PAGE = 25;
const HISTORY_POLL_MS = 15_000;
const PERFORMANCE_POLL_MS = 60_000;
const OFFLINE = "You're offline. NEXUS will load this when the connection is back.";

const GROUP: Record<JobStatusGroup, string> = {
  ACTIVE: "Active",
  NEEDS_YOU: "Needs you",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

const TESTS: Record<JobTests, string> = {
  passed: "Passed",
  failed: "Failed",
  not_configured: "Not configured",
  error: "Error",
};

const OUTCOME: Record<JobOutcome, string> = {
  COMMAND_SUCCEEDED: "Command succeeded",
  COMMAND_FAILED: "Command failed",
  TIMED_OUT: "Timed out",
  PR_CREATED: "Draft PR created",
  FAILED_TESTS: "Tests failed",
  COMPLETED_NO_CHANGES: "Completed, no changes",
  APPROVAL_DENIED: "Approval denied",
  BUDGET_EXCEEDED: "Budget exceeded",
};

const money = (n: number) => `$${n.toFixed(2)} est.`;
const linkable = (url: string) => /^https?:\/\//i.test(url);
const created = (iso: string) =>
  new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short", hour12: false });
// Window dates are calendar dates in the owner's timezone: format them as dates, never shift them through UTC.
const day = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });

function minutes(m: number): string {
  const r = Math.round(m);
  return r < 60 ? `${r} min` : `${Math.floor(r / 60)} h ${r % 60} min`;
}

type Filters = Omit<JobHistoryQuery, "projectId" | "cursor" | "limit">;

const TABS = [
  ["jobs", "All jobs"],
  ["performance", "Agent performance"],
] as const;
type Tab = (typeof TABS)[number][0];

/** `drawer=jobs`: the Jobs page (all jobs with filters) and agent performance. */
export function JobsDrawer({ banner, onClose }: { banner?: ReactNode; onClose: () => void }) {
  const scope = useScope();
  const base = useId();
  const [tab, setTab] = useState<Tab>("jobs");
  const tabId = (t: Tab) => `${base}-tab-${t}`;
  // WAI-ARIA tabs: arrows move between tabs, Home/End jump to the ends.
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const to =
      e.key === "ArrowRight"
        ? (i + 1) % TABS.length
        : e.key === "ArrowLeft"
          ? (i - 1 + TABS.length) % TABS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? TABS.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    const t = TABS[to]![0];
    setTab(t);
    document.getElementById(tabId(t))?.focus();
  };
  return (
    <Drawer banner={banner} onClose={onClose}>
      <DrawerHeader
        kicker={`Jobs · ${scope.project?.name ?? "all projects"}${scope.project ? "" : ", read-only"} · costs are estimates`}
        title="Jobs"
      />
      <div role="tablist" aria-label="Jobs" className="flex flex-none gap-1.5 border-b border-hair px-6 pt-3">
        {TABS.map(([t, label], i) => (
          <button
            key={t}
            id={tabId(t)}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls={`${base}-panel`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            onKeyDown={(e) => onKey(e, i)}
            className={`-mb-px border-b-2 px-3 pb-2.5 text-[13px] font-medium ${tab === t ? "border-teal text-ink" : "border-transparent text-ink2"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id={`${base}-panel`}
        role="tabpanel"
        aria-labelledby={tabId(tab)}
        className="nx-stagger flex min-h-0 flex-1 flex-col gap-6 overflow-auto px-6 pt-5 pb-6"
      >
        {tab === "jobs" ? <AllJobs /> : <AgentPerformanceTab />}
      </div>
    </Drawer>
  );
}

/** Loading, error, offline and stale lines shared by both tabs. */
function QueryNote({
  query,
}: {
  query: { data: unknown; error: Error | null; fetchStatus: string; dataUpdatedAt: number };
}) {
  const offline = query.fetchStatus === "paused";
  if (query.data === undefined)
    return query.error ? (
      <p role="alert" className="m-0 text-[14px] text-coral">
        {query.error.message}
      </p>
    ) : (
      <p role="status" className="m-0 text-[13px] text-ink3">
        {offline ? OFFLINE : "Loading…"}
      </p>
    );
  if (!query.error && !offline) return null;
  return (
    <p role="status" className="m-0 text-[12.5px] leading-normal text-amber">
      {offline ? "You're offline." : `Can't refresh: ${query.error!.message}`} Showing what NEXUS had at{" "}
      {clock(new Date(query.dataUpdatedAt).toISOString())}.
    </p>
  );
}

// ---------------------------------------------------------------- all jobs

function AllJobs() {
  const scope = useScope();
  const navigate = route.useNavigate();
  const blockedId = useId();
  const projectId = scope.project?.id;
  const [filters, setFilters] = useState<Filters>({});
  const set = <K extends keyof Filters>(k: K, v: Filters[K] | "") =>
    setFilters((f) => ({ ...f, [k]: v === "" ? undefined : v }));
  const filtered = Object.values(filters).some((v) => v !== undefined);
  const badRange = !!filters.from && !!filters.to && filters.from > filters.to;

  const github = useGithubStatus();
  // In a project: its bound repositories; in All: every installed one.
  const repos = useRepositories(
    github.data?.configured === true && github.data.installations.length > 0 && scope.ready,
    projectId,
  );
  const workspaces = useWorkspaces();
  const projectName = (id: string) =>
    workspaces.data?.items.flatMap((w) => w.projects).find((p) => p.id === id)?.name ?? "another project";

  // A new key per filter set, dropped once unused (gcTime 0): changing a filter, even back to an earlier one, starts
  // again from the first page instead of re-fetching every page loaded before.
  const q = { ...filters, projectId, limit: PAGE };
  const history = useInfiniteQuery({
    queryKey: keys.jobHistory(q),
    queryFn: ({ pageParam }) => api.jobHistory({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: scope.ready && !badRange,
    gcTime: 0,
    refetchInterval: HISTORY_POLL_MS,
  });
  const items = history.data?.pages.flatMap((p) => p.items) ?? [];
  const open = (drawer: string) => void navigate({ search: { ...scope.keep, drawer } });

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 min-w-0 flex-1 text-[13.5px] leading-[1.55] text-ink2">
          Every job{scope.project ? ` in ${scope.project.name}` : " across your projects"}, newest first.
          Tests and pull requests come from what NEXUS and GitHub recorded, never from the agent&apos;s own
          report.
        </p>
        <button
          type="button"
          disabled={!!scope.blocked}
          aria-describedby={scope.blocked ? blockedId : undefined}
          onClick={() => open("newjob")}
          className={primaryBtn}
        >
          New job
        </button>
      </div>
      {scope.blocked && (
        <p id={blockedId} className="m-0 text-[12.5px] leading-snug text-ink2">
          {scope.blocked}
        </p>
      )}
      <form
        role="search"
        aria-label="Filter jobs"
        onSubmit={(e) => e.preventDefault()}
        className="flex flex-wrap items-end gap-2.5 text-[12px] text-ink2"
      >
        <label className="flex min-w-[160px] flex-1 flex-col gap-1">
          Repository
          <select
            value={filters.repositoryId ?? ""}
            onChange={(e) => set("repositoryId", e.target.value)}
            className={field}
          >
            <option value="">Any repository</option>
            {(repos.data?.items ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Agent
          <select
            value={filters.agent ?? ""}
            onChange={(e) => set("agent", e.target.value as AgentKey | "")}
            className={field}
          >
            <option value="">Any agent</option>
            {(Object.keys(AGENT_LABEL) as AgentKey[]).map((a) => (
              <option key={a} value={a}>
                {AGENT_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Status
          <select
            value={filters.status ?? ""}
            onChange={(e) => set("status", e.target.value as JobStatusGroup | "")}
            className={field}
          >
            <option value="">Any status</option>
            {(Object.keys(GROUP) as JobStatusGroup[]).map((g) => (
              <option key={g} value={g}>
                {GROUP[g]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Created from
          <input
            type="date"
            value={filters.from ?? ""}
            onChange={(e) => set("from", e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1">
          to
          <input
            type="date"
            value={filters.to ?? ""}
            onChange={(e) => set("to", e.target.value)}
            className={field}
          />
        </label>
        {filtered && (
          <button type="button" onClick={() => setFilters({})} className={ghostBtn}>
            Clear filters
          </button>
        )}
      </form>
      {badRange ? (
        <p role="alert" className="m-0 text-[13px] text-coral">
          The from date is after the to date. Pick a from date on or before the to date.
        </p>
      ) : (
        <section aria-label="Job list" className="flex flex-col gap-3">
          <QueryNote query={history} />
          {history.data &&
            (items.length === 0 ? (
              <p className="m-0 text-[14px] leading-relaxed text-ink2">
                {filtered
                  ? "No jobs match these filters."
                  : `No jobs yet${scope.project ? ` in ${scope.project.name}` : ""}. Describe one in plain words with New job, start one from an issue in a repository, or run a diagnostic with Execute in the command bar.`}
              </p>
            ) : (
              <ul aria-label="Jobs" className="m-0 flex list-none flex-col gap-2.5 p-0">
                {items.map((item) => (
                  <JobRow
                    key={item.job.id}
                    item={item}
                    project={scope.project ? undefined : projectName(item.job.projectId)}
                    onOpen={() => open(`run:${item.job.id}`)}
                    scopeNoteId={blockedId}
                  />
                ))}
              </ul>
            ))}
          {history.hasNextPage && (
            <button
              type="button"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
              className={`${ghostBtn} self-start`}
            >
              {history.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
        </section>
      )}
    </>
  );
}

function jobTitle({ job }: JobHistoryItem): string {
  const r = job.request;
  if (r.jobType === "RUNNER_DIAGNOSTIC") return `Diagnostic · ${r.preset}`;
  return job.issue ? `#${job.issue.issueNumber} ${job.issue.title}` : `#${r.issueNumber}`;
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="kicker">{term}</dt>
      <dd className="m-0 truncate font-mono text-[11.5px] leading-[1.45] text-ink">{children}</dd>
    </div>
  );
}

function JobRow({
  item,
  project,
  onOpen,
  scopeNoteId,
}: {
  item: JobHistoryItem;
  /** Its project's name, shown in All. */
  project: string | undefined;
  onOpen: () => void;
  /** The list's one line saying why nothing can start here. */
  scopeNoteId: string;
}) {
  const { job, pullRequest } = item;
  const tone = jobTone(job.status);
  const status = job.status === "QUEUED" && !job.runnerId ? "Queued · held" : statusLabel(job.status);
  const title = jobTitle(item);
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-hair px-4 py-3.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left text-[15px] leading-[1.3] font-medium text-ink hover:underline"
        >
          {title}
          <span className="sr-only">, open the run</span>
        </button>
        <span className="kicker inline-flex items-center gap-1.5" style={{ color: tone }}>
          <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: tone }} />
          {status}
        </span>
      </div>
      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {project && <Fact term="Project">{project}</Fact>}
        <Fact term="Repository">{item.repositoryFullName ?? "—"}</Fact>
        <Fact term="Agent">{AGENT_LABEL[job.agent]}</Fact>
        <Fact term="Created">
          <time dateTime={job.createdAt}>{created(job.createdAt)}</time>
        </Fact>
        <Fact term="Duration">
          {item.durationMs !== null
            ? duration(item.durationMs)
            : job.startedAt && !job.finishedAt
              ? "in progress"
              : "—"}
        </Fact>
        <Fact term="Cost">{job.estimatedCostUsd === null ? "—" : money(job.estimatedCostUsd)}</Fact>
        <Fact term="Tests">{item.tests ? TESTS[item.tests] : "—"}</Fact>
        <Fact term="Pull request">
          {pullRequest && linkable(pullRequest.url) ? (
            <a
              href={pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal underline"
            >
              #{pullRequest.number} on GitHub
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            "—"
          )}
        </Fact>
        <Fact term="Outcome">{job.outcome ? OUTCOME[job.outcome] : "—"}</Fact>
      </dl>
      <RunAgain job={job} context={title} scopeNoteId={scopeNoteId} />
    </li>
  );
}

// ---------------------------------------------------------------- agent performance

const WINDOWS = [7, 30] as const;

function AgentPerformanceTab() {
  const scope = useScope();
  const projectId = scope.project?.id;
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(7);
  const q = { projectId, days };
  const perf = useQuery({
    queryKey: keys.agentPerformance(q),
    queryFn: () => api.agentPerformance(q),
    enabled: scope.ready,
    refetchInterval: PERFORMANCE_POLL_MS,
  });
  const p = perf.data;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 min-w-0 flex-1 text-[13.5px] leading-[1.55] text-ink2">
          How each agent&apos;s jobs{scope.project ? ` in ${scope.project.name}` : " across your projects"}{" "}
          ended, counted from NEXUS&apos;s records and GitHub&apos;s responses.
        </p>
        <div role="group" aria-label="Window" className="flex gap-1 rounded-xl bg-hair p-1">
          {WINDOWS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days === d}
              onClick={() => setDays(d)}
              className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${days === d ? "bg-card text-ink shadow-nx" : "text-ink2"}`}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>
      <QueryNote query={perf} />
      {p && (
        <section aria-label="Agent results" className="flex flex-col gap-3">
          <p className="m-0 font-mono text-[11.5px] leading-[1.45] text-ink2">
            <time dateTime={p.from}>{day(p.from)}</time> – <time dateTime={p.to}>{day(p.to)}</time> · as of{" "}
            <time dateTime={p.asOf}>{clock(p.asOf)}</time>
          </p>
          <p className="m-0 text-[12.5px] leading-snug text-ink2">
            Costs are provider-reported estimates, not invoices.
          </p>
          <ul aria-label="Agents" className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2">
            {p.items.map((r) => (
              <AgentCard key={r.agent} r={r} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function AgentCard({ r }: { r: AgentPerformanceRow }) {
  const decided = r.succeeded + r.failed;
  const a = r.approvals;
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-hair px-4 py-3.5">
      <h4 className="m-0 text-[15px] font-medium text-ink">{AGENT_LABEL[r.agent]}</h4>
      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2">
        <Fact term="Jobs">{r.jobs}</Fact>
        <Fact term="Success rate">
          {r.successRate === null
            ? "—"
            : `${Math.round(r.successRate * 100)}% · ${r.succeeded} of ${decided}`}
        </Fact>
        <Fact term="Pull requests">{r.pullRequests}</Fact>
        <Fact term="Cost">{money(r.costUsd)}</Fact>
        <Fact term="Cost per PR">
          {r.costPerPullRequestUsd === null ? "—" : money(r.costPerPullRequestUsd)}
        </Fact>
        <Fact term="Median to review-ready">
          {r.medianMinutesToReviewReady === null ? "—" : minutes(r.medianMinutesToReviewReady)}
        </Fact>
      </dl>
      <p className="m-0 font-mono text-[11.5px] leading-[1.45] text-ink2">
        <span className="kicker mr-1.5">Approvals</span>
        {a.approved} approved · {a.denied} denied · {a.expired} expired · {a.pending} pending
      </p>
    </li>
  );
}
