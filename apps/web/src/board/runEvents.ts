import { useEffect, useState } from "react";
import { JobStatus, RunEvent, SSE_RUN_EVENT, type Job } from "@nexus/contracts";
import { clock, duration } from "../lib/queries.ts";

export type StreamState = "connecting" | "live" | "reconnecting" | "ended";
const RECONNECT_MS = 3_000;

/** Inserts an event in sequence order; a sequence already seen (reconnect replay) is dropped. */
export function mergeEvent(list: readonly RunEvent[], e: RunEvent): readonly RunEvent[] {
  if (list.some((x) => x.sequence === e.sequence)) return list;
  const next = [...list, e];
  const last = list.at(-1);
  if (last && last.sequence > e.sequence) next.sort((a, b) => a.sequence - b.sequence);
  return next;
}

/**
 * Follows GET /v1/jobs/:id/events. The browser's own retry resumes with Last-Event-ID; if the
 * stream is closed for good (e.g. API restart), we reopen it with ?afterSequence=<last seen>.
 * Mount with `key={jobId}` so state starts empty per job.
 */
export function useRunEvents(jobId: string) {
  const [events, setEvents] = useState<readonly RunEvent[]>([]);
  const [stream, setStream] = useState<StreamState>("connecting");

  useEffect(() => {
    let es: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const connect = () => {
      es = new EventSource(
        `/v1/jobs/${encodeURIComponent(jobId)}/events${last ? `?afterSequence=${last}` : ""}`,
      );
      const source = es;
      source.onopen = () => setStream("live");
      source.addEventListener(SSE_RUN_EVENT, (m: MessageEvent<string>) => {
        let data: unknown;
        try {
          data = JSON.parse(m.data);
        } catch {
          return;
        }
        const parsed = RunEvent.safeParse(data);
        if (!parsed.success) return;
        last = Math.max(last, parsed.data.sequence);
        setEvents((prev) => mergeEvent(prev, parsed.data));
      });
      source.addEventListener("end", () => {
        source.close();
        setStream("ended");
      });
      source.onerror = () => {
        setStream("reconnecting");
        if (source.readyState === EventSource.CLOSED) timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();
    return () => {
      clearTimeout(timer);
      es?.close();
    };
  }, [jobId]);

  return { events, stream };
}

// Payload fields are untyped in the contract (record<string, unknown>), so read them defensively.
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const find = (events: readonly RunEvent[], type: RunEvent["type"]) => events.findLast((e) => e.type === type);

/** The newest status: from the stream when it is at least as fresh as the polled job. */
export function liveStatus(job: Job, events: readonly RunEvent[]): JobStatus {
  const change = events.findLast(
    (e) => e.type === "job.state.changed" && JobStatus.safeParse(e.payload.to).success,
  );
  return change && change.sequence >= job.lastEventSequence ? (change.payload.to as JobStatus) : job.status;
}

export interface RunFacts {
  hostname?: string;
  pid?: number;
  argv?: string;
  exitCode?: number;
  durationMs?: number;
}

export function runFacts(events: readonly RunEvent[]): RunFacts {
  const ws = find(events, "workspace.created")?.payload;
  const start = find(events, "agent.started")?.payload;
  const done = find(events, "tool.completed")?.payload;
  const argv = Array.isArray(start?.argv)
    ? start.argv.filter((a): a is string => typeof a === "string").join(" ")
    : undefined;
  return {
    hostname: str(ws?.hostname),
    pid: num(ws?.pid),
    argv,
    exitCode: num(done?.exitCode),
    durationMs: num(done?.durationMs),
  };
}

/** Plain-language summary built only from recorded events (truth hierarchy: runner evidence first). */
export function explain(
  status: JobStatus,
  f: RunFacts,
  runnerName: string | undefined,
  runnerOnline: boolean,
): string {
  if (status === "RECOVERY_REQUIRED")
    return "The runner stopped reporting while this run was in progress, so NEXUS can't confirm how it ended. It will not be retried automatically. Check the runner, then start a new run if you still need the result.";
  const where = f.hostname ? ` on ${f.hostname}${f.pid ? `, pid ${f.pid}` : ""}` : "";
  const what = f.argv ? `Ran ${f.argv}${where}.` : "";
  const exit =
    f.exitCode === undefined
      ? ""
      : ` Exited with code ${f.exitCode}${f.durationMs === undefined ? "" : ` after ${duration(f.durationMs)}`}.`;
  switch (status) {
    case "QUEUED":
      return runnerOnline
        ? `Queued. ${runnerName ?? "The runner"} will pick it up within seconds.`
        : `Queued and held, not lost. It starts when ${runnerName ?? "a paired runner"} comes online.`;
    case "PREPARING":
      return `${runnerName ?? "The runner"} claimed the job and is preparing a fresh workspace.`;
    case "RUNNING":
    case "VERIFYING":
      return what ? `Running ${f.argv}${where}.${exit}` : "Running on the home machine.";
    case "COMPLETED":
      return `${what}${exit} The runner reported success.`.trim();
    case "FAILED":
      return `${what}${exit} The runner reported a failure.`.trim();
    case "CANCELLED":
      return what
        ? `${what} Cancelled at your request; the runner confirmed the process stopped.`
        : "Cancelled before it started.";
    default:
      return `Status: ${status}.`;
  }
}

export interface TermLine {
  seq: number;
  t: string;
  k: string;
  m: string;
  tone: string;
}

const MUTED = "#78746b";
const TEAL = "oklch(0.78 0.09 195)";
const GREEN = "oklch(0.78 0.10 155)";
const CORAL = "oklch(0.74 0.14 32)";
const VIOLET = "oklch(0.76 0.08 290)";

export function toLine(e: RunEvent): TermLine {
  const p = e.payload;
  const line = (k: string, m: string, tone = MUTED) => ({
    seq: e.sequence,
    t: clock(e.occurredAt),
    k,
    m,
    tone,
  });
  switch (e.type) {
    case "job.created":
      return line("system", "job accepted");
    case "job.state.changed":
      return line("state", `→ ${str(p.to) ?? "?"}`, TEAL);
    case "workspace.created":
      return line("host", `${str(p.hostname) ?? "?"} · pid ${num(p.pid) ?? "?"} · ${str(p.cwd) ?? ""}`);
    case "agent.started":
      return line("exec", `$ ${runFacts([e]).argv ?? str(p.preset) ?? ""}`, VIOLET);
    case "process.output":
      return line(str(p.stream) ?? "out", str(p.text) ?? "", p.stream === "stderr" ? CORAL : "#d9d4ca");
    case "tool.completed":
      return line(
        "exit",
        `code ${num(p.exitCode) ?? "?"} · ${duration(num(p.durationMs) ?? 0)}`,
        p.exitCode === 0 ? GREEN : CORAL,
      );
    case "job.completed":
      return line("done", str(p.outcome) ?? "completed", GREEN);
    case "job.failed":
      return line("failed", str(p.outcome) ?? str(p.reason) ?? "failed", CORAL);
    case "job.cancelled":
      return line("cancel", "cancelled · process stopped");
    case "job.recovery_required":
      return line("recovery", "runner lease expired · needs your review", CORAL);
    default:
      return line(e.type.split(".").at(-1) ?? e.type, JSON.stringify(p).slice(0, 200));
  }
}
