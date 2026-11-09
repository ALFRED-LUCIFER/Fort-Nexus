import {
  QaReview,
  StuckReport,
  Verification,
  isTerminal,
  type Approval,
  type Job,
  type JobHistoryItem,
  type JobStatus,
  type RunEvent,
} from "@nexus/contracts";
import { changedFiles, verificationOf } from "./runEvents.ts";

// What the repair loop reported, read from the run's events. Rounds, test runs and stop reasons are NEXUS's own
// facts; phase text, QA and the stuck report's guess are model output and are labelled that way where shown.

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const PHASES = ["understand", "spec", "grill", "red", "green", "review"] as const;
export type Phase = (typeof PHASES)[number];

export interface LoopRound {
  round: number;
  of: number;
  kind: "attempt" | "repair";
  /** The runner's code and sentence for how the round ended; unset while it runs. */
  result?: string;
  summary?: string;
  /** NEXUS test runs that count as the job's result, in order. */
  tests: Verification[];
}

export interface LoopView {
  rounds: LoopRound[];
  /** The test run Keep fixing makes before any model spend (it is not a round). */
  opening?: Verification;
  /** Extra checks NEXUS ran along the way: the tests on the base commit, or the new tests without the change. */
  checks: { only: "base" | "red"; verification: Verification }[];
  phases: { phase: Phase; text: string; round: number | undefined }[];
  qa?: QaReview & { round: number | undefined };
  /** Feedback id -> the round that picked it up, from the runner's own event. */
  delivered: ReadonlyMap<string, number>;
  stopped?: { reason: string; unusedFeedback: string[]; questions: string[] };
}

export function loopOf(events: readonly RunEvent[]): LoopView {
  const view: LoopView = { rounds: [], checks: [], phases: [], delivered: new Map() };
  const delivered = view.delivered as Map<string, number>;
  for (const e of events) {
    const p = e.payload;
    switch (e.type) {
      case "loop.round.started": {
        const round = num(p.round);
        const of = num(p.of);
        if (round === undefined || of === undefined) break;
        view.rounds.push({ round, of, kind: p.kind === "repair" ? "repair" : "attempt", tests: [] });
        break;
      }
      case "loop.round.completed": {
        const r = view.rounds.findLast((x) => x.round === num(p.round));
        if (r) {
          r.result = str(p.result);
          r.summary = str(p.summary);
        }
        break;
      }
      case "test.completed": {
        const v = Verification.safeParse(p).data;
        if (!v) break;
        if (p.only === "base" || p.only === "red") view.checks.push({ only: p.only, verification: v });
        else if (p.only === undefined) {
          const r = view.rounds.at(-1);
          if (r) r.tests.push(v);
          else view.opening = v;
        }
        break;
      }
      case "phase.completed": {
        const phase = PHASES.find((x) => x === p.phase);
        if (phase) view.phases.push({ phase, text: str(p.text) ?? "", round: num(p.round) });
        break;
      }
      case "qa.completed": {
        const qa = QaReview.safeParse({
          status: p.status,
          verdict: p.verdict,
          defects: p.defects,
          reason: p.reason,
        });
        if (qa.success) view.qa = { ...qa.data, round: num(p.round) };
        break;
      }
      case "feedback.delivered": {
        const round = num(p.round);
        if (round !== undefined && Array.isArray(p.ids))
          for (const id of p.ids) if (typeof id === "string") delivered.set(id, round);
        break;
      }
      case "loop.stopped":
        view.stopped = {
          reason: str(p.reason) ?? "unknown",
          unusedFeedback: Array.isArray(p.unusedFeedback)
            ? p.unusedFeedback.filter((x): x is string => typeof x === "string")
            : [],
          questions: Array.isArray(p.questions)
            ? p.questions.filter((x): x is string => typeof x === "string")
            : [],
        };
        break;
    }
  }
  return view;
}

/** "Round 2 of 4" for the round now running, or the last one that ran. */
export const roundLabel = (view: LoopView) => {
  const r = view.rounds.at(-1);
  return r && `Round ${r.round} of ${r.of}`;
};

const ROUND_WORD: Record<string, string> = {
  passed: "tests passed",
  failed: "tests failed",
  agent_failed: "the agent run ended early",
  needs_info: "the agent asked a question",
  no_change: "nothing changed",
  integrity: "the change touched how tests run",
  already_failing: "tests were already failing",
};
export const roundResult = (r: LoopRound) =>
  r.result === undefined ? "running" : (ROUND_WORD[r.result] ?? r.result.replaceAll("_", " "));

export const STOP_WORD: Record<string, string> = {
  passed: "The tests passed.",
  rounds_exhausted: "It used all of its repair rounds and the tests still fail.",
  repeated_failure: "The same failure came back twice in a row, so it stopped.",
  no_change: "A repair round changed nothing, so it stopped.",
  budget: "Not enough budget was left for another round.",
  environment: "The tests couldn't run because of the environment, not the code.",
  needs_dependency: "The change needs a package this run can't install.",
  not_configured: "NEXUS has no tests it can run for this repository.",
  already_failing: "The tests were already failing on the base commit.",
  needs_info: "The agent needs an answer from you.",
  no_changes: "The agent made no change.",
  agent_failed: "The agent run ended early.",
  runner_error: "NEXUS hit an error while checking the run.",
  secret_leak_detected: "A credential appeared in the changed files, so nothing was kept.",
  stop_failed: "The sandbox couldn't be confirmed stopped.",
};

export interface StuckView {
  report?: StuckReport;
  /** The agent's questions when the run ended asking for the owner. */
  questions: string[];
}

/** What the failed run reported: the stuck report and, for NEEDS_INFO, the questions. */
export function stuckOf(events: readonly RunEvent[]): StuckView {
  const p = events.findLast((e) => e.type === "job.failed")?.payload;
  const report = StuckReport.safeParse(p?.report);
  return {
    report: report.success ? report.data : undefined,
    questions: Array.isArray(p?.questions)
      ? p.questions.filter((q): q is string => typeof q === "string")
      : [],
  };
}

export const NOT_CONFIGURED_STEP =
  "Add a `test` script to package.json with a committed lockfile, or a .nexus.json with a `verify` section, then use Run again.";

export type KeepFixingState =
  | {
      kind: "eligible";
      /** Pending approval that Keep fixing withdraws. */ withdraws: boolean;
      answers: boolean;
    }
  | { kind: "needs_setup"; nextStep: string }
  | { kind: "no" };

/**
 * Whether Keep fixing applies, from what the drawer already has. The server decides; this only decides what is
 * offered: a stopped (or awaiting) issue job with stored changes and no pass the owner can still approve, or a job
 * that ended asking the owner a question.
 */
export function keepFixingOf(
  job: Job,
  status: JobStatus,
  approval: Approval | null | undefined,
  events: readonly RunEvent[],
): KeepFixingState {
  if (job.request.jobType !== "DEV_ISSUE_TO_PR") return { kind: "no" };
  if (!isTerminal(status) && status !== "AWAITING_APPROVAL") return { kind: "no" };
  if (approval?.status === "EXECUTED" || approval?.status === "APPROVED") return { kind: "no" };
  const failed = events.findLast((e) => e.type === "job.failed")?.payload;
  if (job.outcome === "NEEDS_INFO" || failed?.reason === "needs_info")
    return { kind: "eligible", withdraws: false, answers: true };

  const changeset =
    !!approval ||
    events.some((e) => {
      if (e.type !== "artifact.created" || e.payload.secretLeak === true) return false;
      return (changedFiles(e.payload).fileCount ?? 0) > 0;
    });
  const tests = verificationOf(events, approval);
  if (!changeset || !tests) return { kind: "no" };
  // A pass with an open approval is decided there; with none left, integrity problems or the owner's denial stopped it.
  if (tests.status === "passed" && approval?.status === "PENDING") return { kind: "no" };
  if (tests.status === "not_configured")
    return { kind: "needs_setup", nextStep: stuckOf(events).report?.nextStep ?? NOT_CONFIGURED_STEP };
  return { kind: "eligible", withdraws: approval?.status === "PENDING", answers: false };
}

/**
 * The Jobs list has no events: NEXUS's recorded test result and the approval's state say whether Keep fixing is worth
 * offering. A job that ended asking a question is answered in its run, where the answer box is.
 */
export function keepFixingListed({ job, tests, approval }: JobHistoryItem): boolean {
  if (job.request.jobType !== "DEV_ISSUE_TO_PR") return false;
  if (!isTerminal(job.status) && job.status !== "AWAITING_APPROVAL") return false;
  if (approval?.status === "EXECUTED" || approval?.status === "APPROVED") return false;
  // Passed with FAILED_TESTS: integrity problems blocked the approval.
  return tests === "failed" || tests === "error" || (tests === "passed" && job.outcome === "FAILED_TESTS");
}
