import type { ChangesetFile, IssueSnapshot, QaReview, Verification } from "@nexus/contracts";
import { StuckReport } from "@nexus/contracts";
import { describe, expect, it } from "vitest";
import { ChangesetError, type Changeset } from "./changeset.ts";
import {
  MIN_ROUND_COST_USD,
  runRepairLoop,
  type AgentRun,
  type BudgetLeft,
  type LoopDeps,
  type LoopInput,
  type LoopResult,
} from "./repair-loop.ts";
import type { IntegrityResult } from "./repair/integrity.ts";

const issue: IssueSnapshot = {
  repositoryId: "1",
  fullName: "acme/app",
  issueNumber: 7,
  title: "Fix the thing",
  body: "It is broken.",
  acceptanceCriteria: ["It works"],
  htmlUrl: "https://github.com/acme/app/issues/7",
  issueUpdatedAt: "2026-11-09T00:00:00.000Z",
  baseBranch: "main",
  baseSha: "a".repeat(40),
};

const passed: Verification = {
  status: "passed",
  reason: null,
  source: "package.json",
  install: null,
  test: ["pnpm", "test"],
  exitCode: 0,
  durationMs: 10,
  outputTail: "all green",
};
const failed = (outputTail: string, extra: Partial<Verification> = {}): Verification => ({
  ...passed,
  status: "failed",
  exitCode: 1,
  outputTail,
  failureKind: "test_failed",
  ...extra,
});

const file = (path: string): ChangesetFile => ({
  change: "modified",
  path,
  mode: "100644",
  contentBase64: "",
});
const CODE_AND_TEST = [file("src/a.ts"), file("src/a.test.ts")];

const qaPass: QaReview = { status: "reviewed", verdict: "pass", defects: [], reason: null };
const qaBlocking: QaReview = {
  status: "reviewed",
  verdict: "defects",
  defects: [{ severity: "blocking", file: "src/a.ts", evidence: "Off by one in the loop" }],
  reason: null,
};
const qaFailedToRun: QaReview = { status: "could_not_run", verdict: null, defects: [], reason: "No result" };

type AgentStep = Partial<AgentRun> & {
  tree?: string;
  files?: ChangesetFile[];
  onRun?: () => void;
  /** The job is cancelled while this run is in progress. */
  abort?: boolean;
};

type Fakes = {
  agent?: AgentStep[];
  /** Test result per tree; a tree not listed passes. */
  results?: Record<string, Verification>;
  base?: Verification;
  red?: Verification;
  /** Integrity per tree; a tree not listed is clean, with its test files listed. */
  integrity?: Record<string, IntegrityResult>;
  qa?: QaReview[];
  startTree?: string;
  startFiles?: ChangesetFile[];
  abortOn?: string;
  /** Thrown by buildChangeset on this call (1-based). */
  changesetError?: { call: number; error: Error };
  onVerify?: (tree: string, label?: string) => void;
  now?: () => number;
  input?: Partial<LoopInput>;
};

function harness(f: Fakes) {
  const calls: string[] = [];
  const prompts: string[] = [];
  const budgets: BudgetLeft[] = [];
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const waiting: { id: string; text: string }[] = [];
  const claimed = new Map<number, { id: string; text: string }[]>();
  const ac = new AbortController();
  const hit = (op: string) => {
    calls.push(op);
    if (f.abortOn === op) ac.abort();
  };
  const agentSteps = [...(f.agent ?? [])];
  const qaSteps = [...(f.qa ?? [])];
  let tree = f.startTree ?? "base-tree";
  let files = f.startFiles ?? [];

  const deps: LoopDeps = {
    runAgent: async (prompt, budgetLeft) => {
      hit("agent");
      prompts.push(prompt);
      budgets.push(budgetLeft);
      const { tree: next, files: nextFiles, onRun, abort, ...rest } = agentSteps.shift() ?? {};
      onRun?.();
      if (abort) ac.abort();
      if (next) tree = next;
      if (nextFiles) files = nextFiles;
      else if (next && files.length === 0) files = CODE_AND_TEST;
      return {
        status: "COMPLETED",
        costUsd: 1,
        turns: 2,
        finalText: 'NEXUS_RESULT {"status":"done"}',
        ...rest,
      };
    },
    buildChangeset: async (): Promise<Changeset> => {
      hit("build");
      if (f.changesetError?.call === calls.filter((c) => c === "build").length) throw f.changesetError.error;
      return { files, stats: { added: 1, removed: 0 }, tree };
    },
    verify: async (t, label) => {
      hit(label ? `verify:${label}` : `verify:${t}`);
      f.onVerify?.(t, label);
      if (label === "base") return f.base ?? passed;
      if (label === "red") return f.red ?? failed("red as expected");
      return f.results?.[t] ?? passed;
    },
    redTree: async () => {
      hit("redTree");
      return "red-tree";
    },
    checkIntegrity: async (changed) => {
      hit("integrity");
      return (
        f.integrity?.[tree] ?? {
          clean: true,
          problems: [],
          testFilesChanged: changed.map((c) => c.path).filter((p) => p.includes(".test.")),
        }
      );
    },
    runQa: async (t) => {
      hit(`qa:${t}`);
      return { review: qaSteps.shift() ?? qaPass, costUsd: 0.5, turns: 1 };
    },
    claimFeedback: async (round) => {
      hit(`claim:${round}`);
      // Mirrors the API: claiming is atomic and repeating a claim for a round returns the same items.
      const items = [...(claimed.get(round) ?? []), ...waiting.splice(0)];
      claimed.set(round, items);
      return items;
    },
    event: (type, payload) => events.push({ type, payload }),
    signal: ac.signal,
    now: f.now ?? (() => 1_000_000),
  };
  const input: LoopInput = {
    issue,
    budget: { maxCostUsd: 20, maxTurns: 200, maxWallClockMs: 3_600_000 },
    rounds: 3,
    baseTree: "base-tree",
    canRunTests: true,
    ...f.input,
  };
  return {
    calls,
    prompts,
    budgets,
    events,
    waiting,
    ofType: (type: string) => events.filter((e) => e.type === type).map((e) => e.payload),
    count: (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length,
    run: () => runRepairLoop(deps, input),
  };
}

function expectUpload(r: LoopResult): Extract<LoopResult, { kind: "upload" }> {
  if (r.kind !== "upload") throw new Error(`expected upload, got ${r.kind}`);
  return r;
}

const trees = (...names: string[]): AgentStep[] => names.map((tree) => ({ tree }));
const STORED = { files: CODE_AND_TEST, note: null };

describe("runRepairLoop", () => {
  it("uploads after one agent run when tests pass first time and QA is clean", async () => {
    const h = harness({ agent: trees("t1") });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(1);
    expect(r.changeset.tree).toBe("t1");
    expect(r.verification.status).toBe("passed");
    expect(r.qa).toEqual(qaPass);
    expect(r.integrity.clean).toBe(true);
    expect(r.integrity.testFilesChanged).toEqual(["src/a.test.ts"]);
    expect(r.terminalOutcome).toBeUndefined();
    expect(r.report).toBeUndefined();
    expect(h.count("verify:base")).toBe(0);
    expect(h.ofType("loop.round.started")).toEqual([{ round: 1, of: 4, kind: "attempt" }]);
    expect(h.ofType("loop.stopped")).toEqual([{ reason: "passed" }]);
  });

  it("repairs a failure and uploads the second tree after two runs", async () => {
    const h = harness({ agent: trees("t1", "t2"), results: { t1: failed("AssertionError: nope") } });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(2);
    expect(r.changeset.tree).toBe("t2");
    expect(h.prompts[1]).toContain("This is repair round 1");
    expect(h.prompts[1]).toContain("AssertionError: nope");
    expect(h.ofType("loop.round.started")[1]).toEqual({ round: 2, of: 4, kind: "repair" });
    expect(h.ofType("loop.round.completed")[0]).toMatchObject({ round: 1, result: "failed" });
  });

  it("uploads with FAILED_TESTS and a report when all 3 repairs fail", async () => {
    const h = harness({
      agent: [
        { tree: "t1", finalText: 'Tried A.\nNEXUS_RESULT {"status":"done"}' },
        { tree: "t2", finalText: 'Tried B.\nNEXUS_RESULT {"status":"done"}' },
        { tree: "t3", finalText: 'Tried C.\nNEXUS_RESULT {"status":"done"}' },
        { tree: "t4", finalText: 'I think the cache is stale.\nNEXUS_RESULT {"status":"done"}' },
      ],
      results: {
        t1: failed("fail alpha"),
        t2: failed("fail beta"),
        t3: failed("fail gamma"),
        t4: failed("fail delta"),
      },
    });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(4);
    expect(r.terminalOutcome).toBe("FAILED_TESTS");
    expect(r.changeset.tree).toBe("t4");
    expect(r.report?.rounds.map((x) => x.round)).toEqual([1, 2, 3, 4]);
    expect(r.report?.rounds[0]?.tried).toBe("Tried A.");
    expect(r.report?.stillFailing).toContain("fail delta");
    expect(r.report?.rootCauseGuess).toBe("I think the cache is stale.");
    expect(StuckReport.safeParse(r.report).success).toBe(true);
    expect(h.ofType("loop.stopped")).toEqual([{ reason: "rounds_exhausted" }]);
  });

  it("stops without a repair on an environment failure", async () => {
    const env = failed("sh: pnpm: not found", { failureKind: "environment" });
    const h = harness({ agent: trees("t1"), results: { t1: env } });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(1);
    expect(h.count("verify:base")).toBe(0);
    expect(r.terminalOutcome).toBe("ENVIRONMENT_BLOCKED");
    expect(r.report?.nextStep).toMatch(/environment/i);
  });

  it("says exactly what to add when the repository has no runnable tests", async () => {
    const none: Verification = { ...passed, status: "not_configured", exitCode: null };
    const h = harness({ agent: trees("t1"), results: { t1: none } });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(1);
    expect(r.report?.nextStep).toContain("`test` script");
    expect(r.report?.nextStep).toContain("lockfile");
    expect(r.report?.nextStep).toContain(".nexus.json");
    expect(r.report?.nextStep).toContain("`verify` section");
  });

  it("stops with ALREADY_FAILING when the base fails on the first failure, running the base once", async () => {
    const h = harness({ agent: trees("t1"), results: { t1: failed("boom") }, base: failed("boom on base") });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(1);
    expect(h.count("verify:base")).toBe(1);
    expect(r.terminalOutcome).toBe("ALREADY_FAILING");
    expect(r.report?.nextStep).toMatch(/Keep fixing/);
  });

  it("runs the base check only the first time tests fail", async () => {
    const h = harness({
      agent: trees("t1", "t2", "t3"),
      results: { t1: failed("one"), t2: failed("two") },
    });
    expectUpload(await h.run());
    expect(h.count("agent")).toBe(3);
    expect(h.count("verify:base")).toBe(1);
    expect(h.calls.indexOf("verify:base")).toBeGreaterThan(h.calls.indexOf("verify:t1"));
  });

  it("does not count a base run that could not start as already failing", async () => {
    const h = harness({
      agent: trees("t1", "t2"),
      results: { t1: failed("one") },
      base: { ...passed, status: "error", reason: "Install failed", failureKind: "install_failed" },
    });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(2);
    expect(r.terminalOutcome).toBeUndefined();
  });

  it("skips the base check when the owner's note says to fix the existing failures", async () => {
    const h = harness({
      agent: trees("t1", "t2"),
      results: { t1: failed("boom") },
      base: failed("boom on base"),
      input: { continuation: { files: [], note: "Please also fix the already failing tests." } },
    });
    const r = expectUpload(await h.run());
    expect(h.count("verify:base")).toBe(0);
    expect(h.count("agent")).toBe(2);
    expect(r.terminalOutcome).toBeUndefined();
  });

  it("stops when the same failure comes back twice in a row", async () => {
    const h = harness({
      agent: trees("t1", "t2", "t3"),
      results: {
        t1: failed("expected 1 got 2 at /tmp/run-a/a.test.ts in 12ms"),
        t2: failed("expected 1 got 2 at /tmp/run-b/a.test.ts in 95ms"),
      },
    });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(2);
    expect(r.terminalOutcome).toBe("FAILED_TESTS");
    expect(h.ofType("loop.stopped")).toEqual([{ reason: "repeated_failure" }]);
  });

  it("stops when a repair round changes nothing", async () => {
    const h = harness({ agent: [{ tree: "t1" }, {}], results: { t1: failed("boom") } });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(2);
    expect(h.count("verify:t1")).toBe(1);
    expect(r.changeset.tree).toBe("t1");
    expect(r.terminalOutcome).toBe("FAILED_TESTS");
    expect(h.ofType("loop.stopped")).toEqual([{ reason: "no_change" }]);
    expect(r.report?.rounds[1]?.result).toMatch(/changed nothing/);
  });

  it("stops with a report when the budget left is below a round's minimum", async () => {
    const h = harness({
      agent: [{ tree: "t1", costUsd: 2 - MIN_ROUND_COST_USD / 2 }, { tree: "t2" }],
      results: { t1: failed("boom") },
      input: { budget: { maxCostUsd: 2, maxTurns: 200, maxWallClockMs: 3_600_000 } },
    });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(1);
    expect(r.terminalOutcome).toBe("FAILED_TESTS");
    expect(r.report?.nextStep).toMatch(/budget/i);
    expect(h.ofType("loop.stopped")).toEqual([{ reason: "budget" }]);
  });

  it("stops for too few turns or too little wall clock too", async () => {
    let time = 0;
    const turns = harness({
      agent: [{ tree: "t1", turns: 8 }],
      results: { t1: failed("boom") },
      input: { budget: { maxCostUsd: 20, maxTurns: 10, maxWallClockMs: 3_600_000 } },
    });
    expectUpload(await turns.run());
    expect(turns.ofType("loop.stopped")).toEqual([{ reason: "budget" }]);

    const clock = harness({
      agent: [{ tree: "t1", onRun: () => (time = 3_500_000) }],
      results: { t1: failed("boom") },
      now: () => time,
      input: { budget: { maxCostUsd: 20, maxTurns: 200, maxWallClockMs: 3_600_000 } },
    });
    expectUpload(await clock.run());
    expect(clock.ofType("loop.stopped")).toEqual([{ reason: "budget" }]);
    expect(clock.count("verify:base")).toBe(0);
  });

  it("passes each run the budget left, shared with QA", async () => {
    const h = harness({
      agent: trees("t1", "t2"),
      qa: [qaBlocking, qaPass],
      input: { budget: { maxCostUsd: 10, maxTurns: 100, maxWallClockMs: 3_600_000 } },
    });
    expectUpload(await h.run());
    expect(h.budgets[0]).toEqual({ maxCostUsd: 10, maxTurns: 100, maxWallClockMs: 3_600_000 });
    // One agent run (1 USD, 2 turns) and one review (0.5 USD, 1 turn) later.
    expect(h.budgets[1]).toEqual({ maxCostUsd: 8.5, maxTurns: 97, maxWallClockMs: 3_600_000 });
  });

  it("sends an integrity problem back for repair", async () => {
    const dirty = {
      clean: false,
      problems: ["Added a skip marker to src/a.test.ts"],
      testFilesChanged: ["src/a.test.ts"],
    };
    const h = harness({ agent: trees("t1", "t2"), integrity: { t1: dirty } });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(2);
    expect(h.prompts[1]).toContain("Added a skip marker");
    expect(r.changeset.tree).toBe("t2");
    expect(r.integrity.clean).toBe(true);
  });

  it("uploads not clean when an integrity problem remains", async () => {
    const dirty = { clean: false, problems: ["Changed the test script"], testFilesChanged: [] };
    const h = harness({
      agent: trees("t1", "t2", "t3", "t4"),
      integrity: { t1: dirty, t2: dirty, t3: dirty, t4: dirty },
    });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(4);
    expect(h.count("qa:")).toBe(0);
    expect(r.integrity).toMatchObject({ clean: false, problems: ["Changed the test script"] });
    expect(r.terminalOutcome).toBe("FAILED_TESTS");
    expect(r.report?.stillFailing).toContain("Changed the test script");
  });

  it("caps testFilesChanged at 300 in the upload", async () => {
    const many = Array.from({ length: 400 }, (_, i) => `t/${i}.test.ts`);
    const h = harness({
      agent: trees("t1"),
      integrity: { t1: { clean: true, problems: [], testFilesChanged: many } },
    });
    const r = expectUpload(await h.run());
    expect(r.integrity.testFilesChanged).toHaveLength(300);
  });

  it("repairs when the new tests already pass without the source change", async () => {
    const h = harness({ agent: trees("t1", "t2"), red: passed });
    const r = expectUpload(await h.run());
    expect(h.count("verify:red")).toBe(1);
    expect(h.count("agent")).toBe(2);
    expect(h.prompts[1]).toMatch(/pass without the source change/i);
    expect(h.count("qa:t1")).toBe(0);
    expect(r.changeset.tree).toBe("t2");
  });

  it("does not hold a red run that couldn't run against the agent", async () => {
    const h = harness({
      agent: trees("t1"),
      red: { ...passed, status: "error", reason: "Test run could not start" },
    });
    expectUpload(await h.run());
    expect(h.count("agent")).toBe(1);
    expect(h.count("qa:t1")).toBe(1);
  });

  it("repairs a code change with no test change", async () => {
    const h = harness({
      agent: [
        { tree: "t1", files: [file("src/a.ts")] },
        { tree: "t2", files: CODE_AND_TEST },
      ],
    });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(2);
    expect(h.count("redTree")).toBe(0);
    expect(h.prompts[1]).toMatch(/no test/i);
    expect(r.changeset.tree).toBe("t2");
  });

  it("exempts a docs and config only change from the red check", async () => {
    const h = harness({
      agent: [
        {
          tree: "t1",
          files: [
            file("README.md"),
            file("docs/guide.txt"),
            file(".github/workflows/ci.yml"),
            file("tsconfig.json"),
          ],
        },
      ],
    });
    expectUpload(await h.run());
    expect(h.count("agent")).toBe(1);
    expect(h.count("redTree")).toBe(0);
    expect(h.count("verify:red")).toBe(0);
  });

  it("runs the red check once per job, on the first passing tree", async () => {
    const h = harness({ agent: trees("t1", "t2"), qa: [qaBlocking, qaPass] });
    expectUpload(await h.run());
    expect(h.count("verify:red")).toBe(1);
  });

  it("repairs a blocking QA defect from the same limit of rounds", async () => {
    const h = harness({
      agent: trees("t1", "t2", "t3", "t4"),
      qa: [qaBlocking, qaBlocking, qaBlocking, qaBlocking],
    });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(4);
    expect(h.prompts[1]).toContain("Off by one in the loop");
    expect(r.changeset.tree).toBe("t4");
    expect(r.qa).toEqual(qaBlocking);
    expect(r.terminalOutcome).toBeUndefined();
    expect(h.ofType("qa.completed")).toHaveLength(4);
  });

  it("uploads the last passing tree with its verification and open defects when a QA repair breaks the tests", async () => {
    const t1Result = { ...passed, outputTail: "t1 passing" };
    const h = harness({
      agent: trees("t1", "t2"),
      results: { t1: t1Result, t2: failed("now broken") },
      qa: [qaBlocking],
      base: failed("on base"),
    });
    const r = expectUpload(await h.run());
    expect(r.changeset.tree).toBe("t1");
    expect(r.verification).toEqual(t1Result);
    expect(r.qa).toEqual(qaBlocking);
    expect(r.terminalOutcome).toBeUndefined();
    expect(r.integrity.clean).toBe(true);
    expect(h.count("verify:base")).toBe(0);
  });

  it("uploads when QA could not run", async () => {
    const h = harness({ agent: trees("t1"), qa: [qaFailedToRun] });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(1);
    expect(r.qa).toEqual(qaFailedToRun);
    expect(r.terminalOutcome).toBeUndefined();
  });

  it("skips QA without blocking the upload when too little budget is left for it", async () => {
    const h = harness({
      agent: [{ tree: "t1", costUsd: 4.9 }],
      input: { budget: { maxCostUsd: 5, maxTurns: 200, maxWallClockMs: 3_600_000 } },
    });
    const r = expectUpload(await h.run());
    expect(h.count("qa:")).toBe(0);
    expect(r.qa.status).toBe("could_not_run");
  });

  it("starts another round for feedback waiting after a pass, delivering it once", async () => {
    let queued = false;
    const h = harness({
      agent: trees("t1", "t2"),
      onVerify: (t) => {
        if (t === "t1" && !queued) {
          queued = true;
          h.waiting.push({ id: "f1", text: "Please rename the helper." });
        }
      },
    });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(2);
    expect(h.count("qa:t1")).toBe(0);
    expect(r.changeset.tree).toBe("t2");
    expect(h.prompts[1]).toContain("Guidance from the owner");
    expect(h.prompts[1]).toContain("Please rename the helper.");
    expect(h.prompts[1]?.split("Please rename the helper.")).toHaveLength(2);
    expect(h.ofType("feedback.delivered")).toEqual([{ ids: ["f1"], round: 2 }]);
  });

  it("reports feedback unused when no rounds are left", async () => {
    let queued = false;
    const h = harness({
      agent: trees("t1", "t2", "t3", "t4"),
      results: { t1: failed("a"), t2: failed("b"), t3: failed("c") },
      onVerify: (t) => {
        if (t === "t4" && !queued) {
          queued = true;
          h.waiting.push({ id: "late", text: "One more thing." });
        }
      },
    });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(4);
    expect(r.changeset.tree).toBe("t4");
    expect(h.ofType("feedback.delivered")).toEqual([]);
    expect(h.ofType("loop.stopped")).toEqual([{ reason: "passed", unusedFeedback: ["late"] }]);
  });

  it("returns needs_info with no changeset", async () => {
    const h = harness({
      agent: [
        { tree: "t1", finalText: 'NEXUS_RESULT {"status":"needs_info","questions":["Which region?"]}' },
      ],
    });
    const r = await h.run();
    expect(r).toEqual({ kind: "needs_info", questions: ["Which region?"] });
    expect(h.count("build")).toBe(0);
    expect(h.count("verify:")).toBe(0);
  });

  it("treats a stray qa status or missing result from the Developer as done", async () => {
    const h = harness({
      agent: [{ tree: "t1", finalText: 'NEXUS_RESULT {"status":"qa","verdict":"pass","defects":[]}' }],
    });
    expectUpload(await h.run());
    expect(h.count("verify:t1")).toBe(1);
  });

  it("Keep fixing verifies the stored tree first with no agent run, and a pass goes straight to QA", async () => {
    const h = harness({
      startTree: "stored",
      startFiles: CODE_AND_TEST,
      input: { continuation: STORED },
    });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(0);
    expect(h.calls.filter((c) => !c.startsWith("claim"))).toEqual([
      "build",
      "integrity",
      "verify:stored",
      "redTree",
      "verify:red",
      "qa:stored",
    ]);
    expect(r.changeset.tree).toBe("stored");
    expect(h.ofType("loop.round.started")).toEqual([]);
  });

  it("Keep fixing numbers its repairs 1 to 3 of 3", async () => {
    const h = harness({
      startTree: "stored",
      startFiles: CODE_AND_TEST,
      agent: trees("t1", "t2", "t3"),
      results: { stored: failed("s"), t1: failed("a"), t2: failed("b"), t3: failed("c") },
      input: { continuation: { files: CODE_AND_TEST, note: "Look at the cache" } },
    });
    const r = expectUpload(await h.run());
    expect(h.count("agent")).toBe(3);
    expect(h.ofType("loop.round.started")).toEqual([
      { round: 1, of: 3, kind: "repair" },
      { round: 2, of: 3, kind: "repair" },
      { round: 3, of: 3, kind: "repair" },
    ]);
    expect(h.prompts[0]).toContain("This is repair round 1");
    expect(h.prompts[0]).toContain("Look at the cache");
    expect(r.report?.rounds.map((x) => x.round)).toEqual([1, 2, 3]);
    expect(StuckReport.safeParse(r.report).success).toBe(true);
  });

  it("treats a continuation with no stored files as a fresh attempt carrying the note", async () => {
    const h = harness({
      agent: trees("t1"),
      input: { continuation: { files: [], note: "The region is EU." } },
    });
    expectUpload(await h.run());
    expect(h.count("agent")).toBe(1);
    expect(h.prompts[0]).toContain("The region is EU.");
    expect(h.ofType("loop.round.started")).toEqual([{ round: 1, of: 4, kind: "attempt" }]);
  });

  describe("stops at each await when aborted", () => {
    const fresh: Fakes = { agent: trees("t1") };
    const failing: Fakes = { agent: trees("t1"), results: { t1: failed("boom") }, base: failed("base") };
    it.each([
      ["the opening feedback claim", { ...fresh, abortOn: "claim:1" }],
      ["the agent run", { ...fresh, abortOn: "agent" }],
      ["building the changeset", { ...fresh, abortOn: "build" }],
      ["the integrity check", { ...fresh, abortOn: "integrity" }],
      ["the test run", { ...fresh, abortOn: "verify:t1" }],
      ["the base run", { ...failing, abortOn: "verify:base" }],
      ["building the red tree", { ...fresh, abortOn: "redTree" }],
      ["the red run", { ...fresh, abortOn: "verify:red" }],
      ["the feedback claim after a pass", { ...fresh, abortOn: "claim:2" }],
      ["the QA review", { ...fresh, abortOn: "qa:t1", qa: [qaFailedToRun] }],
    ] satisfies [string, Fakes][])("%s", async (_name, fakes) => {
      const h = harness(fakes);
      expect(await h.run()).toEqual({ kind: "stopped" });
      expect(h.count("agent")).toBeLessThanOrEqual(1);
      // A cancelled review is a cancellation, never a QA result.
      expect(h.ofType("qa.completed")).toEqual([]);
    });

    it("the Keep fixing test run", async () => {
      const h = harness({
        startTree: "stored",
        startFiles: CODE_AND_TEST,
        abortOn: "verify:stored",
        input: { continuation: STORED },
      });
      expect(await h.run()).toEqual({ kind: "stopped" });
      expect(h.count("agent")).toBe(0);
    });

    it("an agent reporting STOPPED", async () => {
      const h = harness({ agent: [{ tree: "t1", status: "STOPPED" }] });
      expect(await h.run()).toEqual({ kind: "stopped" });
    });

    it("a dep that rejects because of the abort", async () => {
      const h = harness({
        agent: [
          {
            tree: "t1",
            onRun: () => {
              throw new Error("aborted");
            },
          },
        ],
        abortOn: "agent",
      });
      expect(await h.run()).toEqual({ kind: "stopped" });
    });
  });

  it("rethrows a dep failure that is not an abort", async () => {
    const h = harness({
      agent: [
        {
          onRun: () => {
            throw new Error("git exploded");
          },
        },
      ],
    });
    await expect(h.run()).rejects.toThrow("git exploded");
  });

  it("uploads the earlier tested tree when an agent run dies with budget exceeded", async () => {
    const h = harness({
      agent: [
        { tree: "t1" },
        { tree: "half-edited", status: "FAILED", reason: "budget_exceeded", details: { budget: "cost" } },
      ],
      results: { t1: failed("boom") },
    });
    const r = expectUpload(await h.run());
    expect(r.changeset.tree).toBe("t1");
    expect(r.terminalOutcome).toBe("FAILED_TESTS");
    expect(h.count("build")).toBe(1);
    expect(h.ofType("loop.stopped")).toEqual([{ reason: "agent_failed" }]);
    expect(StuckReport.safeParse(r.report).success).toBe(true);
  });

  it("uploads the last passing tree when a later agent run dies", async () => {
    const h = harness({
      agent: [{ tree: "t1" }, { tree: "half", status: "FAILED", reason: "agent_failed" }],
      qa: [qaBlocking],
    });
    const r = expectUpload(await h.run());
    expect(r.changeset.tree).toBe("t1");
    expect(r.qa).toEqual(qaBlocking);
    expect(r.terminalOutcome).toBeUndefined();
  });

  it("fails with a budget outcome when the first attempt dies with nothing tested", async () => {
    const h = harness({
      agent: [{ status: "FAILED", reason: "budget_exceeded", details: { budget: "cost" } }],
    });
    const r = await h.run();
    expect(r).toMatchObject({ kind: "failed", reason: "budget_exceeded", outcome: "BUDGET_EXCEEDED" });
    expect(h.count("build")).toBe(0);
  });

  it("uploads nothing after a secret leak, even when an earlier tree passed", async () => {
    const h = harness({
      agent: [
        { tree: "t1" },
        { tree: "t2", status: "FAILED", reason: "secret_leak_detected", details: { files: ["x"] } },
      ],
      qa: [qaBlocking],
    });
    const r = await h.run();
    expect(r).toMatchObject({ kind: "failed", reason: "secret_leak_detected", details: { files: ["x"] } });
  });

  it("reports stop_failed as a failure with nothing uploaded, even when the job was cancelled", async () => {
    const h = harness({
      agent: [
        { tree: "t1" },
        { status: "FAILED", reason: "stop_failed", details: { container: "c" }, abort: true },
      ],
      qa: [qaBlocking],
    });
    expect(await h.run()).toMatchObject({ kind: "failed", reason: "stop_failed" });
  });

  it("keeps the last tested tree when a later changeset is too large", async () => {
    const h = harness({
      agent: trees("t1", "t2"),
      results: { t1: failed("boom") },
      changesetError: {
        call: 2,
        error: new ChangesetError("changeset_too_large", "Too many files", { files: 999 }),
      },
    });
    const r = expectUpload(await h.run());
    expect(r.changeset.tree).toBe("t1");
    expect(r.terminalOutcome).toBe("FAILED_TESTS");
    expect(h.ofType("loop.stopped")).toEqual([{ reason: "agent_failed" }]);
  });

  it("fails when the first changeset cannot be built and nothing was tested", async () => {
    const h = harness({
      agent: trees("t1"),
      changesetError: {
        call: 1,
        error: new ChangesetError("changeset_too_large", "Too many files", { files: 999 }),
      },
    });
    expect(await h.run()).toMatchObject({
      kind: "failed",
      reason: "changeset_too_large",
      details: { files: 999 },
    });
  });

  it("keeps a passing tree when a later round asks a question, and still shows the question", async () => {
    const h = harness({
      agent: [
        { tree: "t1" },
        { tree: "t2", finalText: 'NEXUS_RESULT {"status":"needs_info","questions":["Which region?"]}' },
      ],
      qa: [qaBlocking],
    });
    const r = expectUpload(await h.run());
    expect(r.changeset.tree).toBe("t1");
    expect(r.qa).toEqual(qaBlocking);
    expect(h.ofType("loop.stopped")).toEqual([{ reason: "needs_info", questions: ["Which region?"] }]);
  });

  it("describes each round in the report with that round's own words", async () => {
    const h = harness({
      agent: [
        { tree: "t1", finalText: 'Tried A.\nNEXUS_RESULT {"status":"done"}' },
        { tree: "t2", finalText: 'NEXUS_RESULT {"status":"done"}' },
      ],
      results: { t1: failed("a"), t2: failed("b", { failureKind: "environment" }) },
    });
    const r = expectUpload(await h.run());
    expect(r.report?.rounds[1]?.tried).toBe("The agent did not describe this round.");
    expect(r.report?.rootCauseGuess).toBe("Tried A.");
  });

  it("returns no_changes when the first attempt changes nothing", async () => {
    const h = harness({ agent: [{}] });
    expect(await h.run()).toEqual({ kind: "no_changes" });
    expect(h.count("verify:")).toBe(0);
  });

  it("emits phase events from the agent's final text", async () => {
    const h = harness({
      agent: [
        {
          tree: "t1",
          finalText:
            'NEXUS_PHASE {"phase":"spec","text":"Change the parser"}\nNEXUS_PHASE {"phase":"nope","text":"x"}\nDone.\nNEXUS_RESULT {"status":"done"}',
        },
      ],
    });
    expectUpload(await h.run());
    expect(h.ofType("phase.completed")).toEqual([{ phase: "spec", text: "Change the parser", round: 1 }]);
  });

  it("keeps every report string inside the contract's caps", async () => {
    const long = "x".repeat(20_000);
    const h = harness({
      agent: [{ tree: "t1", finalText: `${long}\nNEXUS_RESULT {"status":"done"}` }],
      results: { t1: failed(long, { failureKind: "environment" }) },
    });
    const r = expectUpload(await h.run());
    expect(StuckReport.safeParse(r.report).success).toBe(true);
    expect(r.report?.rootCauseGuess?.length).toBeLessThanOrEqual(1000);
  });
});
