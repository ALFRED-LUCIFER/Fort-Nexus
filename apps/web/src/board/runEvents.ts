import { useEffect, useState } from "react";
import {
  JobStatus,
  RunEvent,
  SSE_RUN_EVENT,
  SandboxInfo,
  Verification,
  isTerminal,
  type Approval,
  type Job,
  type JobOutcome,
} from "@nexus/contracts";
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
  sandbox?: SandboxInfo;
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
    sandbox: SandboxInfo.safeParse(ws?.sandbox).data,
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

export type ChangeType = "added" | "modified" | "deleted";

/** What the agent run reported: its own summary (an estimate, untrusted) and the runner's changed-file scan. */
export interface AgentFacts {
  turns?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  report?: string;
  files?: { path: string; change: ChangeType }[];
  fileCount?: number;
  secretLeak?: boolean;
  failReason?: string;
  failBudget?: string;
}

// git name-status letters from the runner's artifact scan; "?" = untracked, i.e. a new file.
const CHANGE: Record<string, ChangeType> = { A: "added", "?": "added", D: "deleted" };

export function agentFacts(events: readonly RunEvent[]): AgentFacts {
  const summary = events.findLast((e) => e.type === "agent.message" && e.payload.kind === "summary")?.payload;
  const usage = summary?.usage as Record<string, unknown> | undefined;
  const art = find(events, "artifact.created")?.payload;
  const failed = find(events, "job.failed")?.payload;
  const files = Array.isArray(art?.files)
    ? art.files.flatMap((f: unknown) => {
        const { path, status } = (f ?? {}) as Record<string, unknown>;
        return typeof path === "string" ? [{ path, change: CHANGE[str(status) ?? ""] ?? "modified" }] : [];
      })
    : undefined;
  return {
    turns: num(summary?.turns),
    costUsd: num(summary?.estimatedCostUsd),
    inputTokens: num(usage?.inputTokens),
    outputTokens: num(usage?.outputTokens),
    report: str(summary?.text),
    files,
    fileCount: num(art?.fileCount),
    secretLeak: art?.secretLeak === true,
    failReason: str(failed?.reason),
    failBudget: str(failed?.budget),
  };
}

/** Plain words for NEXUS's own test result (FR-DEV-05). */
export const TEST_WORD: Record<Verification["status"], string> = {
  passed: "passed",
  failed: "failed",
  error: "couldn't run",
  not_configured: "not configured",
};

/**
 * What NEXUS itself ran after the agent: the approved action's copy once there is an approval (it is part of the
 * hash the owner decides on), else the runner's test.completed event. Never the agent's own claim.
 */
export function verificationOf(
  events: readonly RunEvent[],
  approval: Approval | null | undefined,
): Verification | undefined {
  if (approval) return approval.action.verification;
  return Verification.safeParse(find(events, "test.completed")?.payload).data;
}

export type StageState = "pending" | "active" | "waiting" | "done" | "failed" | "skipped";
export interface Stage {
  label: string;
  state: StageState;
  /** Time it finished, or a word saying why it has none. */
  note: string;
}

const ENDED_BADLY: Partial<Record<JobStatus, string>> = {
  FAILED: "failed",
  CANCELLED: "cancelled",
  RECOVERY_REQUIRED: "needs review",
  REJECTED: "rejected",
  EXPIRED: "expired",
};

/**
 * The design's six stages for an issue → draft PR run. A stage is done only when the event that proves it
 * exists; NEXUS has no plan step yet, and Test is green only when NEXUS's own test run passed.
 */
export function issueStages(
  status: JobStatus,
  outcome: JobOutcome | null,
  events: readonly RunEvent[],
  approval: Approval | null | undefined,
): Stage[] {
  const at = (pred: (e: RunEvent) => boolean) => events.find(pred)?.occurredAt;
  const state = (to: JobStatus) => at((e) => e.type === "job.state.changed" && e.payload.to === to);
  const bad = ENDED_BADLY[status];
  const noChanges = outcome === "COMPLETED_NO_CHANGES";
  const decided = events.findLast((e) => e.type === "approval.decided");
  const decision = str(decided?.payload.decision);
  const approvedAt =
    decided && (decision === "approve" || ["APPROVED", "EXECUTED", "FAILED"].includes(approval?.status ?? ""))
      ? decided.occurredAt
      : undefined;
  const denied = decision === "deny" || approval?.status === "DENIED" || outcome === "APPROVAL_DENIED";
  const expired = approval?.status === "EXPIRED" || status === "EXPIRED";

  // [started, finished] evidence per stage, in order.
  const created = at((e) => e.type === "job.created");
  const implStart = at((e) => e.type === "agent.started") ?? state("RUNNING");
  const implDone = state("VERIFYING") ?? at((e) => e.type === "artifact.created");
  const testEvent = find(events, "test.completed");
  const tested = Verification.safeParse(testEvent?.payload).data;
  const gate = at((e) => e.type === "approval.requested");
  const published = at((e) => e.type === "external_action.completed");

  const stage = (label: string, started: unknown, done: string | undefined, why?: StageState, word = "") => {
    if (done) return { label, state: "done" as const, note: clock(done) };
    if (why) return { label, state: why, note: word };
    if (started && bad) return { label, state: "failed" as const, note: bad };
    // Ended fine but this stage's event never arrived: say so rather than guess.
    if (started)
      return isTerminal(status)
        ? { label, state: "pending" as const, note: "not reported" }
        : { label, state: "active" as const, note: "now" };
    return { label, state: "pending" as const, note: "—" };
  };

  return [
    status === "REJECTED"
      ? { label: "Qualify", state: "failed", note: "rejected" }
      : stage("Qualify", true, created),
    implStart ? { label: "Plan", state: "skipped", note: "no plan step" } : stage("Plan", false, undefined),
    stage("Implement", implStart, implDone),
    noChanges
      ? { label: "Test", state: "skipped", note: "no changes" }
      : tested
        ? tested.status === "passed"
          ? stage("Test", true, testEvent?.occurredAt)
          : tested.status === "not_configured"
            ? { label: "Test", state: "skipped", note: "not configured" }
            : {
                label: "Test",
                state: "failed",
                note: tested.status === "failed" ? "tests failed" : "couldn't run",
              }
        : gate
          ? { label: "Test", state: "skipped", note: "not verified" } // runs from before FR-DEV-05
          : stage("Test", implDone, undefined),
    noChanges
      ? { label: "Review", state: "skipped", note: "no changes" }
      : denied
        ? { label: "Review", state: "failed", note: "denied" }
        : expired
          ? { label: "Review", state: "failed", note: "expired" }
          : gate && !approvedAt && !bad
            ? { label: "Review", state: "waiting", note: "waiting on you" }
            : stage("Review", gate, approvedAt),
    approval?.status === "FAILED"
      ? { label: "Draft PR", state: "failed", note: "failed" }
      : noChanges
        ? { label: "Draft PR", state: "skipped", note: "nothing to push" }
        : stage("Draft PR", approvedAt, published),
  ];
}

/** Plain-language summary of an issue run, from recorded events and the approval only. */
export function explainIssue(
  status: JobStatus,
  outcome: JobOutcome | null,
  f: AgentFacts,
  approval: Approval | null | undefined,
  runnerName: string | undefined,
  runnerOnline: boolean,
): string {
  const files = approval?.action.files.length ?? f.fileCount;
  const n = (k: number | undefined) => (k === undefined ? "Some" : String(k));
  if (approval?.status === "EXECUTED" && approval.result)
    return `You approved the push. Draft PR #${approval.result.pullRequestNumber} is open on GitHub for your review. NEXUS never merges.`;
  if (approval?.status === "APPROVED")
    return "You approved the push. The API is pushing the branch and opening the draft PR now.";
  if (approval?.status === "FAILED")
    return `You approved the push, but GitHub refused it: ${approval.error ?? "no reason given"}. Nothing was merged.`;
  switch (status) {
    case "QUEUED":
      return runnerOnline
        ? `Queued. ${runnerName ?? "The runner"} will pick it up within seconds.`
        : `Queued and held, not lost. It starts when ${runnerName ?? "a paired runner"} comes online.`;
    case "PREPARING":
      return `${runnerName ?? "The runner"} claimed the job and is fetching the repository into a fresh worktree.`;
    case "RUNNING":
      return "The agent is working on the issue in a sandbox at home. It can't reach GitHub; whatever it changes waits for your approval.";
    case "VERIFYING":
      return "The agent finished. The runner is collecting the changed files and running the repo's tests in a fresh sandbox.";
    case "AWAITING_APPROVAL": {
      const tests = {
        passed: " NEXUS ran the tests in the sandbox and they passed.",
        failed: " NEXUS ran the tests in the sandbox and they FAILED: check them before you approve.",
        error: " NEXUS couldn't run the tests: check why before you approve.",
        not_configured: " The tests were not verified by NEXUS.",
      }[approval?.action.verification.status ?? "not_configured"];
      return `${n(files)} ${files === 1 ? "file" : "files"} changed. Nothing has been pushed.${approval ? tests : ""} Check the exact action below, then approve or deny the push.`;
    }
    case "COMPLETED":
      if (outcome === "COMPLETED_NO_CHANGES")
        return "The agent made no changes, so there is nothing to push.";
      if (outcome === "APPROVAL_DENIED") return "You denied the push. Nothing was pushed to GitHub.";
      return "The run completed.";
    case "CANCELLED":
      return "Cancelled at your request. Nothing was pushed.";
    case "EXPIRED":
      return "The approval expired without a decision. Nothing was pushed. Start a new run to try again.";
    case "FAILED":
      if (f.failReason === "budget_exceeded" || outcome === "BUDGET_EXCEEDED" || outcome === "TIMED_OUT") {
        const which = outcome === "TIMED_OUT" ? "wall_clock" : (f.failBudget ?? "");
        const word = { wall_clock: "time ", cost: "cost ", turns: "turn " }[which] ?? "";
        return `The agent hit its ${word}budget and was stopped. Nothing was pushed.`;
      }
      return `The run failed${f.failReason ? ` (${f.failReason.replaceAll("_", " ")})` : ""}. Nothing was pushed.`;
    default:
      return explain(status, {}, runnerName, runnerOnline);
  }
}

export interface TermLine {
  seq: number;
  t: string;
  k: string;
  m: string;
  tone: string;
  /** Rows the owner must not miss (blocked egress). */
  alert?: string;
}

const MUTED = "#78746b";
const TEAL = "oklch(0.78 0.09 195)";
const GREEN = "oklch(0.78 0.10 155)";
const CORAL = "oklch(0.74 0.14 32)";
const VIOLET = "oklch(0.76 0.08 290)";
const AMBER = "oklch(0.82 0.12 70)";

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
      return p.engine === "claude-agent-sdk"
        ? line("agent", `started · ${str(p.model) ?? "model ?"}`, VIOLET)
        : line("exec", `$ ${runFacts([e]).argv ?? str(p.preset) ?? ""}`, VIOLET);
    case "agent.message":
      if (p.kind === "summary") {
        const f = agentFacts([e]);
        return line(
          "summary",
          `${f.turns ?? "?"} turns · ${f.inputTokens ?? "?"} in / ${f.outputTokens ?? "?"} out tokens · $${f.costUsd?.toFixed(2) ?? "?"} (estimate)`,
          VIOLET,
        );
      }
      if (p.kind === "error") return line("agent", `error · ${str(p.error) ?? "unknown"}`, CORAL);
      if (p.kind === "api_retry") return line("retry", `model API retry ${num(p.attempt) ?? ""}`.trim());
      return line("agent", str(p.text) ?? "", "#d9d4ca");
    case "tool.requested":
      return line("tool", `${str(p.tool) ?? "?"} ${str(p.summary) ?? ""}`.trim(), TEAL);
    case "tool.denied":
      return {
        ...line(
          "denied",
          `${p.phase === "verify" ? "tests · " : ""}${p.kind === "egress" ? "network blocked → " : ""}${str(p.target) ?? str(p.tool) ?? "?"}`,
          CORAL,
        ),
        alert: "Blocked: ",
      };
    case "artifact.created":
      return line(
        "diff",
        `${num(p.fileCount) ?? "?"} files changed${p.secretLeak === true ? " · SECRET FOUND — will not be pushed" : ""}`,
        p.secretLeak === true ? CORAL : GREEN,
      );
    case "test.completed": {
      const v = Verification.safeParse(p).data;
      if (!v) return line("tests", "result unreadable", CORAL);
      const cmd = v.test ? ` · ${v.test.join(" ")}` : "";
      const exit = v.exitCode === null ? "" : ` · exit ${v.exitCode}`;
      const tone = v.status === "passed" ? GREEN : v.status === "not_configured" ? MUTED : CORAL;
      return line("tests", `${TEST_WORD[v.status]}${cmd}${exit} · ${duration(v.durationMs)}`, tone);
    }
    case "approval.requested":
      return line("gate", "waiting for you: push branch + open draft PR", AMBER);
    case "approval.decided":
      return line("gate", `${str(p.decision) ?? "decided"} by owner`, AMBER);
    case "external_action.completed":
      return line(
        "github",
        `draft PR ${num(p.pullRequestNumber) ? `#${num(p.pullRequestNumber)} ` : ""}opened`,
        GREEN,
      );
    case "process.output":
      return line(str(p.stream) ?? "out", str(p.text) ?? "", p.stream === "stderr" ? CORAL : "#d9d4ca");
    case "tool.completed":
      if (p.toolUseId !== undefined)
        return p.isError === true
          ? line("tool", `${str(p.tool) ?? "?"} failed · ${str(p.error) ?? ""}`, CORAL)
          : line("tool", `${str(p.tool) ?? "?"} done`);
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
