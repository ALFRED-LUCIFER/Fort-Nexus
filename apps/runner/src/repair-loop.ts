import {
  CHANGESET_MAX_FILES,
  REPAIR_ROUNDS,
  type JobOutcome,
  type QaReview,
  type StuckReport,
  type Verification,
} from "@nexus/contracts";
import { parsePhaseLine, parseResult } from "./agent-result.ts";
import { isStaleLease } from "./api.ts";
import { ChangesetError, type Changeset } from "./changeset.ts";
import { issuePrompt } from "./issue-prompt.ts";
import { errorMessage } from "./log.ts";
import { redact } from "./output.ts";
import { classifyFailure, fingerprint } from "./repair/classify.ts";
import { isTestFile, type IntegrityResult } from "./repair/integrity.ts";
import {
  NEXT_STEP,
  type BudgetLeft,
  type ClaimedFeedback,
  type LoopDeps,
  type LoopInput,
  type LoopResult,
  type QaFatal,
  type StopReason,
} from "./repair-loop-types.ts";
import { repairPrompt } from "./repair-prompt.ts";

// The bounded repair loop of one job: agent attempt, NEXUS's own checks, up to `rounds` repairs.
// It only sequences its dependencies; the tests decide a pass, never the model.

export const MIN_ROUND_COST_USD = 0.25;
export const MIN_ROUND_MS = 120_000;
export const MIN_ROUND_TURNS = 5;

const NOTE_MAX = 8_000;
const PATH_MAX = 500;

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
type Passing = Tested & { qa?: QaReview; notes?: string[] };
type RepairStep = { result: string; summary: string; evidence: string };
/** What a passing tree doesn't prove: `evidence` for the agent, `note` for the owner. */
type Finding = { evidence: string; note: string; repair: boolean };

const NO_TEST: Finding = {
  evidence: "This code change has no test change. Add or update a test that fails without the change.",
  note: "This code change has no test change.",
  repair: true,
};
const PROVES_NOTHING: Finding = {
  evidence:
    "The changed tests pass without the source change, so they prove nothing. Make them fail for the right reason on the old code.",
  note: "These tests also pass on the old code, so they may not prove this change.",
  repair: true,
};
const STOPPED: LoopResult = { kind: "stopped" };
const NOTE_UNUSED =
  "Your Keep fixing note wasn't used: no repair round or budget was left for the agent to read it.";
const NO_TEST_PLAN = "The base commit has no test script or .nexus.json verify section NEXUS can run.";

type State = {
  spentUsd: number;
  spentTurns: number;
  rounds: StuckReport["rounds"];
  tested?: Tested;
  passing?: Passing;
  lastFingerprint: string | null;
  sawFailure: boolean;
  redChecked: boolean;
  /** The test files the red run found proving nothing, to keep the note while they stay the same. */
  unprovenTests?: string;
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
  resuming: boolean;
  /** Rounds shown to the owner. */
  total: number;
  left: () => BudgetLeft;
  enoughBudget: () => boolean;
  /** Whether another round can follow `round`. */
  canRepair: (round: number) => boolean;
};

const cap = (text: string, max: number) => text.slice(0, max);
export const agentStatement = (finalText: string | undefined) =>
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
  const stillFailing =
    [tests, dirty].filter(Boolean).join("\n") ||
    (reason === "not_configured" ? NO_TEST_PLAN : failure?.reason || reason);
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

const keepsNothing = (reason: StopReason) => reason === "secret_leak_detected" || reason === "stop_failed";

function finish(ctx: Ctx, reason: StopReason, failure?: Failure, questions?: string[]): LoopResult {
  const { deps, s } = ctx;
  const unused = s.waiting.map((i) => i.id);
  deps.event("loop.stopped", {
    reason,
    ...(questions ? { questions } : {}),
    ...(unused.length ? { unusedFeedback: unused } : {}),
  });
  if (reason === "no_changes") return { kind: "no_changes" };
  const report = buildReport(ctx, reason, failure);
  const keepNothing = keepsNothing(reason);
  if (s.passing && !keepNothing) {
    const { changeset, verification, integrity, qa, notes } = s.passing;
    const review = qa ?? qaSkipped("The run ended before the review.");
    return {
      kind: "upload",
      changeset,
      verification,
      qa: review,
      integrity: forUpload(integrity),
      ...(notes ? { notes } : {}),
    };
  }
  if (reason === "needs_info" && questions) return { kind: "needs_info", questions };
  if (s.tested && !keepNothing) {
    const blocked = reason === "environment" || reason === "needs_dependency" || reason === "not_configured";
    const terminalOutcome =
      reason === "already_failing" ? "ALREADY_FAILING" : blocked ? "ENVIRONMENT_BLOCKED" : "FAILED_TESTS";
    const { changeset, verification, integrity } = s.tested;
    const qa = qaSkipped(
      verification.status === "passed"
        ? "The change failed NEXUS's integrity checks, so it was not reviewed."
        : "The tests did not pass, so the change was not reviewed.",
    );
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

/**
 * Every way the loop ends apart from a cancel. A passing tree that hasn't been reviewed is reviewed first,
 * and feedback nothing can use any more is claimed, so it is reported as unused.
 */
async function end(
  ctx: Ctx,
  reason: StopReason,
  failure?: Failure,
  questions?: string[],
): Promise<LoopResult> {
  const { deps, s } = ctx;
  if (!keepsNothing(reason) && s.passing && !s.passing.qa && ctx.enoughBudget()) {
    const outcome = await review(ctx, s.passing, s.rounds.at(-1)?.round ?? 0);
    if (outcome === "stopped") return STOPPED;
    if (outcome) return end(ctx, outcome.reason, outcome);
  }
  try {
    await claim(ctx, 0);
  } catch (err) {
    // Only the unused list is at stake, so a failed claim must not cost the result.
    if (isStaleLease(err)) throw err;
  }
  if (deps.signal.aborted && !keepsNothing(reason)) return STOPPED;
  return finish(ctx, reason, failure, questions);
}

function recordQa(ctx: Ctx, passing: Passing, qa: QaReview, round: number): void {
  passing.qa = qa;
  const { status, verdict, defects, reason } = qa;
  ctx.deps.event("qa.completed", { status, verdict, defects, reason, round });
}

/** One QA run on a passing tree. Null when it produced a review (even "could not run"). */
async function review(ctx: Ctx, passing: Passing, round: number): Promise<QaFatal | "stopped" | null> {
  const { deps, s } = ctx;
  const run = await deps.runQa(passing.changeset.tree, ctx.left());
  s.spentUsd += run.costUsd;
  s.spentTurns += run.turns;
  if (run.fatal) return run.fatal;
  // A review cut off by the stop comes back as could_not_run: it is a cancellation, not a QA result.
  if (deps.signal.aborted) return "stopped";
  recordQa(ctx, passing, run.review, round);
  return null;
}

const testFilesOf = ({ changeset, integrity }: Tested) =>
  JSON.stringify(changeset.files.filter((f) => integrity.testFilesChanged.includes(f.path)));

/** Whether the tests prove this change. The no-test check is per tree, the red run once per job. */
async function proofFinding(ctx: Ctx, tested: Tested): Promise<Finding | null> {
  const { deps, s } = ctx;
  const { changeset, integrity } = tested;
  const firstPass = !s.redChecked;
  s.redChecked = true;
  if (changeset.files.every((f) => isTestFile(f.path) || isNonSource(f.path))) return null;
  if (integrity.testFilesChanged.length === 0) return NO_TEST;
  if (!firstPass)
    return s.unprovenTests === testFilesOf(tested) ? { ...PROVES_NOTHING, repair: false } : null;
  if (ctx.left().maxWallClockMs < MIN_ROUND_MS) return null;
  const tree = await deps.redTree(changeset.tree, integrity.testFilesChanged);
  if (deps.signal.aborted) return null;
  const red = await deps.verify(tree, "red");
  if (red.status !== "passed") return null;
  s.unprovenTests = testFilesOf(tested);
  return PROVES_NOTHING;
}

/** A passing tree's checks and QA. Null: upload this tree. */
async function afterPass(
  ctx: Ctx,
  tested: Passing,
  round: number,
): Promise<RepairStep | QaFatal | "stopped" | null> {
  const { deps, s } = ctx;
  const feedbackStep: RepairStep = {
    result: "feedback",
    summary: "The tests passed. The owner sent more guidance.",
    evidence: "NEXUS's tests pass on the current tree. The owner sent more guidance: apply it.",
  };
  const finding = await proofFinding(ctx, tested);
  if (deps.signal.aborted) return "stopped";
  if (finding) tested.notes = [finding.note];
  if (finding?.repair && ctx.canRepair(round))
    return { result: "red_check", summary: finding.evidence, evidence: finding.evidence };

  // Keep fixing's opening run passed. A note is still work for the agent; this tree stays the last passing one.
  if (round === 0 && ctx.input.continuation?.note?.trim()) {
    if (ctx.canRepair(round)) return feedbackStep;
    tested.notes = [...(tested.notes ?? []), NOTE_UNUSED];
  }

  const nextRound = () => (ctx.canRepair(round) ? round + 1 : 0);
  await claim(ctx, nextRound());
  if (deps.signal.aborted) return "stopped";
  if (s.waiting.length && ctx.canRepair(round)) return feedbackStep;

  if (ctx.enoughBudget()) {
    const outcome = await review(ctx, tested, round);
    if (outcome) return outcome;
  } else {
    recordQa(ctx, tested, qaSkipped("Not enough budget was left for the review."), round);
  }
  await claim(ctx, nextRound());
  if (deps.signal.aborted) return "stopped";

  if (!ctx.canRepair(round)) return null;
  const blocking = tested.qa ? blockingDefects(tested.qa) : [];
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
  const ctx = createContext(deps, input);
  try {
    return await loop(ctx);
  } catch (err) {
    if (isStaleLease(err)) throw err;
    if (deps.signal.aborted) return STOPPED;
    const failure = { reason: "runner_error", details: { message: cap(redact(errorMessage(err)), 500) } };
    try {
      return await end(ctx, "runner_error", failure);
    } catch (again) {
      if (isStaleLease(again)) throw again;
      return deps.signal.aborted ? STOPPED : finish(ctx, "runner_error", failure);
    }
  }
}

function createContext(deps: LoopDeps, input: LoopInput): Ctx {
  const { continuation, budget } = input;
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
  return {
    deps,
    input,
    s,
    resuming,
    total,
    left,
    enoughBudget,
    canRepair: (r) => r < total && enoughBudget(),
  };
}

async function loop(ctx: Ctx): Promise<LoopResult> {
  const { deps, input, s, left, enoughBudget, resuming, total } = ctx;
  const { issue, canRunTests } = input;
  const note = () => s.guidance.join("\n\n").slice(-NOTE_MAX) || undefined;

  // The test plan comes from the base commit, so no round can change this: don't spend on an agent.
  if (!(await deps.hasTestPlan())) {
    if (deps.signal.aborted) return STOPPED;
    return end(ctx, "not_configured", {
      reason: "not_configured",
      details: {},
      outcome: "ENVIRONMENT_BLOCKED",
    });
  }
  if (deps.signal.aborted) return STOPPED;

  let round = 0;
  let evidence = "";
  for (let skipAgent = resuming; ; skipAgent = false) {
    if (deps.signal.aborted) return STOPPED;
    if (!skipAgent) {
      const repairing = round > 0 || resuming;
      if (round >= total) return end(ctx, "rounds_exhausted");
      if (repairing && !enoughBudget()) return end(ctx, "budget");
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
        return end(ctx, run.reason, failure);
      }
      if (deps.signal.aborted || run.status === "STOPPED") return STOPPED;
      if (run.status === "FAILED") {
        closeRound(ctx, round, "agent_failed", `The agent run ended: ${failure.reason}.`);
        const outcome = run.outcome ?? (failure.reason === "budget_exceeded" ? "BUDGET_EXCEEDED" : undefined);
        return end(ctx, "agent_failed", { ...failure, ...(outcome ? { outcome } : {}) });
      }
      const result = run.finalText ? parseResult(run.finalText) : null;
      if (result?.status === "needs_info") {
        closeRound(ctx, round, "needs_info", "The agent has a question only the owner can answer.");
        return end(ctx, "needs_info", undefined, result.questions);
      }
    }

    let changeset: Changeset;
    try {
      changeset = await deps.buildChangeset();
    } catch (err) {
      if (!(err instanceof ChangesetError)) throw err;
      closeRound(ctx, round, "agent_failed", err.message);
      return end(ctx, "agent_failed", { reason: err.reason, details: err.details });
    }
    if (deps.signal.aborted) return STOPPED;
    if (changeset.files.length === 0 || changeset.tree === s.tested?.changeset.tree) {
      if (!s.tested) return end(ctx, "no_changes");
      closeRound(ctx, round, "no_change", "The round changed nothing.");
      return end(ctx, "no_change");
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
        return end(ctx, "passed");
      }
      if ("reason" in step) {
        closeRound(ctx, round, "failed", `The review run ended: ${step.reason}.`);
        return end(ctx, step.reason, step);
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
      return end(ctx, kind);
    }
    if (!s.sawFailure) {
      s.sawFailure = true;
      if (!s.passing) {
        await claim(ctx, ctx.canRepair(round) ? round + 1 : 0);
        if (deps.signal.aborted) return STOPPED;
        const words = [...s.guidance, ...s.waiting.map((i) => i.text)].join("\n");
        if (!FIX_EXISTING.test(words) && left().maxWallClockMs >= MIN_ROUND_MS) {
          const base = await deps.verify(input.baseTree, "base");
          if (deps.signal.aborted) return STOPPED;
          if (base.status !== "passed" && classifyFailure(base, []) === "repair") {
            closeRound(ctx, round, "already_failing", "The tests fail on the base commit too.");
            return end(ctx, "already_failing");
          }
        }
      }
    }
    const print = fingerprint(verification.outputTail);
    if (print !== null && print === s.lastFingerprint) {
      closeRound(ctx, round, "failed", "The same failure as the previous round.");
      return end(ctx, "repeated_failure");
    }
    s.lastFingerprint = print;
    closeRound(ctx, round, "failed", summary);
    evidence = [problems, `NEXUS's test run failed. Output tail:\n${verification.outputTail}`]
      .filter(Boolean)
      .join("\n\n");
  }
}
