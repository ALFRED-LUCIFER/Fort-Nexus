import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager } from "@tanstack/react-query";
import { PICK_PROJECT } from "./scope.tsx";
import {
  SSE_RUN_EVENT,
  type Approval,
  type Job,
  type JobFeedback,
  type Verification,
} from "@nexus/contracts";
import {
  FakeEventSource,
  IN_PROJECT,
  JOB_ID,
  ME,
  PROJECT_ID,
  apiError,
  event,
  job,
  json,
  mockFetch,
  renderApp,
  runner,
  type Call,
} from "../test/helpers.tsx";

const NEW_JOB = "22222222-2222-4222-8222-222222222999";
const FEEDBACK_ID = "55555555-5555-4555-8555-555555555551";
const APPROVAL_ID = "44444444-4444-4444-8444-444444444444";
const T0 = "2026-10-28T10:00:00.000Z";
const KEEP = `POST /v1/jobs/${JOB_ID}/keep-fixing`;
const FEEDBACK = `/v1/jobs/${JOB_ID}/feedback`;
const QUEUED = { jobId: NEW_JOB, status: "QUEUED", streamUrl: `/v1/jobs/${NEW_JOB}/events` };

const tests = (status: Verification["status"]): Verification => ({
  status,
  reason: null,
  source: "package.json",
  install: null,
  test: ["npm", "test"],
  exitCode: status === "passed" ? 0 : 1,
  durationMs: 1000,
  outputTail: "",
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
const message = (over: Partial<JobFeedback> = {}): JobFeedback => ({
  id: FEEDBACK_ID,
  jobId: JOB_ID,
  text: "Mind the empty cart.",
  createdAt: T0,
  deliveredRound: null,
  ...over,
});
const approval = (status: Approval["status"] = "PENDING"): Approval => ({
  id: APPROVAL_ID,
  jobId: JOB_ID,
  projectId: PROJECT_ID,
  riskTier: "R2",
  status,
  action: {
    type: "github.push_draft_pr",
    repositoryId: "101",
    repositoryFullName: "acme/web",
    issueNumber: 42,
    baseBranch: "main",
    baseSha: "a".repeat(40),
    headBranch: "nexus/issue-42-22222222",
    title: "#42",
    body: "Refs #42",
    changesetSha256: "b".repeat(64),
    files: [{ path: "src/money.ts", change: "modified" }],
    stats: { added: 2, removed: 1 },
    verification: tests("failed"),
  },
  actionHash: `7f3a91c2${"0".repeat(52)}4c91`,
  createdAt: T0,
  expiresAt: new Date(Date.now() + 3.5 * 3600_000).toISOString(),
  decidedAt: null,
  result: null,
  error: null,
  retry: null,
});

let messages: JobFeedback[] = [];
async function open(j: Job, extra: Parameters<typeof mockFetch>[0] = {}, a: Approval | null = null) {
  const calls = mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [j], nextCursor: null }),
    [`GET /v1/jobs/${JOB_ID}`]: () => json(j),
    [`GET /v1/jobs/${NEW_JOB}`]: () =>
      json(issueJob({ id: NEW_JOB, status: "QUEUED", retryOfJobId: JOB_ID })),
    "GET /v1/approvals": () => json({ items: a ? [a] : [] }),
    [`GET ${FEEDBACK}`]: () => json({ items: messages }),
    ...extra,
  });
  const { router } = renderApp(`${IN_PROJECT}&drawer=run:${JOB_ID}`);
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const es = FakeEventSource.instances[0]!;
  act(() => es.open());
  const emit = (...events: ReturnType<typeof event>[]) =>
    act(() => events.forEach((e) => es.emit(SSE_RUN_EVENT, e)));
  return { calls, router, emit };
}
const box = (name: string | RegExp) => screen.findByRole<HTMLTextAreaElement>("textbox", { name });
const posts = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);
const changed = event(1, "artifact.created", {
  kind: "diff",
  fileCount: 1,
  files: [{ path: "a.ts", status: "M" }],
});

beforeEach(() => {
  messages = [];
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
});
afterEach(() => onlineManager.setOnline(true));

describe("run drawer: talk to the agent", () => {
  it("sends feedback while the job runs; it waits for the next round, then shows the round that read it", async () => {
    const user = userEvent.setup();
    const { calls, emit } = await open(issueJob(), {
      [`POST ${FEEDBACK}`]: (c) => {
        messages = [message({ text: (c.body as { text: string }).text })];
        return json(messages[0], 201);
      },
    });
    const input = await box("Message to the agent");
    await user.type(input, "Mind the empty cart.");
    await user.click(screen.getByRole("button", { name: "Send to the agent" }));

    await waitFor(() => expect(posts(calls, FEEDBACK)).toHaveLength(1));
    expect(posts(calls, FEEDBACK)[0]!.body).toEqual({ text: "Mind the empty cart." });
    expect(posts(calls, FEEDBACK)[0]!.headers.get("idempotency-key")).toBeTruthy();
    const list = await screen.findByRole("status", { name: "Your messages to the agent" });
    expect(list.textContent).toMatch(/Mind the empty cart\./);
    expect(list.textContent).toMatch(/Waiting for the next round/);
    expect(input.value).toBe("");

    messages = [message({ deliveredRound: 2 })];
    emit(event(5, "feedback.delivered", { ids: [FEEDBACK_ID], round: 2 }));
    await waitFor(() => expect(list.textContent).toMatch(/Delivered to round 2/));
  });

  it("a message the job ended before reading says it wasn't used", async () => {
    messages = [message({ deliveredRound: 0 })];
    await open(issueJob({ status: "FAILED", outcome: "FAILED_TESTS" }));
    expect((await screen.findByRole("status", { name: "Your messages to the agent" })).textContent).toMatch(
      /Not used: the job ended first/,
    );
  });

  it("Enter sends, Shift+Enter starts a new line, and the box has a label", async () => {
    const user = userEvent.setup();
    const { calls } = await open(issueJob(), {
      [`POST ${FEEDBACK}`]: () => json(message(), 201),
    });
    const input = await box("Message to the agent");
    await user.type(input, "one{Shift>}{Enter}{/Shift}two");
    expect(input.value).toBe("one\ntwo");
    expect(posts(calls, FEEDBACK)).toHaveLength(0);
    await user.type(input, "{Enter}");
    await waitFor(() => expect(posts(calls, FEEDBACK)).toHaveLength(1));
    expect(posts(calls, FEEDBACK)[0]!.body).toEqual({ text: "one\ntwo" });
  });

  it("shows a count near the limit and won't send past it", async () => {
    const user = userEvent.setup();
    await open(issueJob());
    const input = await box("Message to the agent");
    await user.click(input);
    await user.paste("x".repeat(1900));
    expect(screen.getByText("1,900 of 2,000 characters")).toBeTruthy();
    await user.paste("y".repeat(101));
    expect(screen.getByText(/1 characters over the 2,000 limit/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send to the agent" }).disabled).toBe(true);
  });

  it("says when it can't send: offline, and the server's refusal", async () => {
    const user = userEvent.setup();
    await open(issueJob(), {
      [`POST ${FEEDBACK}`]: () =>
        apiError(409, "CONFLICT", "This job has finished. Use Keep fixing to continue it."),
    });
    const input = await box("Message to the agent");
    await user.type(input, "hello");
    await user.click(screen.getByRole("button", { name: "Send to the agent" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/This job has finished\. Use Keep fixing/);
    expect(input.value).toBe("hello");
    act(() => onlineManager.setOnline(false));
    expect(await screen.findByText(/You're offline\. Send it when the connection is back\./)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send to the agent" }).disabled).toBe(true);
  });
});

describe("run drawer: Keep fixing and answering", () => {
  it("a finished job's box becomes the Keep fixing note; a double click sends one key, and it opens the new run", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const user = userEvent.setup();
    const { calls, router, emit } = await open(issueJob({ status: "FAILED", outcome: "FAILED_TESTS" }), {
      [KEEP]: async () => {
        await gate;
        return json(QUEUED, 202);
      },
    });
    emit(changed, event(2, "test.completed", tests("failed")));
    await user.type(await box("Note for the agent (optional)"), "Try rounding in toCents.");
    await user.dblClick(screen.getByRole("button", { name: "Keep fixing" }));
    expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Queueing…" })).disabled).toBe(true);
    release();
    await waitFor(() => expect(router.state.location.search.drawer).toBe(`run:${NEW_JOB}`));
    expect(posts(calls, `/v1/jobs/${JOB_ID}/keep-fixing`)).toHaveLength(1);
    expect(posts(calls, `/v1/jobs/${JOB_ID}/keep-fixing`)[0]!.body).toEqual({
      note: "Try rounding in toCents.",
    });
  });

  it("is absent when a passing change waits for approval", async () => {
    const pending = { ...approval(), action: { ...approval().action, verification: tests("passed") } };
    await open(issueJob({ status: "AWAITING_APPROVAL" }), {}, pending);
    await screen.findByRole("region", { name: "Run output" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Approve/ })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Keep fixing" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /agent/ })).toBeNull();
  });

  it("is absent when nothing was saved", async () => {
    const { emit } = await open(issueJob({ status: "FAILED", outcome: "COMPLETED_NO_CHANGES" }));
    emit(event(2, "test.completed", tests("passed")));
    await screen.findByRole("region", { name: "Run output" });
    expect(screen.queryByRole("button", { name: "Keep fixing" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /agent/ })).toBeNull();
  });

  it("while an approval is pending the button says it withdraws the approval", async () => {
    await open(issueJob({ status: "AWAITING_APPROVAL" }), {}, approval());
    await box("Note for the agent (optional)");
    expect(screen.getByText(/withdraws the pending approval/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep fixing" })).toBeTruthy();
  });

  it("shows the server's refusal instead of hiding it", async () => {
    const user = userEvent.setup();
    const { emit } = await open(issueJob({ status: "FAILED" }), {
      [KEEP]: () =>
        apiError(409, "CONFLICT", "This job saved no changes to continue from. Use Run again to start over."),
    });
    emit(changed, event(2, "test.completed", tests("failed")));
    await user.click(await screen.findByRole("button", { name: "Keep fixing" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/saved no changes to continue from/);
  });

  it("not_configured isn't offered; it says what to add from the report", async () => {
    const { emit } = await open(issueJob({ status: "FAILED", outcome: "ENVIRONMENT_BLOCKED" }));
    emit(
      changed,
      event(2, "test.completed", { ...tests("not_configured"), exitCode: null }),
      event(3, "job.failed", {
        reason: "environment_blocked",
        report: {
          rounds: [],
          stillFailing: "No tests could run.",
          rootCauseGuess: null,
          nextStep: "Add a test script to package.json, then use Run again.",
        },
      }),
    );
    expect((await screen.findByRole("note")).textContent).toMatch(
      /Keep fixing isn't available here\..*Add a test script to package\.json, then use Run again\./,
    );
    expect(screen.queryByRole("button", { name: "Keep fixing" })).toBeNull();
  });

  it("NEEDS_INFO shows the questions, and the box is the answer", async () => {
    const user = userEvent.setup();
    const { calls, emit } = await open(issueJob({ status: "FAILED", outcome: "NEEDS_INFO" }), {
      [KEEP]: () => json(QUEUED, 202),
    });
    emit(event(1, "job.failed", { reason: "needs_info", questions: ["Which currency?", "Round half up?"] }));
    expect(await screen.findByText("Which currency?")).toBeTruthy();
    expect(screen.getByText("Round half up?")).toBeTruthy();
    const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send answer and continue" });
    expect(send.disabled).toBe(true); // an answer can't be empty
    await user.type(
      screen.getByRole("textbox", { name: "Your answer to the agent's questions" }),
      "Euro, yes.",
    );
    await user.click(send);
    await waitFor(() => expect(posts(calls, `/v1/jobs/${JOB_ID}/keep-fixing`)).toHaveLength(1));
    expect(posts(calls, `/v1/jobs/${JOB_ID}/keep-fixing`)[0]!.body).toEqual({ note: "Euro, yes." });
  });

  it("a finished job that isn't eligible has no box", async () => {
    await open(issueJob({ status: "COMPLETED", outcome: "PR_CREATED" }));
    await screen.findByRole("region", { name: "Run output" });
    expect(screen.queryByRole("textbox", { name: /agent|answer/i })).toBeNull();
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Keep fixing" })).toBeNull();
  });
});

const keyOf = (c: Call) => c.headers.get("idempotency-key");

describe("idempotency keys follow the intended action", () => {
  it("Keep fixing: a retry of the same note reuses the key, a changed note gets a new one", async () => {
    let n = 0;
    const user = userEvent.setup();
    const { calls, emit } = await open(issueJob({ status: "FAILED", outcome: "FAILED_TESTS" }), {
      [KEEP]: () => (++n === 1 ? apiError(500, "INTERNAL", "Try again.") : json(QUEUED, 202)),
    });
    emit(changed, event(2, "test.completed", tests("failed")));
    const input = await box("Note for the agent (optional)");
    await user.type(input, "first note");
    await user.click(screen.getByRole("button", { name: "Keep fixing" }));
    await screen.findByRole("alert");
    n = 0;
    await user.click(screen.getByRole("button", { name: "Keep fixing" }));
    await waitFor(() => expect(posts(calls, `/v1/jobs/${JOB_ID}/keep-fixing`)).toHaveLength(2));
    const [a, b] = posts(calls, `/v1/jobs/${JOB_ID}/keep-fixing`);
    expect(keyOf(a!)).toBeTruthy();
    expect(keyOf(b!)).toBe(keyOf(a!));
  });

  it("Keep fixing: changing the note after a failure uses a different key", async () => {
    const user = userEvent.setup();
    const { calls, emit } = await open(issueJob({ status: "FAILED", outcome: "FAILED_TESTS" }), {
      [KEEP]: () => apiError(500, "INTERNAL", "Try again."),
    });
    emit(changed, event(2, "test.completed", tests("failed")));
    const input = await box("Note for the agent (optional)");
    await user.type(input, "first note");
    await user.click(screen.getByRole("button", { name: "Keep fixing" }));
    await waitFor(() => expect(posts(calls, `/v1/jobs/${JOB_ID}/keep-fixing`)).toHaveLength(1));
    await screen.findByRole("alert");
    await user.type(input, " and more");
    await user.click(screen.getByRole("button", { name: "Keep fixing" }));
    await waitFor(() => expect(posts(calls, `/v1/jobs/${JOB_ID}/keep-fixing`)).toHaveLength(2));
    const [a, b] = posts(calls, `/v1/jobs/${JOB_ID}/keep-fixing`);
    expect(keyOf(b!)).not.toBe(keyOf(a!));
  });

  it("feedback: the same words retried reuse the key; changed words get a new one", async () => {
    const user = userEvent.setup();
    const { calls } = await open(issueJob(), {
      [`POST ${FEEDBACK}`]: () => apiError(500, "INTERNAL", "Try again."),
    });
    const input = await box("Message to the agent");
    await user.type(input, "one");
    await user.click(screen.getByRole("button", { name: "Send to the agent" }));
    await waitFor(() => expect(posts(calls, FEEDBACK)).toHaveLength(1));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Send to the agent" }));
    await waitFor(() => expect(posts(calls, FEEDBACK)).toHaveLength(2));
    await user.type(input, " two");
    await user.click(screen.getByRole("button", { name: "Send to the agent" }));
    await waitFor(() => expect(posts(calls, FEEDBACK)).toHaveLength(3));
    const [a, b, c] = posts(calls, FEEDBACK);
    expect(keyOf(a!)).toBeTruthy();
    expect(keyOf(b!)).toBe(keyOf(a!));
    expect(keyOf(c!)).not.toBe(keyOf(a!));
  });
});

describe("feedback delivery from the runner's own events", () => {
  it("doesn't take the API's claim for a delivery: a claimed round may never have run", async () => {
    messages = [message({ deliveredRound: 3 })];
    await open(issueJob());
    const list = await screen.findByRole("status", { name: "Your messages to the agent" });
    expect(list.textContent).toMatch(/Waiting for the next round/);
    expect(list.textContent).not.toMatch(/Delivered/);
  });

  it("a message posted after the loop stopped says it wasn't used, while the job is still finishing", async () => {
    messages = [message({ deliveredRound: null })];
    const { emit } = await open(issueJob({ status: "VERIFYING" }));
    const list = await screen.findByRole("status", { name: "Your messages to the agent" });
    expect(list.textContent).toMatch(/Waiting for the next round/);
    emit(event(6, "loop.stopped", { reason: "passed" }));
    await waitFor(() => expect(list.textContent).toMatch(/Not used: the job ended first/));
  });

  it("prefers the job's own running total for cost over the last agent's summary", async () => {
    const { emit } = await open(issueJob({ estimatedCostUsd: 1.5 }));
    emit(event(5, "agent.message", { kind: "summary", estimatedCostUsd: 0.1, turns: 3 }));
    expect(await screen.findByText("$1.50 / $5")).toBeTruthy();
  });

  it("shows the Developer's report, not QA's, and never the NEXUS_RESULT line", async () => {
    const { emit } = await open(issueJob());
    emit(
      event(4, "agent.started", { engine: "claude-agent-sdk" }),
      event(5, "agent.message", {
        kind: "summary",
        text: 'Fixed the rounding.\nNEXUS_RESULT {"status":"done"}',
      }),
      event(6, "agent.started", { engine: "claude-agent-sdk", agent: "QA" }),
      event(7, "agent.message", {
        kind: "summary",
        text: 'The diff looks right.\nNEXUS_RESULT {"status":"qa","verdict":"pass","defects":[]}',
      }),
    );
    const report = await screen.findByRole("region", { name: "Agent report (unverified)" });
    expect(report.textContent).toMatch(/Fixed the rounding\./);
    expect(report.textContent).not.toMatch(/diff looks right/);
    expect(report.textContent).not.toMatch(/NEXUS_RESULT/);
  });

  it("shows the round from feedback.delivered while the API still says null", async () => {
    messages = [message({ deliveredRound: null })];
    const { emit } = await open(issueJob());
    const list = await screen.findByRole("status", { name: "Your messages to the agent" });
    expect(list.textContent).toMatch(/Waiting for the next round/);
    emit(event(5, "feedback.delivered", { ids: [FEEDBACK_ID], round: 3 }));
    await waitFor(() => expect(list.textContent).toMatch(/Delivered to round 3/));
  });

  it("says a message wasn't used when loop.stopped lists it as unused", async () => {
    messages = [message({ deliveredRound: null })];
    const { emit } = await open(issueJob());
    const list = await screen.findByRole("status", { name: "Your messages to the agent" });
    emit(event(6, "loop.stopped", { reason: "rounds_exhausted", unusedFeedback: [FEEDBACK_ID] }));
    await waitFor(() => expect(list.textContent).toMatch(/Not used: the job ended first/));
  });
});

describe("scope and offline guards on paid or sending actions", () => {
  it("the feedback box is disabled with the scope's reason in All", async () => {
    mockFetch({
      "GET /v1/me": () => json(ME),
      "GET /v1/runners": () => json({ items: [runner()] }),
      "GET /v1/jobs": () => json({ items: [issueJob()], nextCursor: null }),
      [`GET /v1/jobs/${JOB_ID}`]: () => json(issueJob()),
      "GET /v1/approvals": () => json({ items: [] }),
      [`GET ${FEEDBACK}`]: () => json({ items: [] }),
    });
    const user = userEvent.setup();
    renderApp(`/?ws=dev&drawer=run:${JOB_ID}`);
    const input = await box("Message to the agent");
    await user.type(input, "hello");
    expect(await screen.findByText(PICK_PROJECT)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send to the agent" }).disabled).toBe(true);
  });

  it("Keep fixing in the drawer is disabled offline and sends nothing", async () => {
    const user = userEvent.setup();
    const { calls, emit } = await open(issueJob({ status: "FAILED", outcome: "FAILED_TESTS" }), {
      [KEEP]: () => json(QUEUED, 202),
    });
    emit(changed, event(2, "test.completed", tests("failed")));
    await user.type(await box("Note for the agent (optional)"), "note");
    act(() => onlineManager.setOnline(false));
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Keep fixing" });
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(
      screen.getByText(/You're offline\. You can keep fixing when the connection is back\./),
    ).toBeTruthy();
    await user.click(button);
    expect(posts(calls, `/v1/jobs/${JOB_ID}/keep-fixing`)).toHaveLength(0);
  });
});

describe("Jobs page: Keep fixing", () => {
  const NOT_PASSED = "33333333-3333-4333-8333-333333333331";
  const PASSED = "33333333-3333-4333-8333-333333333332";
  const row = (id: string, tests: Verification["status"], outcome: Job["outcome"] = "FAILED_TESTS") => ({
    job: issueJob({ id, status: outcome === "PR_CREATED" ? "COMPLETED" : "FAILED", outcome }),
    repositoryId: "101",
    repositoryFullName: "acme/web",
    durationMs: null,
    tests,
    pullRequest: null,
    approval: null,
  });

  it("is beside Run again only on a job whose tests didn't pass, and sends one key with no note", async () => {
    const calls = mockFetch({
      "GET /v1/me": () => json(ME),
      "GET /v1/runners": () => json({ items: [runner()] }),
      "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
      "GET /v1/jobs/history": () =>
        json({
          items: [row(NOT_PASSED, "failed"), row(PASSED, "passed", "PR_CREATED")],
          nextCursor: null,
        }),
      [`POST /v1/jobs/${NOT_PASSED}/keep-fixing`]: () => json(QUEUED, 202),
      [`GET /v1/jobs/${NEW_JOB}`]: () => json(issueJob({ id: NEW_JOB, status: "QUEUED" })),
    });
    const user = userEvent.setup();
    const { router } = renderApp(`${IN_PROJECT}&drawer=jobs`);
    const buttons = await screen.findAllByRole("button", { name: /^Keep fixing/ });
    expect(buttons).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Run again/ })).toHaveLength(2);
    await user.dblClick(buttons[0]!);
    await waitFor(() => expect(router.state.location.search.drawer).toBe(`run:${NEW_JOB}`));
    const sent = posts(calls, `/v1/jobs/${NOT_PASSED}/keep-fixing`);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBeNull();
    expect(sent[0]!.headers.get("idempotency-key")).toBeTruthy();
  });

  it("is disabled offline on the row and sends nothing", async () => {
    const calls = mockFetch({
      "GET /v1/me": () => json(ME),
      "GET /v1/runners": () => json({ items: [runner()] }),
      "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
      "GET /v1/jobs/history": () => json({ items: [row(NOT_PASSED, "failed")], nextCursor: null }),
      [`POST /v1/jobs/${NOT_PASSED}/keep-fixing`]: () => json(QUEUED, 202),
    });
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=jobs`);
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: /^Keep fixing/ });
    act(() => onlineManager.setOnline(false));
    await waitFor(() => expect(button.disabled).toBe(true));
    await user.click(button);
    expect(posts(calls, `/v1/jobs/${NOT_PASSED}/keep-fixing`)).toHaveLength(0);
  });
});
