import { useEffect, useRef, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isTerminal, type JobStatus, type RunEvent } from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { duration, jobTone, statusLabel, useRunners } from "../lib/queries.ts";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";
import { explain, liveStatus, runFacts, toLine, useRunEvents, type StreamState } from "./runEvents.ts";

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

  const cancel = useMutation({
    mutationFn: () => api.cancelJob(jobId),
    onSuccess: (j) => {
      queryClient.setQueryData(keys.job(jobId), j);
      void queryClient.invalidateQueries({ queryKey: keys.jobs });
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
  const preset = j.request.preset;
  const startedAt = events.find(
    (e) => e.type === "job.state.changed" && e.payload.to === "RUNNING",
  )?.occurredAt;
  const endedAt = terminal ? events.findLast((e) => e.type === "job.state.changed")?.occurredAt : undefined;
  const dur =
    facts.durationMs ??
    (startedAt && endedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : undefined);

  return (
    <>
      <DrawerHeader
        kicker={`Run · diagnostic · ${j.id.slice(0, 8)}`}
        title={`${preset} on ${runner?.name ?? facts.hostname ?? "the home machine"}`}
      />
      <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-6 pt-5 pb-6">
        <StageBar status={status} events={events} />
        <div
          className="flex flex-none items-start gap-2.5 rounded-2xl px-4 py-3.5"
          style={{ background: "oklch(0.60 0.08 195 / .09)" }}
        >
          <span className="flex-none font-serif text-[20px] leading-none text-teal italic">Explain</span>
          <p className="m-0 text-[13px] leading-[1.55] text-pretty text-ink2">
            {explain(status, facts, runnerName, online)}
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
        <div className="grid flex-none grid-cols-2 gap-2.5 sm:grid-cols-5">
          <Stat k="status" v={statusLabel(status)} />
          <Stat k="runner" v={runner?.name ?? (j.runnerId ? j.runnerId.slice(0, 8) : "not claimed yet")} />
          <Stat k="duration" v={dur === undefined ? "—" : duration(dur)} />
          <Stat k="exit code" v={facts.exitCode === undefined ? "—" : String(facts.exitCode)} />
          <Stat
            k="sandbox"
            v={
              facts.sandbox
                ? [
                    facts.sandbox.runtime === "none" ? "none · host" : facts.sandbox.runtime,
                    facts.sandbox.image,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "—"
            }
          />
        </div>
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

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[14px] bg-hair px-3 py-2.5">
      <span className="font-mono text-[10.5px] text-ink3">{k}</span>
      <span className="text-[13px] font-medium break-words">{v}</span>
    </div>
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
                  className="absolute top-0 left-0 grid w-full grid-cols-[62px_74px_minmax(0,1fr)] gap-2.5 pb-1"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <span className="text-[#5e5a52]">{ln.t}</span>
                  <span style={{ color: ln.tone }}>{ln.k}</span>
                  <span className="break-words whitespace-pre-wrap text-[#d9d4ca]">{ln.m}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
