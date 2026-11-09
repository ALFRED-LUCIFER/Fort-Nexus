import {
  CHANGESET_MAX_FILES,
  REPAIR_ROUNDS,
  type ChangesetFile,
  type IssueSnapshot,
  type IssueToPrTask,
  type JobOutcome,
  type QaReview,
  type RunEventType,
  type StuckReport,
  type Verification,
} from "@nexus/contracts";
import { parsePhaseLine, parseResult } from "./agent-result.ts";
import { ChangesetError, type Changeset } from "./changeset.ts";
import type { ClaudeBudget, ClaudeTaskResult } from "./claude.ts";
import { issuePrompt } from "./issue-prompt.ts";
import { classifyFailure, fingerprint } from "./repair/classify.ts";
import type { IntegrityResult } from "./repair/integrity.ts";
import { repairPrompt } from "./repair-prompt.ts";

// The bounded repair loop of one job: agent attempt, NEXUS's own checks, up to `rounds` repairs.
// It only sequences its dependencies; the tests decide a pass, never the model.

export const MIN_ROUND_COST_USD = 0.25;
export const MIN_ROUND_MS = 120_000;
export const MIN_ROUND_TURNS = 5;

const NOTE_MAX = 8_000;
const PATH_MAX = 500;

export type BudgetLeft = ClaudeBudget;
/** `costUsd` and `turns` are this run's own totals (the ClaudeTaskResult summary, 0 when it has none). */
export type AgentRun = Pick<ClaudeTaskResult, "status" | "reason" | "details" | "outcome" | "finalText"> & {
  costUsd: number;
  turns: number;
};
export type QaRun = { review: QaReview; costUsd: number; turns: number };
export type ClaimedFeedback = { id: string; text: string };

export type LoopDeps = {
  runAgent(prompt: string, budgetLeft: BudgetLeft): Promise<AgentRun>;
  buildChangeset(): Promise<Changeset>;
  verify(tree: string, label?: "base" | "red"): Promise<Verification>;
  /** The base commit with only these test files taken from `tree`. */
  redTree(tree: string, testPaths: string[]): Promise<string>;
  checkIntegrity(files: ChangesetFile[]): Promise<IntegrityResult>;
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

type StopReason =
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
  | "agent_failed"
  | "secret_leak_detected"
  | "stop_failed";

const NEXT_STEP: Record<StopReason, string> = {
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
  agent_failed: "The agent run ended early. Check the run log, then use Keep fixing or Run again.",
  secret_leak_detected:
    "A credential appeared in the changed files, so nothing was kept. Find out how before running again.",
  stop_failed:
    "The sandbox could not be confirmed stopped. Check the runner machine before starting another run.",
};

// Shortcut, not comprehension: a phrase match on the owner's own words, which only skips the base check.
const FIX_EXISTING = /\bfix\w*\b[^.\n]{0,60}\b(?:existing|pre-?existing|already|failing|failures)\b/i;
const NON_SOURCE = [
  /\.(?:md|mdx|txt|rst|json|jsonc|ya?ml|toml|ini|cfg|lock)$/i,
  /(?:^|\/)docs?\//,
  /^\.github\//,
  /(?:^|\/)\.[^/.]+$/,
  /(?:^|\/)(?:Dockerfile|Makefile|LICENSE)[^/]*$/,
];
const isNonSource = (path: string) => NON_SOURCE.some((re) => re.test(path));

type Tested = { changeset: Changeset; verification: Verification; integrity: IntegrityResult };
type Failure = { reason: string; details: Record<string, unknown>; outcome?: JobOutcome };
type RepairStep = { result: string; summary: string; evidence: string };

type State = {
  spentUsd: number;
  spentTurns: number;
  rounds: StuckReport["rounds"];
  tested?: Tested;
  passing?: Tested & { qa?: QaReview };
  lastFingerprint: string | null;
  sawFailure: boolean;
  redChecked: boolean;
  /** Delivered owner guidance, repeated in later prompts because each round starts a fresh agent. */
  guidance: string[];
  /** Claimed but not yet given to a round. */
  waiting: ClaimedFeedback[];
  seenFeedback: Set<string>;
  /** The agent's own words from this round, and the latest round that had any. */
  roundText: string | null;
  agentText: string | null;
};

type Ctx = {
  deps: LoopDeps;
  input: LoopInput;
  s: State;
  left: () => BudgetLeft;
  enoughBudget: () => boolean;
  /** Whether another round can follow `round`. */
  canRepair: (round: number) => boolean;
};

const cap = (text: string, max: number) => text.slice(0, max);
const agentStatement = (finalText: string | undefined) =>
  (finalText ?? "")
    .split("\n")
    .filter((l) => !/^\s*NEXUS_(?:PHASE|RESULT)\b/.test(l))
    .join("\n")
    .trim() || null;
const qaSkipped = (reason: string): QaReview => ({
  status: "could_not_run",
  verdict: null,
  defects: [],
  reason,
});
const blockingDefects = (qa: QaReview) => qa.defects.filter((d) => d.severity === "blocking");

function closeRound(ctx: Ctx, round: number, result: string, summary: string): void {
  if (round === 0) return; // Keep fixing's opening test run is not a round.
  const tried = ctx.s.roundText ?? "The agent did not describe this round.";
  ctx.s.rounds.push({ round, tried: cap(tried, 1000), result: cap(summary, 1000) });
  ctx.deps.event("loop.round.completed", { round, result, summary: cap(summary, 1000) });
}

async function claim(ctx: Ctx, round: number): Promise<void> {
  const { s, deps } = ctx;
  // A repeated claim for the same round returns the same items.
  const fresh = (await deps.claimFeedback(round)).filter((i) => !s.seenFeedback.has(i.id));
  for (const item of fresh) s.seenFeedback.add(item.id);
  s.waiting.push(...fresh);
}

function buildReport(ctx: Ctx, reason: StopReason, failure?: Failure): StuckReport {
  const { s } = ctx;
  const v = s.tested?.verification;
  const dirty = s.tested && !s.tested.integrity.clean ? s.tested.integrity.problems.join("; ") : "";
  const tests =
    v && v.status !== "passed" ? v.reason || v.outputTail.slice(-1800) || "The tests did not pass." : "";
  const stillFailing = [tests, dirty].filter(Boolean).join("\n") || failure?.reason || reason;
  return {
    rounds: s.rounds.slice(-(REPAIR_ROUNDS + 1)),
    stillFailing: cap(stillFailing, 2000),
    rootCauseGuess: s.agentText ? cap(s.agentText, 1000) : null,
    nextStep: cap(NEXT_STEP[reason], 1000),
  };
}

const forUpload = (i: IntegrityResult): IntegrityResult => ({
  ...i,
  testFilesChanged: i.testFilesChanged.slice(0, CHANGESET_MAX_FILES).map((p) => p.slice(0, PATH_MAX)),
});

function finish(
  ctx: Ctx,
  reason: StopReason,
  failure?: Failure,
  extra: Record<string, unknown> = {},
): LoopResult {
  const { deps, s } = ctx;
  const unused = s.waiting.map((i) => i.id);
  deps.event("loop.stopped", { reason, ...extra, ...(unused.length ? { unusedFeedback: unused } : {}) });
  const report = buildReport(ctx, reason, failure);
  const keepNothing = reason === "secret_leak_detected" || reason === "stop_failed";
  if (s.passing && !keepNothing) {
    const { changeset, verification, integrity, qa } = s.passing;
    const review = qa ?? qaSkipped("The run ended before the review.");
    return { kind: "upload", changeset, verification, qa: review, integrity: forUpload(integrity) };
  }
  if (s.tested && !keepNothing) {
    const blocked = reason === "environment" || reason === "needs_dependency" || reason === "not_configured";
    const terminalOutcome =
      reason === "already_failing" ? "ALREADY_FAILING" : blocked ? "ENVIRONMENT_BLOCKED" : "FAILED_TESTS";
    const { changeset, verification, integrity } = s.tested;
    const qa = qaSkipped("The tests did not pass, so the change was not reviewed.");
    return {
      kind: "upload",
      changeset,
      verification,
      qa,
      integrity: forUpload(integrity),
      report,
      terminalOutcome,
    };
  }
  return {
    kind: "failed",
    reason: failure?.reason ?? reason,
    details: failure?.details ?? {},
    ...(failure?.outcome ? { outcome: failure.outcome } : {}),
    report,
  };
}

/** The evidence for a repair when the red check fails, or null when it finds nothing. */
async function redProblem(ctx: Ctx, { changeset, integrity }: Tested): Promise<string | null> {
  const { deps } = ctx;
  if (changeset.files.every((f) => isNonSource(f.path))) return null;
  if (integrity.testFilesChanged.length === 0)
    return "This code change has no test change. Add or update a test that fails without the change.";
  if (ctx.left().maxWallClockMs < MIN_ROUND_MS) return null;
  const tree = await deps.redTree(changeset.tree, integrity.testFilesChanged);
  if (tree === changeset.tree || deps.signal.aborted) return null; // A tests-only change has nothing left out.
  const red = await deps.verify(tree, "red");
  return red.status === "passed"
    ? "The changed tests pass without the source change, so they prove nothing. Make them fail for the right reason on the old code."
    : null;
}

/** The first passing tree's checks and QA. Null: upload this tree. "stopped": the job was cancelled. */
async function afterPass(ctx: Ctx, tested: Tested, round: number): Promise<RepairStep | "stopped" | null> {
  const { deps, s } = ctx;
  const feedbackStep: RepairStep = {
    result: "feedback",
    summary: "The tests passed. The owner sent more guidance.",
    evidence: "NEXUS's tests pass on the current tree. The owner sent more guidance: apply it.",
  };
  if (!s.redChecked) {
    s.redChecked = true;
    const problem = ctx.canRepair(round) ? await redProblem(ctx, tested) : null;
    if (deps.signal.aborted) return "stopped";
    if (problem) return { result: "red_check", summary: problem, evidence: problem };
  }
  const nextRound = () => (ctx.canRepair(round) ? round + 1 : 0);
  await claim(ctx, nextRound());
  if (deps.signal.aborted) return "stopped";
  if (s.waiting.length && ctx.canRepair(round)) return feedbackStep;

  let qa = qaSkipped("Not enough budget was left for the review.");
  if (ctx.enoughBudget()) {
    const run = await deps.runQa(tested.changeset.tree, ctx.left());
    s.spentUsd += run.costUsd;
    s.spentTurns += run.turns;
    qa = run.review;
    // A review cut off by the stop comes back as could_not_run: it is a cancellation, not a QA result.
    if (deps.signal.aborted) return "stopped";
  }
  if (s.passing) s.passing.qa = qa;
  deps.event("qa.completed", {
    status: qa.status,
    verdict: qa.verdict,
    defects: qa.defects,
    reason: qa.reason,
    round,
  });
  await claim(ctx, nextRound());
  if (deps.signal.aborted) return "stopped";

  if (!ctx.canRepair(round)) return null;
  const blocking = blockingDefects(qa);
  if (blocking.length) {
    const lines = blocking.map((d) => `${d.file ?? "(no file)"}: ${d.evidence}`).join("\n");
    return {
      result: "qa_defects",
      summary: `QA found ${blocking.length} blocking defect(s).`,
      evidence: `An independent review (a model's opinion, not a verified fact) found these blocking defects:\n${lines}`,
    };
  }
  return s.waiting.length ? feedbackStep : null;
}

export async function runRepairLoop(deps: LoopDeps, input: LoopInput): Promise<LoopResult> {
  try {
    return await loop(deps, input);
  } catch (err) {
    if (deps.signal.aborted) return { kind: "stopped" };
    throw err;
  }
}

async function loop(deps: LoopDeps, input: LoopInput): Promise<LoopResult> {
  const { issue, canRunTests, continuation, budget } = input;
  const STOPPED: LoopResult = { kind: "stopped" };
  const resuming = (continuation?.files.length ?? 0) > 0;
  const total = resuming ? input.rounds : input.rounds + 1;
  const deadline = deps.now() + budget.maxWallClockMs;
  const s: State = {
    spentUsd: 0,
    spentTurns: 0,
    rounds: [],
    lastFingerprint: null,
    sawFailure: false,
    redChecked: false,
    guidance: continuation?.note ? [continuation.note] : [],
    waiting: [],
    seenFeedback: new Set(),
    roundText: null,
    agentText: null,
  };
  const left = (): BudgetLeft => ({
    maxCostUsd: budget.maxCostUsd - s.spentUsd,
    maxTurns: budget.maxTurns - s.spentTurns,
    maxWallClockMs: deadline - deps.now(),
  });
  const enoughBudget = () => {
    const b = left();
    return (
      b.maxCostUsd >= MIN_ROUND_COST_USD && b.maxTurns >= MIN_ROUND_TURNS && b.maxWallClockMs >= MIN_ROUND_MS
    );
  };
  const ctx: Ctx = { deps, input, s, left, enoughBudget, canRepair: (r) => r < total && enoughBudget() };
  const note = () => s.guidance.join("\n\n").slice(-NOTE_MAX) || undefined;

  let round = 0;
  let evidence = "";
  for (let skipAgent = resuming; ; skipAgent = false) {
    if (deps.signal.aborted) return STOPPED;
    if (!skipAgent) {
      const repairing = round > 0 || resuming;
      if (round >= total) return finish(ctx, "rounds_exhausted");
      if (repairing && !enoughBudget()) return finish(ctx, "budget");
      round += 1;
      await claim(ctx, round);
      if (deps.signal.aborted) return STOPPED;
      if (s.waiting.length) {
        deps.event("feedback.delivered", { ids: s.waiting.map((i) => i.id), round });
        s.guidance.push(...s.waiting.map((i) => i.text));
        s.waiting = [];
      }
      deps.event("loop.round.started", { round, of: total, kind: repairing ? "repair" : "attempt" });
      const prompt = repairing
        ? repairPrompt({ issue, round: resuming ? round : round - 1, evidence, note: note(), canRunTests })
        : issuePrompt(issue, { canRunTests, note: note() });
      const run = await deps.runAgent(prompt, left());
      s.spentUsd += run.costUsd;
      s.spentTurns += run.turns;
      s.roundText = agentStatement(run.finalText);
      s.agentText = s.roundText ?? s.agentText;
      for (const line of (run.finalText ?? "").split("\n")) {
        const phase = parsePhaseLine(line);
        if (phase) deps.event("phase.completed", { ...phase, round });
      }
      const failure: Failure = { reason: run.reason ?? "agent_failed", details: run.details ?? {} };
      if (run.reason === "secret_leak_detected" || run.reason === "stop_failed") {
        closeRound(ctx, round, "failed", `The agent run ended: ${failure.reason}.`);
        return finish(ctx, run.reason, failure);
      }
      if (deps.signal.aborted || run.status === "STOPPED") return STOPPED;
      if (run.status === "FAILED") {
        closeRound(ctx, round, "agent_failed", `The agent run ended: ${failure.reason}.`);
        const outcome = run.outcome ?? (failure.reason === "budget_exceeded" ? "BUDGET_EXCEEDED" : undefined);
        return finish(ctx, "agent_failed", { ...failure, ...(outcome ? { outcome } : {}) });
      }
      const result = run.finalText ? parseResult(run.finalText) : null;
      if (result?.status === "needs_info") {
        closeRound(ctx, round, "needs_info", "The agent has a question only the owner can answer.");
        if (s.passing) return finish(ctx, "needs_info", undefined, { questions: result.questions });
        deps.event("loop.stopped", { reason: "needs_info" });
        return { kind: "needs_info", questions: result.questions };
      }
    }

    let changeset: Changeset;
    try {
      changeset = await deps.buildChangeset();
    } catch (err) {
      if (!(err instanceof ChangesetError)) throw err;
      closeRound(ctx, round, "agent_failed", err.message);
      return finish(ctx, "agent_failed", { reason: err.reason, details: err.details });
    }
    if (deps.signal.aborted) return STOPPED;
    if (changeset.files.length === 0 || changeset.tree === s.tested?.changeset.tree) {
      if (!s.tested) {
        deps.event("loop.stopped", { reason: "no_changes" });
        return { kind: "no_changes" };
      }
      closeRound(ctx, round, "no_change", "The round changed nothing.");
      return finish(ctx, "no_change");
    }

    const integrity = await deps.checkIntegrity(changeset.files);
    if (deps.signal.aborted) return STOPPED;
    const verification = await deps.verify(changeset.tree);
    if (deps.signal.aborted) return STOPPED;
    const tested: Tested = { changeset, verification, integrity };
    s.tested = tested;

    if (verification.status === "passed" && integrity.clean) {
      s.passing = tested;
      s.lastFingerprint = null;
      const step = await afterPass(ctx, tested, round);
      if (step === "stopped") return STOPPED;
      if (step === null) {
        closeRound(ctx, round, "passed", "The tests passed.");
        return finish(ctx, "passed");
      }
      closeRound(ctx, round, step.result, step.summary);
      evidence = step.evidence;
      continue;
    }

    const problems = integrity.clean
      ? ""
      : `Integrity problems NEXUS found:\n${integrity.problems.join("\n")}`;
    if (verification.status === "passed") {
      s.lastFingerprint = null;
      closeRound(ctx, round, "integrity", cap(integrity.problems.join("; "), 1000));
      evidence = problems;
      continue;
    }

    const kind = classifyFailure(
      verification,
      changeset.files.map((f) => f.path),
    );
    const summary = verification.reason ?? "The tests failed.";
    if (kind !== "repair") {
      closeRound(ctx, round, kind, summary);
      return finish(ctx, kind);
    }
    if (!s.sawFailure) {
      s.sawFailure = true;
      if (!s.passing && !FIX_EXISTING.test(s.guidance.join("\n")) && left().maxWallClockMs >= MIN_ROUND_MS) {
        const base = await deps.verify(input.baseTree, "base");
        if (deps.signal.aborted) return STOPPED;
        if (base.status !== "passed" && classifyFailure(base, []) === "repair") {
          closeRound(ctx, round, "already_failing", "The tests fail on the base commit too.");
          return finish(ctx, "already_failing");
        }
      }
    }
    const print = fingerprint(verification.outputTail);
    if (print !== null && print === s.lastFingerprint) {
      closeRound(ctx, round, "failed", "The same failure as the previous round.");
      return finish(ctx, "repeated_failure");
    }
    s.lastFingerprint = print;
    closeRound(ctx, round, "failed", summary);
    evidence = [problems, `NEXUS's test run failed. Output tail:\n${verification.outputTail}`]
      .filter(Boolean)
      .join("\n\n");
  }
}
