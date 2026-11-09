import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { SSE_RUN_EVENT, type Approval, type Job, type Verification } from "@nexus/contracts";
import {
  FakeEventSource,
  IN_PROJECT,
  JOB_ID,
  ME,
  PROJECT_ID,
  event,
  job,
  json,
  mockFetch,
  renderApp,
  runner,
} from "../test/helpers.tsx";
import { JobLoop } from "./JobLoop.tsx";
import { keepFixingListed, keepFixingOf, loopOf, stuckOf } from "./loopEvents.ts";
import { explainIssue, issueStages, verificationOf } from "./runEvents.ts";

const APPROVAL_ID = "44444444-4444-4444-8444-444444444444";
const HEAD = "nexus/issue-42-22222222";
const T0 = "2026-10-28T10:00:00.000Z";

const test = (status: Verification["status"], over: Partial<Verification> = {}): Verification => ({
  status,
  reason: null,
  source: "package.json",
  install: null,
  test: ["npm", "test"],
  exitCode: status === "passed" ? 0 : 1,
  durationMs: 4000,
  outputTail: "",
  ...over,
});
const issueJob = (over: Partial<Job> = {}): Job =>
  job({
    jobType: "DEV_ISSUE_TO_PR",
    riskTier: "R1",
    status: "RUNNING",
    runnerId: runner().id,
    request: {
      jobType: "DEV_ISSUE_TO_PR",
      projectId: PROJECT_ID,
      repositoryId: "101",
      issueNumber: 42,
      budget: { maxWallClockMinutes: 45, maxTurns: 60, maxCostUsd: 5 },
    },
    ...over,
  });
const approval = (over: Partial<Approval["action"]> = {}): Approval => ({
  id: APPROVAL_ID,
  jobId: JOB_ID,
  projectId: PROJECT_ID,
  riskTier: "R2",
  status: "PENDING",
  action: {
    type: "github.push_draft_pr",
    repositoryId: "101",
    repositoryFullName: "acme/web",
    issueNumber: 42,
    baseBranch: "main",
    baseSha: "a".repeat(40),
    headBranch: HEAD,
    title: "#42: Cart totals",
    body: "Refs #42",
    changesetSha256: "b".repeat(64),
    files: [{ path: "src/money.ts", change: "modified" }],
    stats: { added: 2, removed: 1 },
    verification: test("passed"),
    ...over,
  },
  actionHash: `7f3a91c2${"0".repeat(52)}4c91`,
  createdAt: T0,
  expiresAt: new Date(Date.now() + 3.5 * 3600_000).toISOString(),
  decidedAt: null,
  result: null,
  error: null,
  retry: null,
});

const round = (n: number, of: number, kind: "attempt" | "repair" = "attempt") =>
  ({ round: n, of, kind }) as const;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
});

async function open(j: Job, a: Approval | null = null) {
  mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [j], nextCursor: null }),
    [`GET /v1/jobs/${JOB_ID}`]: () => json(j),
    "GET /v1/approvals": () => json({ items: a ? [a] : [] }),
    [`GET /v1/jobs/${JOB_ID}/feedback`]: () => json({ items: [] }),
  });
  renderApp(`${IN_PROJECT}&drawer=run:${JOB_ID}`);
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const es = FakeEventSource.instances[0]!;
  act(() => es.open());
  return (...events: ReturnType<typeof event>[]) =>
    act(() => events.forEach((e) => es.emit(SSE_RUN_EVENT, e)));
}

describe("run drawer: rounds", () => {
  it("counts 'Round 2 of 4' from the events, and 'of 3' on Keep fixing", async () => {
    const emit = await open(issueJob());
    emit(
      event(1, "loop.round.started", round(1, 4)),
      event(2, "loop.round.completed", { round: 1, result: "failed", summary: "2 tests still fail." }),
      event(3, "loop.round.started", round(2, 4, "repair")),
    );
    const rounds = await screen.findByRole("region", { name: /Rounds/ });
    expect(within(rounds).getByRole("status").textContent).toMatch(/^Round 2 of 4 · repairing now/);
    expect(rounds.textContent).toMatch(/Round 1 of 4 \(first attempt\): tests failed\. 2 tests still fail\./);
    expect(loopOf([event(1, "loop.round.started", round(1, 3))]).rounds[0]?.of).toBe(3);
  });

  it("shows each round's result, NEXUS's test runs and the stop reason in words", async () => {
    const emit = await open(issueJob({ status: "FAILED", outcome: "FAILED_TESTS" }));
    emit(
      event(1, "loop.round.started", round(1, 4)),
      event(2, "test.completed", test("failed")),
      event(3, "loop.round.completed", { round: 1, result: "failed", summary: "1 test failed." }),
      event(4, "loop.round.started", round(2, 4, "repair")),
      event(5, "test.completed", test("failed")),
      event(6, "loop.round.completed", {
        round: 2,
        result: "failed",
        summary: "The same failure as the previous round.",
      }),
      event(7, "loop.stopped", { reason: "repeated_failure" }),
    );
    const rounds = await screen.findByRole("region", { name: /Rounds/ });
    expect(rounds.textContent).toMatch(/Round 2 of 4 \(repair\): tests failed\. The same failure/);
    expect(rounds.textContent).toMatch(/NEXUS test run: failed \(exit 1\)/);
    expect(rounds.textContent).toMatch(/Stopped: The same failure came back twice in a row, so it stopped\./);
    expect(within(rounds).getByRole("status").textContent).toMatch(/the last round/);
  });

  it("shows the phases under 'What the agent understood', as the agent's own unchecked account", async () => {
    const emit = await open(issueJob());
    emit(
      event(1, "phase.completed", { phase: "understand", text: "Totals are rounded in money.ts.", round: 1 }),
      event(2, "phase.completed", { phase: "grill", text: "What if the cart is empty?", round: 1 }),
    );
    const sec = await screen.findByRole("region", { name: "What the agent understood" });
    expect(sec.textContent).toMatch(/Totals are rounded in money\.ts\./);
    expect(sec.textContent).toMatch(/Grill the spec/);
    expect(sec.textContent).toMatch(/the agent's own account and is not checked/);
  });

  it("labels QA as an AI opinion and the stuck report's cause as the agent's best guess", async () => {
    const emit = await open(issueJob({ status: "FAILED", outcome: "FAILED_TESTS" }));
    emit(
      event(1, "qa.completed", {
        status: "reviewed",
        verdict: "defects",
        defects: [
          { severity: "minor", file: null, evidence: "Naming is odd." },
          { severity: "blocking", file: "src/money.ts", evidence: "Rounds the wrong way." },
        ],
        reason: null,
        round: 1,
      }),
      event(2, "job.failed", {
        reason: "tests_failed",
        report: {
          rounds: [{ round: 1, tried: "Changed the rounding.", result: "Still failing." }],
          stillFailing: "money.test.ts rounds half up",
          rootCauseGuess: "A float comparison in toCents.",
          nextStep: "Keep fixing with a note about toCents.",
        },
      }),
    );
    const qa = await screen.findByRole("region", { name: "QA review (AI opinion)" });
    const defects = within(qa).getAllByRole("listitem");
    expect(defects[0]!.textContent).toMatch(/^Blocking.*src\/money\.ts.*Rounds the wrong way/);
    expect(qa.textContent).toMatch(/That is its opinion/);
    const stuck = screen.getByRole("region", { name: "Why it stopped" });
    expect(within(stuck).getByText("Best guess (from the agent):", { exact: false })).toBeTruthy();
    expect(stuck.textContent).toMatch(/hasn't been tested/);
    expect(stuck.textContent).toMatch(/Still failing: money\.test\.ts rounds half up/);
    expect(stuck.textContent).toMatch(/Recommended next step: Keep fixing with a note about toCents\./);
  });

  it("the approval lists QA defects and the test files changed, with NEXUS's notes apart from QA", async () => {
    await open(
      issueJob({ status: "AWAITING_APPROVAL" }),
      approval({
        qa: {
          status: "reviewed",
          verdict: "defects",
          defects: [{ severity: "blocking", file: "src/money.ts", evidence: "Rounds the wrong way." }],
          reason: null,
        },
        testFilesChanged: ["tests/money.test.ts"],
        notes: ["NEXUS found a TODO in the change."],
      }),
    );
    const gate = await screen.findByRole("region", { name: `Push ${HEAD} and open a draft PR?` });
    const qa = within(gate).getByRole("region", { name: "QA review (AI opinion)" });
    expect(qa.textContent).toMatch(/Rounds the wrong way/);
    expect(within(gate).getByRole("heading", { name: "Test files this change touches (1)" })).toBeTruthy();
    expect(gate.textContent).toMatch(/tests\/money\.test\.ts/);
    const notes = within(gate).getByRole("heading", { name: "Open findings from NEXUS" });
    expect(qa.contains(notes)).toBe(false);
    expect(within(gate).getByRole("button", { name: "Approve push" })).toBeTruthy();
    // QA is shown once: the drawer doesn't repeat the approval's review.
    expect(screen.getAllByRole("region", { name: "QA review (AI opinion)" })).toHaveLength(1);
  });
});

describe("loop events", () => {
  it("test runs with `only` are checks, not the job's result", () => {
    const events = [
      event(1, "test.completed", test("passed")),
      event(2, "test.completed", { ...test("failed"), only: "base" }),
      event(3, "test.completed", { ...test("passed"), only: "red" }),
    ];
    expect(verificationOf(events, null)?.status).toBe("passed");
    const stages = issueStages("RUNNING", null, events, null);
    expect(stages.find((s) => s.label === "Test")?.state).toBe("done");
    const view = loopOf(events);
    expect(view.checks.map((c) => c.only)).toEqual(["base", "red"]);
    expect(view.opening?.status).toBe("passed");
  });

  it("reads questions and the report from job.failed", () => {
    const events = [event(1, "job.failed", { reason: "needs_info", questions: ["Which currency?"] })];
    expect(stuckOf(events).questions).toEqual(["Which currency?"]);
    expect(stuckOf([event(1, "job.failed", { report: { nope: 1 } })]).report).toBeUndefined();
  });
});

describe("the questions of a run that kept a passing tree", () => {
  it("shows a question asked after a passing tree, under the stop reason", async () => {
    const view = loopOf([
      event(1, "loop.stopped", { reason: "needs_info", questions: ["Which region?"] }),
    ] as never);
    expect(view.stopped?.questions).toEqual(["Which region?"]);
    render(<JobLoop view={view} status="AWAITING_APPROVAL" stuck={{ questions: [] }} qa={undefined} />);
    expect(screen.getByText("Which region?")).toBeTruthy();
  });

  it("doesn't repeat questions the answer box already shows", () => {
    const view = loopOf([
      event(1, "loop.stopped", { reason: "needs_info", questions: ["Which region?"] }),
    ] as never);
    render(<JobLoop view={view} status="FAILED" stuck={{ questions: ["Which region?"] }} qa={undefined} />);
    expect(screen.queryByText("Which region?")).toBeNull();
  });
});

describe("a repository with no test plan", () => {
  it("explains that the agent was never started", () => {
    expect(
      explainIssue("FAILED", "ENVIRONMENT_BLOCKED", { failReason: "not_configured" }, null, undefined, true),
    ).toMatch(/no tests it can run.*agent wasn't started/i);
  });
});

describe("Keep fixing eligibility", () => {
  const changed = event(1, "artifact.created", {
    kind: "diff",
    fileCount: 2,
    files: [{ path: "a.ts", status: "M" }],
  });
  const failedTests = event(2, "test.completed", test("failed"));
  const state = (j: Job, events: ReturnType<typeof event>[], a: Approval | null = null) =>
    keepFixingOf(j, j.status, a, events).kind;

  it.each(["FAILED", "COMPLETED", "AWAITING_APPROVAL"] as const)(
    "a %s job with saved changes and failed tests is eligible",
    (status) => {
      expect(state(issueJob({ status }), [changed, failedTests])).toBe("eligible");
    },
  );

  it("a passing change no approval can act on is eligible: the integrity block, or a denied approval", () => {
    const passedTests = event(2, "test.completed", test("passed"));
    expect(state(issueJob({ status: "FAILED" }), [changed, passedTests])).toBe("eligible");
    const denied: Approval = { ...approval(), status: "DENIED" };
    expect(state(issueJob({ status: "CANCELLED" }), [changed, passedTests], denied)).toBe("eligible");
  });

  it("a passing change with an open approval is decided there, not kept fixing", () => {
    const passedTests = event(2, "test.completed", test("passed"));
    expect(state(issueJob({ status: "AWAITING_APPROVAL" }), [changed, passedTests], approval())).toBe("no");
  });

  it("the Jobs list offers it for tests that passed only when integrity problems blocked the approval", () => {
    const item = (over: Partial<Job>, tests: "passed" | "failed" = "passed") =>
      ({ job: issueJob(over), tests, approval: null }) as never;
    expect(keepFixingListed(item({ status: "FAILED", outcome: "FAILED_TESTS" }))).toBe(true);
    expect(keepFixingListed(item({ status: "COMPLETED", outcome: "PR_CREATED" }))).toBe(false);
  });

  it("is not offered while working, with no changes, or after the push", () => {
    expect(state(issueJob({ status: "RUNNING" }), [changed, failedTests])).toBe("no");
    expect(state(issueJob({ status: "FAILED" }), [failedTests])).toBe("no");
    expect(
      state(issueJob({ status: "FAILED" }), [
        event(1, "artifact.created", { kind: "diff", fileCount: 1, secretLeak: true }),
        failedTests,
      ]),
    ).toBe("no");
    expect(
      state(issueJob({ status: "FAILED" }), [changed, failedTests], { ...approval(), status: "EXECUTED" }),
    ).toBe("no");
  });

  it("not_configured points at the fix instead; NEEDS_INFO is eligible without changes", () => {
    const none = event(2, "test.completed", test("not_configured", { exitCode: null }));
    expect(keepFixingOf(issueJob({ status: "FAILED" }), "FAILED", null, [changed, none]).kind).toBe(
      "needs_setup",
    );
    expect(state(issueJob({ status: "FAILED", outcome: "NEEDS_INFO" }), [])).toBe("eligible");
  });
});
