import { useEffect, useRef, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isTerminal, type JobStatus, type RunEvent, type Verification } from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import {
  duration,
  jobTone,
  statusLabel,
  useGithubStatus,
  useJobApproval,
  useRepositories,
  useRunners,
} from "../lib/queries.ts";
import { ApprovalGate } from "./approval.tsx";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";
import {
  agentFacts,
  explain,
  explainIssue,
  issueStages,
  liveStatus,
  runFacts,
  toLine,
  useRunEvents,
  verificationOf,
  type AgentFacts,
  type ChangeType,
  type Stage,
  type StageState,
  type StreamState,
} from "./runEvents.ts";

const POLL_MS = 5_000;

export function RunDrawer({
  jobId,
  banner,
  onClose,
}: {
  jobId: string;
  banner?: ReactNode;
  onClose: () => void;
}) {
  return (
    <Drawer banner={banner} onClose={onClose}>
      <RunBody key={jobId} jobId={jobId} />
    </Drawer>
  );
}

function RunBody({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient();
  const job = useQuery({
    queryKey: keys.job(jobId),
    queryFn: () => api.job(jobId),
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data.status) ? false : POLL_MS),
  });
  const runners = useRunners();
  const { events, stream } = useRunEvents(jobId);

  const status = job.data ? liveStatus(job.data, events) : undefined;
  const terminal = status ? isTerminal(status) : false;
  useEffect(() => {
    if (terminal || stream === "ended") void queryClient.invalidateQueries({ queryKey: keys.jobs });
  }, [terminal, stream, queryClient]);

  const issueReq = job.data?.request.jobType === "DEV_ISSUE_TO_PR" ? job.data.request : undefined;
  const approval = useJobApproval(jobId, !!issueReq, terminal);
  const github = useGithubStatus();
  const repos = useRepositories(!!issueReq && github.data?.configured === true);
  // Gate events mean the approval changed: fetch it now instead of waiting for the next poll.
  const gateEvents = events.filter(
    (e) => e.type.startsWith("approval.") || e.type === "external_action.completed",
  ).length;
  useEffect(() => {
    if (gateEvents) void queryClient.invalidateQueries({ queryKey: keys.approvalsBy({ jobId }) });
  }, [gateEvents, jobId, queryClient]);

  const cancel = useMutation({
    mutationFn: () => api.cancelJob(jobId),
    onSuccess: (j) => {
      queryClient.setQueryData(keys.job(jobId), j);
      void queryClient.invalidateQueries({ queryKey: keys.jobs });
      void queryClient.invalidateQueries({ queryKey: keys.approvals });
    },
  });

  if (!job.data || !status) {
    return (
      <>
        <DrawerHeader kicker="Run" title={job.error ? "Can't open this run" : "Loading run…"} />
        <DrawerState error={job.error} />
      </>
    );
  }

  const j = job.data;
  const runner = runners.data?.find((r) => r.id === j.runnerId);
  const online = runners.data?.some((r) => r.status === "ONLINE") ?? false;
  const runnerName =
    runner?.name ?? (j.runnerId ? undefined : runners.data?.find((r) => r.status !== "REVOKED")?.name);
  const facts = runFacts(events);
  const startedAt = events.find(
    (e) => e.type === "job.state.changed" && e.payload.to === "RUNNING",
  )?.occurredAt;
  const endedAt = terminal ? events.findLast((e) => e.type === "job.state.changed")?.occurredAt : undefined;
  const dur =
    facts.durationMs ??
    (startedAt && endedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : undefined);

  const a = approval.data;
  const agent = issueReq ? agentFacts(events) : undefined;
  const cost = agent?.costUsd ?? j.estimatedCostUsd ?? undefined;
  const verification = issueReq ? verificationOf(events, a) : undefined;
  const repoName =
    a?.action.repositoryFullName ??
    j.issue?.fullName ??
    repos.data?.items.find((r) => r.id === issueReq?.repositoryId)?.fullName;
  const sandboxStat = facts.sandbox
    ? [facts.sandbox.runtime === "none" ? "none · host" : facts.sandbox.runtime, facts.sandbox.image]
        .filter(Boolean)
        .join(" · ")
    : "—";

  return (
    <>
      {issueReq ? (
        <DrawerHeader
          kicker={`Run · issue → draft PR · #${issueReq.issueNumber} on ${repoName ?? "its repository"} · ${j.id.slice(0, 8)}`}
          title={j.issue?.title ?? `#${issueReq.issueNumber} on ${repoName ?? "its repository"}`}
        />
      ) : (
        <DrawerHeader
          kicker={`Run · diagnostic · ${j.id.slice(0, 8)}`}
          title={`${j.request.jobType === "RUNNER_DIAGNOSTIC" ? j.request.preset : ""} on ${runner?.name ?? facts.hostname ?? "the home machine"}`}
        />
      )}
      <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-6 pt-5 pb-6">
        {issueReq ? (
          <Stages stages={issueStages(status, j.outcome, events, a)} />
        ) : (
          <StageBar status={status} events={events} />
        )}
        <div
          className="flex flex-none items-start gap-2.5 rounded-2xl px-4 py-3.5"
          style={{ background: "oklch(0.60 0.08 195 / .09)" }}
        >
          <span className="flex-none font-serif text-[20px] leading-none text-teal italic">Explain</span>
          <p className="m-0 text-[13px] leading-[1.55] text-pretty text-ink2">
            {agent
              ? explainIssue(status, j.outcome, agent, a, runnerName, online)
              : explain(status, facts, runnerName, online)}
          </p>
        </div>
        {facts.sandbox?.runtime === "none" && (
          <p
            role="note"
            className="m-0 flex-none rounded-2xl px-4 py-3 text-[13px] leading-[1.5] text-ink"
            style={{ background: "oklch(0.70 0.13 65 / .16)" }}
          >
            <strong className="font-medium">Not sandboxed.</strong> This run executed directly on the home
            machine, not in a container (the runner is set to RUNNER_SANDBOX=none).
          </p>
        )}
        <Terminal events={events} stream={stream} status={status} runnerName={runner?.name ?? runnerName} />
        {agent?.secretLeak && (
          <p
            role="alert"
            className="m-0 flex-none rounded-2xl px-4 py-3 text-[13px] leading-[1.5] text-ink"
            style={{ background: "oklch(0.62 0.15 32 / .14)" }}
          >
            <strong className="font-medium">Secret found in the changes.</strong> The runner found a provider
            key in a changed file, so this run will not be pushed.
          </p>
        )}
        {issueReq && agent ? (
          <>
            <div className="grid flex-none gap-3.5 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <Changes
                files={a?.action.files ?? agent.files}
                total={a?.action.files.length ?? agent.fileCount}
                stats={a?.action.stats}
              />
              <div className="flex min-w-0 flex-col gap-3">
                {a && <ApprovalGate approval={a} jobCancelled={status === "CANCELLED"} />}
                {approval.error && (
                  <p role="alert" className="m-0 text-[12.5px] text-coral">
                    Can&apos;t load the approval: {approval.error.message}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2.5">
                  <Stat k="status" v={statusLabel(status)} />
                  <Stat k="elapsed" v={dur === undefined ? "—" : duration(dur)} />
                  <Stat k="turns" v={`${agent.turns ?? "—"} / ${issueReq.budget.maxTurns}`} />
                  <Stat
                    k="cost (estimate)"
                    v={`${cost === undefined ? "—" : `$${cost.toFixed(2)}`} / $${issueReq.budget.maxCostUsd}`}
                  />
                  <Stat k="tokens in / out" v={tokens(agent)} />
                  <Stat
                    k="branch"
                    v={a?.action.headBranch ?? j.issue?.workBranch ?? "named when changes are ready"}
                  />
                  <Stat
                    k="runner"
                    v={runner?.name ?? (j.runnerId ? j.runnerId.slice(0, 8) : "not claimed yet")}
                  />
                  <Stat k="sandbox" v={sandboxStat} />
                </div>
              </div>
            </div>
            {verification && <TestsCard v={verification} />}
            {agent.report && (
              <section
                aria-labelledby="agent-report"
                className="flex flex-none flex-col gap-2 rounded-[18px] border border-hair p-4"
              >
                <h3 id="agent-report" className="kicker m-0">
                  Agent report (unverified)
                </h3>
                <p className="m-0 text-[13px] leading-[1.55] break-words whitespace-pre-wrap text-ink2">
                  {agent.report}
                </p>
              </section>
            )}
          </>
        ) : (
          <div className="grid flex-none grid-cols-2 gap-2.5 sm:grid-cols-5">
            <Stat k="status" v={statusLabel(status)} />
            <Stat k="runner" v={runner?.name ?? (j.runnerId ? j.runnerId.slice(0, 8) : "not claimed yet")} />
            <Stat k="duration" v={dur === undefined ? "—" : duration(dur)} />
            <Stat k="exit code" v={facts.exitCode === undefined ? "—" : String(facts.exitCode)} />
            <Stat k="sandbox" v={sandboxStat} />
          </div>
        )}
        {!terminal && status !== "RECOVERY_REQUIRED" && (
          <div className="flex flex-none flex-col items-end gap-2">
            <button
              type="button"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
              className="rounded-xl border border-hair px-4 py-2.5 text-[12.5px] font-medium text-coral disabled:opacity-60"
            >
              {cancel.isPending ? "Cancelling…" : "Cancel run"}
            </button>
            {cancel.error && (
              <p role="alert" className="m-0 text-[12.5px] text-coral">
                {cancel.error.message}
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

const TESTS_TONE: Record<Verification["status"], string> = {
  passed: "var(--green)",
  failed: "var(--amber)",
  error: "var(--amber)",
  not_configured: "var(--hair)",
};

/** FR-DEV-05: what NEXUS itself ran after the agent, kept apart from the agent's own (unverified) report. */
function TestsCard({ v }: { v: Verification }) {
  const heading = {
    passed: "Tests passed",
    failed: `Tests failed${v.exitCode === null ? "" : ` · exit code ${v.exitCode}`}`,
    error: "Tests couldn't run",
    not_configured: "Tests not verified by NEXUS",
  }[v.status];
  const facts: [string, string][] = [
    ...(v.install ? ([["install", v.install.join(" ")]] as [string, string][]) : []),
    ...(v.test ? ([["test", v.test.join(" ")]] as [string, string][]) : []),
    ["exit code", v.exitCode === null ? "—" : String(v.exitCode)],
    ["duration", duration(v.durationMs)],
    [
      "config",
      v.source === "nexus.json"
        ? ".nexus.json (base commit)"
        : v.source === "package.json"
          ? "package.json (auto-detected)"
          : "—",
    ],
  ];
  return (
    <section
      aria-labelledby="tests-title"
      data-status={v.status}
      className="flex flex-none flex-col gap-2.5 rounded-[18px] border p-4"
      style={{ borderColor: TESTS_TONE[v.status] }}
    >
      <span className="kicker">
        {v.status === "not_configured" ? "Tests · not run" : "Tests · run by NEXUS in the sandbox"}
      </span>
      <h3 id="tests-title" className="m-0 text-[15px] leading-tight font-medium text-ink">
        {heading}
      </h3>
      {v.status === "not_configured" ? (
        <p className="m-0 text-[12.5px] leading-[1.5] text-ink2">
          No test setup at the base commit (no <code className="font-mono">.nexus.json</code>, and no
          package.json test script with a lockfile). Anything the agent says about tests is its own claim: see
          the agent report (unverified).
        </p>
      ) : (
        <>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[11.5px] leading-[1.45]">
            {facts.map(([k, val]) => (
              <div key={k} className="contents">
                <dt className="text-ink3">{k}</dt>
                <dd className="m-0 break-words text-ink2">{val}</dd>
              </div>
            ))}
          </dl>
          <pre
            // Scrollable output must be keyboard-reachable (WCAG 2.1.1).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            aria-label="Test output (last lines, redacted)"
            className="m-0 max-h-56 overflow-auto rounded-xl bg-term p-3 font-mono text-[11.5px] leading-[1.5] break-words whitespace-pre-wrap text-[#d9d4ca]"
          >
            {v.outputTail.trim() || "(no output)"}
          </pre>
        </>
      )}
    </section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[14px] bg-hair px-3 py-2.5">
      <span className="font-mono text-[10.5px] text-ink3">{k}</span>
      <span className="text-[13px] font-medium break-words">{v}</span>
    </div>
  );
}

const tokens = (f: AgentFacts) =>
  f.inputTokens === undefined ? "—" : `${kilo(f.inputTokens)} / ${kilo(f.outputTokens ?? 0)}`;
const kilo = (n: number) => (n < 1000 ? String(n) : `${Math.round(n / 1000)}k`);

const CHANGE_TONE: Record<ChangeType, string> = {
  added: "var(--green)",
  modified: "var(--amber)",
  deleted: "var(--coral)",
};

/** Changed files: the approval's exact list once it exists, the runner's scan before that. */
function Changes({
  files,
  total,
  stats,
}: {
  files: readonly { path: string; change: ChangeType }[] | undefined;
  total: number | undefined;
  stats: { added: number; removed: number } | undefined;
}) {
  return (
    <section
      aria-labelledby="changes-title"
      className="min-w-0 overflow-hidden rounded-[18px] border border-hair"
    >
      <h3
        id="changes-title"
        className="m-0 border-b border-hair px-4 py-3 text-[13px] leading-none font-medium text-ink"
      >
        Changed files
        {stats && (
          <span className="ml-1.5 font-mono text-[12px] font-normal">
            · <span className="text-green">+{stats.added}</span>{" "}
            <span className="text-coral">−{stats.removed}</span>
          </span>
        )}
      </h3>
      {!files?.length ? (
        <p className="m-0 px-4 py-3 text-[12.5px] text-ink3">No changes reported yet.</p>
      ) : (
        <ul className="m-0 max-h-[260px] list-none overflow-auto p-0">
          {files.map((f) => (
            <li
              key={f.path}
              className="flex justify-between gap-2.5 border-b border-hair px-4 py-2 font-mono text-[11.5px] leading-[1.3]"
            >
              <span title={f.path} className="truncate text-ink2">
                {f.path}
              </span>
              <span className="flex-none" style={{ color: CHANGE_TONE[f.change] }}>
                {f.change}
              </span>
            </li>
          ))}
          {total !== undefined && total > files.length && (
            <li className="px-4 py-2 font-mono text-[11.5px] text-ink3">
              +{total - files.length} more not listed
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

const STAGE_TONE: Record<StageState, string> = {
  done: "var(--green)",
  active: "var(--teal)",
  waiting: "var(--amber)",
  failed: "var(--coral)",
  skipped: "var(--hair)",
  pending: "var(--hair)",
};
const STAGE_SR: Record<StageState, string> = {
  done: "done",
  active: "in progress",
  waiting: "waiting for you",
  failed: "stopped",
  skipped: "skipped",
  pending: "not started",
};

/** The design's six-stage bar for issue runs; states come from issueStages (event evidence only). */
function Stages({ stages }: { stages: readonly Stage[] }) {
  return (
    <ol
      aria-label="Run stages"
      className="m-0 grid flex-none list-none grid-cols-3 gap-1.5 p-0 sm:grid-cols-6"
    >
      {stages.map((s) => (
        <li
          key={s.label}
          data-state={s.state}
          aria-current={s.state === "active" || s.state === "waiting" ? "step" : undefined}
          className="flex min-w-0 flex-col gap-[7px]"
        >
          <span className="h-1 rounded-sm" style={{ background: STAGE_TONE[s.state] }} />
          <span
            className={`truncate text-[11.5px] font-medium ${s.state === "pending" || s.state === "skipped" ? "text-ink3" : "text-ink"}`}
          >
            {s.label}
            <span className="sr-only">: {STAGE_SR[s.state]}</span>
          </span>
          <span className="font-mono text-[10.5px] text-ink3">{s.note}</span>
        </li>
      ))}
    </ol>
  );
}

const STEPS: readonly JobStatus[] = ["QUEUED", "PREPARING", "RUNNING", "VERIFYING"];

/** The job lifecycle as a 5-step bar; each step is green only if an event shows it was reached. */
function StageBar({ status, events }: { status: JobStatus; events: readonly RunEvent[] }) {
  const reachedAt = new Map<string, string>();
  for (const e of events)
    if (e.type === "job.state.changed" && typeof e.payload.to === "string")
      reachedAt.set(e.payload.to, e.occurredAt);
  const terminal = isTerminal(status);
  // RECOVERY_REQUIRED marks the last step the runner was seen in.
  const current =
    status === "RECOVERY_REQUIRED"
      ? STEPS.findLastIndex((s) => reachedAt.has(s))
      : terminal
        ? 4
        : STEPS.indexOf(status);
  const steps = [...STEPS.map((s) => statusLabel(s)), terminal ? statusLabel(status) : "Finished"];
  return (
    <ol aria-label="Run stages" className="m-0 grid flex-none list-none grid-cols-5 gap-1.5 p-0">
      {steps.map((label, i) => {
        const s = STEPS[i];
        const isNow = i === current;
        const done = !isNow && !!s && (reachedAt.has(s) || (!terminal && current > i));
        const color = isNow
          ? STEPS.includes(status)
            ? "var(--teal)"
            : jobTone(status)
          : done
            ? "var(--green)"
            : "var(--hair)";
        const at = s ? reachedAt.get(s) : terminal ? reachedAt.get(status) : undefined;
        return (
          <li
            key={label + i}
            aria-current={isNow ? "step" : undefined}
            className="flex min-w-0 flex-col gap-[7px]"
          >
            <span className="h-1 rounded-sm" style={{ background: color }} />
            <span
              className={`truncate text-[11.5px] font-medium ${isNow || done ? "text-ink" : "text-ink3"}`}
            >
              {label}
            </span>
            <span className="font-mono text-[10.5px] text-ink3">
              {at ? new Date(at).toLocaleTimeString([], { hour12: false }) : "—"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const STREAM_TEXT: Record<StreamState, string> = {
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting · nothing is lost",
  ended: "stream ended",
};

function Terminal({
  events,
  stream,
  status,
  runnerName,
}: {
  events: readonly RunEvent[];
  stream: StreamState;
  status: JobStatus;
  runnerName: string | undefined;
}) {
  const lines = events.map(toLine);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Known: the React Compiler skips this component because TanStack Virtual mutates its instance in place.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 19,
    overscan: 20,
  });
  useEffect(() => {
    if (lines.length) virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
  }, [lines.length, virtualizer]);

  // "Live" only while the runner is actually executing; RECOVERY_REQUIRED keeps the stream open but nothing runs.
  const live =
    stream === "live" && (status === "PREPARING" || status === "RUNNING" || status === "VERIFYING");
  return (
    <div className="flex-none overflow-hidden rounded-[18px] bg-term">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-white/[.07] px-4 py-[11px]">
        <span
          aria-hidden="true"
          className={`size-[7px] rounded-full ${live ? "nx-pulse" : ""}`}
          style={{ background: live ? "oklch(0.78 0.10 155)" : "#78746b" }}
        />
        <span className="text-[12px] font-medium text-[#eeeae2]">
          {runnerName ? `${live ? "Live on" : "Output from"} ${runnerName}` : live ? "Live output" : "Output"}
        </span>
        <span role="status" aria-live="polite" className="font-mono text-[11px] text-[#78746b]">
          {statusLabel(status)} · {STREAM_TEXT[stream]} · redacted · reconnect-safe
        </span>
      </div>
      <div
        ref={scrollRef}
        // Scrollable output must be keyboard-reachable (WCAG 2.1.1).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="region"
        aria-label="Run output"
        className="max-h-[300px] overflow-auto px-4 py-3.5 font-mono text-[12px] leading-[1.6]"
      >
        {lines.length === 0 ? (
          <p className="m-0 text-[#78746b]">No output yet.</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const ln = lines[row.index]!;
              return (
                <div
                  key={ln.seq}
                  data-index={row.index}
                  data-seq={ln.seq}
                  ref={virtualizer.measureElement}
                  data-alert={ln.alert ? "" : undefined}
                  className={`absolute top-0 left-0 grid w-full grid-cols-[62px_74px_minmax(0,1fr)] gap-2.5 pb-1 ${ln.alert ? "rounded bg-[oklch(0.62_0.15_32/.22)]" : ""}`}
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <span className="text-[#5e5a52]">{ln.t}</span>
                  <span style={{ color: ln.tone }}>{ln.k}</span>
                  <span className="break-words whitespace-pre-wrap text-[#d9d4ca]">
                    {ln.alert && <span className="sr-only">{ln.alert}</span>}
                    {ln.m}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
