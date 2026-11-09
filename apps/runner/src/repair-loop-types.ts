import type {
  ChangesetFile,
  IssueSnapshot,
  IssueToPrTask,
  JobOutcome,
  QaReview,
  RunEventType,
  StuckReport,
  Verification,
} from "@nexus/contracts";
import type { Changeset } from "./changeset.ts";
import type { ClaudeBudget, ClaudeTaskResult } from "./claude.ts";
import type { IntegrityResult } from "./repair/integrity.ts";

// The repair loop's contract with the runner, and the sentence the owner reads for each way it can end.

export type BudgetLeft = ClaudeBudget;
/** `costUsd` and `turns` are this run's own totals (the ClaudeTaskResult summary, 0 when it has none). */
export type AgentRun = Pick<ClaudeTaskResult, "status" | "reason" | "details" | "outcome" | "finalText"> & {
  costUsd: number;
  turns: number;
};
/** A review that ended this way is more than a failed review: nothing from the job may be uploaded. */
export type QaFatal = { reason: "secret_leak_detected" | "stop_failed"; details: Record<string, unknown> };
export type QaRun = { review: QaReview; costUsd: number; turns: number; fatal?: QaFatal };
export type ClaimedFeedback = { id: string; text: string };

export type LoopDeps = {
  /** Whether the base commit names tests NEXUS can run; asked once, before any agent spend. */
  hasTestPlan(): Promise<boolean>;
  runAgent(prompt: string, budgetLeft: BudgetLeft): Promise<AgentRun>;
  buildChangeset(): Promise<Changeset>;
  verify(tree: string, label?: "base" | "red"): Promise<Verification>;
  /** The base commit with only these test files taken from `tree`. */
  redTree(tree: string, testPaths: string[]): Promise<string>;
  checkIntegrity(files: ChangesetFile[]): Promise<IntegrityResult>;
  /** Reviews `tree`, which at the end of a job can be earlier than what the worktree holds. */
  runQa(tree: string, budgetLeft: BudgetLeft): Promise<QaRun>;
  /** Round 0 means no round will use it: the loop reports those items as unused. */
  claimFeedback(round: number): Promise<ClaimedFeedback[]>;
  event(type: RunEventType, payload: Record<string, unknown>): void;
  signal: AbortSignal;
  now(): number;
};

export type LoopInput = {
  issue: IssueSnapshot;
  budget: BudgetLeft;
  /** Repair rounds, after the first attempt of a new job. */
  rounds: number;
  /** The base commit's tree, for the already-failing check. */
  baseTree: string;
  /** Stored files start with a test run and no attempt; with none (an answered question) it is a new attempt. */
  continuation?: IssueToPrTask["continuation"];
  canRunTests: boolean;
};

export type LoopResult =
  | {
      kind: "upload";
      changeset: Changeset;
      verification: Verification;
      qa: QaReview;
      integrity: IntegrityResult;
      /** NEXUS's own unresolved findings about this change, shown at the approval. */
      notes?: string[];
      report?: StuckReport;
      terminalOutcome?: "FAILED_TESTS" | "ENVIRONMENT_BLOCKED" | "ALREADY_FAILING";
    }
  | {
      kind: "failed";
      reason: string;
      details: Record<string, unknown>;
      outcome?: JobOutcome;
      report: StuckReport;
    }
  | { kind: "needs_info"; questions: string[] }
  | { kind: "stopped" }
  | { kind: "no_changes" };

export type StopReason =
  | "passed"
  | "rounds_exhausted"
  | "repeated_failure"
  | "no_change"
  | "budget"
  | "environment"
  | "needs_dependency"
  | "not_configured"
  | "already_failing"
  | "needs_info"
  | "no_changes"
  | "agent_failed"
  | "runner_error"
  | "secret_leak_detected"
  | "stop_failed";

export const NEXT_STEP: Record<StopReason, string> = {
  passed: "Review the change and decide on the push approval.",
  rounds_exhausted:
    "Read what still fails, then use Keep fixing with a note, or change the issue and use Run again.",
  repeated_failure:
    "The same failure came back twice, so use Keep fixing with a note that points at the cause.",
  no_change: "The last round changed nothing, so use Keep fixing with a note that says what to try.",
  budget: "Not enough budget was left for another round. Use Keep fixing, which starts with a fresh budget.",
  environment:
    "The tests could not run because of the environment, not the code. Fix that, then use Keep fixing.",
  needs_dependency:
    "The change needs a package this run cannot install. Add it to the repository, then use Run again.",
  not_configured:
    "Add a `test` script to package.json with a committed lockfile, or a .nexus.json with a `verify` section, then use Run again.",
  already_failing:
    "These tests fail on the base commit too. Use Keep fixing and say in the note to fix the existing failures.",
  needs_info: "Answer the agent's question in the feedback box.",
  no_changes: "The agent made no change, so there is nothing to review.",
  runner_error: "NEXUS hit an error while checking this run. Check the runner log, then use Keep fixing.",
  agent_failed: "The agent run ended early. Check the run log, then use Keep fixing or Run again.",
  secret_leak_detected:
    "A credential appeared in the changed files, so nothing was kept. Find out how before running again.",
  stop_failed:
    "The sandbox could not be confirmed stopped. Check the runner machine before starting another run.",
};
