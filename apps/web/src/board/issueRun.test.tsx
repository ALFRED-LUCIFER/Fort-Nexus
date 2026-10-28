import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SSE_RUN_EVENT, type Approval, type Job, type Verification } from "@nexus/contracts";
import {
  FakeEventSource,
  IN_PROJECT,
  JOB_ID,
  PROJECT_ID,
  ME,
  apiError,
  event,
  job,
  json,
  mockFetch,
  renderApp,
  runner,
} from "../test/helpers.tsx";
import { issueStages } from "./runEvents.ts";

const T0 = "2026-10-28T10:00:00.000Z";
const HASH = `7f3a91c2${"0".repeat(52)}4c91`;
const OTHER_HASH = `9e1b44d0${"1".repeat(52)}aa07`;
const APPROVAL_ID = "44444444-4444-4444-8444-444444444444";
const HEAD = "nexus/issue-42-22222222";

const PASSED: Verification = {
  status: "passed",
  reason: null,
  source: "package.json",
  install: ["npm", "ci"],
  test: ["npm", "test"],
  exitCode: 0,
  durationMs: 42_000,
  outputTail: "Tests: 12 passed",
};
const FAILED: Verification = {
  ...PASSED,
  status: "failed",
  exitCode: 1,
  outputTail: "FAIL tests/money.test.ts\n  ✕ rounds half up\nTests: 1 failed, 11 passed",
};
const NOT_CONFIGURED: Verification = {
  status: "not_configured",
  reason: null,
  source: null,
  install: null,
  test: null,
  exitCode: null,
  durationMs: 1,
  outputTail: "",
};

const issueJob = (over: Partial<Job> = {}): Job =>
  job({
    jobType: "DEV_ISSUE_TO_PR",
    riskTier: "R1",
    status: "AWAITING_APPROVAL",
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

const approval = (over: Partial<Approval> = {}): Approval => ({
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
    title: "#42: Cart totals round wrong",
    body: "Refs #42\n\nAgent report (unverified): fixed rounding",
    changesetSha256: "b".repeat(64),
    files: [
      { path: "src/lib/money.ts", change: "modified" },
      { path: "tests/money.test.ts", change: "added" },
    ],
    stats: { added: 12, removed: 3 },
    verification: PASSED,
  },
  actionHash: HASH,
  createdAt: T0,
  expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
  decidedAt: null,
  result: null,
  error: null,
  ...over,
});

function open(j: Job, extra: Parameters<typeof mockFetch>[0] = {}) {
  const calls = mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [j], nextCursor: null }),
    [`GET /v1/jobs/${JOB_ID}`]: () => json(j),
    ...extra,
  });
  renderApp(`${IN_PROJECT}&drawer=run:${JOB_ID}`);
  return calls;
}

const fact = (scope: HTMLElement, k: string) =>
  within(scope).getByText(k, { selector: "dt" }).nextElementSibling!.textContent;
const decisions = (calls: ReturnType<typeof mockFetch>) =>
  calls.filter((c) => c.method === "POST" && c.path === `/v1/approvals/${APPROVAL_ID}/decision`);
const stream = async () => {
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const es = FakeEventSource.instances[0]!;
  act(() => es.open());
  return es;
};

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
});
afterEach(() => vi.useRealTimers());

describe("approval gate", () => {
  it("shows the exact push action and posts the shown hash only after confirming", async () => {
    let current = approval();
    const calls = open(issueJob(), {
      "GET /v1/approvals": () => json({ items: [current] }),
      [`POST /v1/approvals/${APPROVAL_ID}/decision`]: () => {
        current = approval({
          status: "EXECUTED",
          decidedAt: T0,
          result: {
            pullRequestNumber: 7,
            pullRequestUrl: "https://github.com/acme/web/pull/7",
            headSha: "c".repeat(40),
          },
        });
        return json(current);
      },
    });
    const user = userEvent.setup();
    const gate = await screen.findByRole("region", { name: `Push ${HEAD} and open a draft PR?` });
    expect(fact(gate, "repository")).toBe("acme/web");
    expect(fact(gate, "branch")).toBe(`main ← ${HEAD}`);
    expect(fact(gate, "changes")).toBe("2 files · +12 −3");
    expect(fact(gate, "action hash")).toBe("7f3a91c2…4c91");
    expect(fact(gate, "tests")).toBe("passed (exit 0) · run by NEXUS in the sandbox");
    expect(within(gate).queryByRole("note")).toBeNull();
    expect(gate.textContent).toMatch(/Never merges\. main is protected\./);
    const files = within(screen.getByRole("region", { name: /^Changed files/ })).getAllByRole("listitem");
    expect(files.map((li) => li.textContent)).toEqual([
      "src/lib/money.tsmodified",
      "tests/money.test.tsadded",
    ]);

    await user.click(within(gate).getByRole("button", { name: "Approve push" }));
    const confirm = screen.getByRole("alertdialog", { name: "Approve this push?" });
    expect(confirm.textContent).toMatch(
      new RegExp(`2 files to the new branch ${HEAD} on acme/web .* against main`),
    );
    expect(confirm.textContent).toMatch(/NEXUS ran the tests in the sandbox: they passed\./);
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(decisions(calls)).toHaveLength(0);

    await user.click(within(gate).getByRole("button", { name: "Approve push" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve push" }));
    await waitFor(() => expect(decisions(calls)).toHaveLength(1));
    expect(decisions(calls)[0]!.body).toEqual({ decision: "approve", actionHash: HASH });

    const link = await screen.findByRole("link", { name: /Draft PR #7 opened — review on GitHub/ });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/web/pull/7");
    expect(
      screen.getByText(/Draft PR #7 is open on GitHub for your review\. NEXUS never merges\./),
    ).toBeTruthy();
  });

  it.each([
    [
      "failed",
      FAILED,
      "Tests failed.",
      "failed (exit 1) · run by NEXUS in the sandbox",
      /they FAILED \(exit code 1\)/,
    ],
    [
      "error",
      {
        ...FAILED,
        status: "error",
        reason: "install failed with exit code 1",
        exitCode: null,
        outputTail: "[nexus] install failed with exit code 1",
      },
      "Tests couldn't run.",
      "couldn't run · run by NEXUS in the sandbox",
      /NEXUS couldn't run the tests: install failed with exit code 1\./,
    ],
  ] as const)(
    "verification %s: an amber warning on the gate, still approvable, and the confirm step repeats it",
    async (_, verification, warning, tests, confirmText) => {
      const calls = open(issueJob(), {
        "GET /v1/approvals": () =>
          json({ items: [approval({ action: { ...approval().action, verification } })] }),
        [`POST /v1/approvals/${APPROVAL_ID}/decision`]: () => json(approval({ status: "APPROVED" })),
      });
      const user = userEvent.setup();
      const gate = await screen.findByRole("region", { name: `Push ${HEAD} and open a draft PR?` });
      const note = within(gate).getByRole("note");
      expect(note.textContent).toMatch(new RegExp(`^${warning}`));
      expect(note.textContent).toMatch(/You can still approve/);
      expect(fact(gate, "tests")).toBe(tests);
      await user.click(within(gate).getByRole("button", { name: "Approve push" }));
      const confirm = screen.getByRole("alertdialog", { name: "Approve this push?" });
      expect(confirm.textContent).toMatch(confirmText);
      await user.click(within(confirm).getByRole("button", { name: "Approve push" }));
      await waitFor(() => expect(decisions(calls)).toHaveLength(1));
    },
  );

  it("not verified: the gate says so plainly, without a warning", async () => {
    open(issueJob(), {
      "GET /v1/approvals": () =>
        json({ items: [approval({ action: { ...approval().action, verification: NOT_CONFIGURED } })] }),
    });
    const gate = await screen.findByRole("region", { name: `Push ${HEAD} and open a draft PR?` });
    expect(fact(gate, "tests")).toBe("not verified by NEXUS");
    expect(within(gate).queryByRole("note")).toBeNull();
  });

  it("denies without a confirm step and says nothing was pushed", async () => {
    let current = approval();
    const calls = open(issueJob(), {
      "GET /v1/approvals": () => json({ items: [current] }),
      [`POST /v1/approvals/${APPROVAL_ID}/decision`]: () => {
        current = approval({ status: "DENIED", decidedAt: T0 });
        return json(current);
      },
    });
    const user = userEvent.setup();
    const gate = await screen.findByRole("region", { name: `Push ${HEAD} and open a draft PR?` });
    await user.click(within(gate).getByRole("button", { name: "Deny" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(decisions(calls)).toHaveLength(1));
    expect(decisions(calls)[0]!.body).toEqual({ decision: "deny", actionHash: HASH });
    expect(
      await screen.findByRole("region", { name: "You denied this push. Nothing was pushed." }),
    ).toBeTruthy();
  });

  it.each([
    ["EXPIRED", "No decision in time. Nothing was pushed.", /lapse after 24 hours/],
    ["FAILED", "GitHub didn't accept the push.", /Reference already exists\. Nothing was merged/],
    ["DENIED", "You denied this push. Nothing was pushed.", /Never merges/],
  ] as const)("explains a %s approval and offers no decision", async (status, title, detail) => {
    open(
      issueJob({ status: status === "FAILED" ? "FAILED" : status === "EXPIRED" ? "EXPIRED" : "COMPLETED" }),
      {
        "GET /v1/approvals": () =>
          json({
            items: [
              approval({
                status,
                decidedAt: T0,
                error: status === "FAILED" ? "Reference already exists." : null,
              }),
            ],
          }),
      },
    );
    const gate = await screen.findByRole("region", { name: title });
    expect(gate.textContent).toMatch(detail);
    expect(within(gate).queryByRole("button", { name: /Approve|Deny/ })).toBeNull();
  });

  it("refetches and tells the owner when the action changed (409 hash mismatch)", async () => {
    let current = approval();
    const calls = open(issueJob(), {
      "GET /v1/approvals": () => json({ items: [current] }),
      [`POST /v1/approvals/${APPROVAL_ID}/decision`]: () => {
        current = approval({ actionHash: OTHER_HASH });
        return apiError(409, "CONFLICT", "actionHash does not match");
      },
    });
    const user = userEvent.setup();
    const gate = await screen.findByRole("region", { name: `Push ${HEAD} and open a draft PR?` });
    await user.click(within(gate).getByRole("button", { name: "Deny" }));
    expect((await within(gate).findByRole("alert")).textContent).toMatch(
      /approval changed after you opened it .*so nothing was decided/,
    );
    await waitFor(() => expect(fact(gate, "action hash")).toBe("9e1b44d0…aa07"));
    const gets = calls.filter((c) => c.path === "/v1/approvals" && c.query.get("jobId") === JOB_ID);
    expect(calls.indexOf(gets.at(-1)!)).toBeGreaterThan(calls.indexOf(decisions(calls)[0]!));
  });
});

describe("issue run", () => {
  const states = () =>
    [...screen.getByRole("list", { name: "Run stages" }).querySelectorAll("li")].map(
      (li) => li.dataset.state,
    );

  it("marks a stage done only when its event arrived", async () => {
    open(issueJob({ status: "RUNNING" }), { "GET /v1/approvals": () => json({ items: [] }) });
    const es = await stream();
    act(() => {
      es.emit(SSE_RUN_EVENT, event(1, "job.created"));
      es.emit(SSE_RUN_EVENT, event(2, "job.state.changed", { to: "RUNNING" }));
      es.emit(SSE_RUN_EVENT, event(3, "agent.started", { engine: "claude-agent-sdk", model: "claude-x" }));
    });
    await waitFor(() =>
      expect(states()).toEqual(["done", "skipped", "active", "pending", "pending", "pending"]),
    );

    act(() => {
      es.emit(SSE_RUN_EVENT, event(4, "job.state.changed", { to: "VERIFYING" }));
      es.emit(
        SSE_RUN_EVENT,
        event(5, "artifact.created", { files: [{ path: "a.ts", status: "M" }], fileCount: 1 }),
      );
      es.emit(SSE_RUN_EVENT, event(6, "job.state.changed", { to: "AWAITING_APPROVAL" }));
      es.emit(SSE_RUN_EVENT, event(7, "approval.requested"));
    });
    // Tests are never verified by NEXUS yet, so Test is never green; Review waits on the owner.
    await waitFor(() =>
      expect(states()).toEqual(["done", "skipped", "done", "skipped", "waiting", "pending"]),
    );
    expect(screen.getByText("not verified")).toBeTruthy();
  });

  it("drives the Test stage from NEXUS's own test.completed, never from the agent", () => {
    const base = [
      event(1, "job.created"),
      event(2, "job.state.changed", { to: "RUNNING" }),
      event(3, "agent.started", { engine: "claude-agent-sdk" }),
      event(4, "job.state.changed", { to: "VERIFYING" }),
    ];
    const test = (status: "VERIFYING" | "AWAITING_APPROVAL", extra: ReturnType<typeof event>[] = []) =>
      issueStages(status, null, [...base, ...extra], null)[3];
    // Running: the agent may claim "all tests pass", but only NEXUS's run counts.
    expect(
      test("VERIFYING", [event(5, "agent.message", { kind: "summary", text: "All tests pass." })]),
    ).toMatchObject({ state: "active" });
    expect(test("AWAITING_APPROVAL", [event(5, "test.completed", PASSED)])).toMatchObject({ state: "done" });
    expect(test("AWAITING_APPROVAL", [event(5, "test.completed", FAILED)])).toMatchObject({
      state: "failed",
      note: "tests failed",
    });
    expect(
      test("AWAITING_APPROVAL", [event(5, "test.completed", { ...FAILED, status: "error", exitCode: null })]),
    ).toMatchObject({ state: "failed", note: "couldn't run" });
    expect(test("AWAITING_APPROVAL", [event(5, "test.completed", NOT_CONFIGURED)])).toMatchObject({
      state: "skipped",
      note: "not configured",
    });
    expect(issueStages("COMPLETED", "COMPLETED_NO_CHANGES", base, null)[3]).toMatchObject({
      state: "skipped",
      note: "no changes",
    });
  });

  it("shows the issue title, the work branch up front and NEXUS's verification card", async () => {
    open(
      issueJob({
        status: "VERIFYING",
        issue: { fullName: "acme/web", issueNumber: 42, title: "Cart totals round wrong", workBranch: HEAD },
      }),
      { "GET /v1/approvals": () => json({ items: [] }) },
    );
    expect(await screen.findByRole("heading", { name: "Cart totals round wrong" })).toBeTruthy();
    expect(screen.getByText(/^Run · issue → draft PR · #42 on acme\/web · /)).toBeTruthy();
    const tile = (k: string) =>
      screen.getByText(k, { selector: "span.font-mono" }).nextElementSibling!.textContent;
    expect(tile("branch")).toBe(HEAD);
    expect(screen.queryByRole("region", { name: /^Tests/ })).toBeNull();

    const es = await stream();
    act(() => es.emit(SSE_RUN_EVENT, event(1, "test.completed", FAILED)));
    const card = await screen.findByRole("region", { name: "Tests failed · exit code 1" });
    expect(card.textContent).toMatch(/^Tests · run by NEXUS in the sandbox/);
    expect(fact(card, "install")).toBe("npm ci");
    expect(fact(card, "test")).toBe("npm test");
    expect(fact(card, "exit code")).toBe("1");
    expect(fact(card, "duration")).toBe("42.0 s");
    expect(fact(card, "config")).toBe("package.json (auto-detected)");
    expect(within(card).getByLabelText("Test output (last lines, redacted)").textContent).toMatch(
      /✕ rounds half up\nTests: 1 failed, 11 passed$/,
    );
    const term = screen.getByRole("region", { name: "Run output" });
    expect(term.textContent).toMatch(/failed · npm test · exit 1/);
  });

  it("not configured: the card says NEXUS didn't verify and points at the agent's unverified report", async () => {
    open(issueJob({ status: "VERIFYING" }), { "GET /v1/approvals": () => json({ items: [] }) });
    const es = await stream();
    act(() => {
      es.emit(SSE_RUN_EVENT, event(1, "agent.message", { kind: "summary", text: "All tests pass." }));
      es.emit(SSE_RUN_EVENT, event(2, "test.completed", NOT_CONFIGURED));
    });
    const card = await screen.findByRole("region", { name: "Tests not verified by NEXUS" });
    expect(card.textContent).toMatch(/^Tests · not run/);
    expect(card.textContent).toMatch(/agent report \(unverified\)/);
    expect(within(card).queryByLabelText(/Test output/)).toBeNull();
    expect(screen.getByRole("region", { name: "Agent report (unverified)" }).textContent).toMatch(
      /All tests pass\./,
    );
  });

  it("couldn't run: the card says why, in the runner's words", async () => {
    open(issueJob({ status: "VERIFYING" }), { "GET /v1/approvals": () => json({ items: [] }) });
    const es = await stream();
    const reason = "Docker is not reachable on the runner host";
    act(() =>
      es.emit(
        SSE_RUN_EVENT,
        event(1, "test.completed", { ...FAILED, status: "error", reason, exitCode: null, outputTail: "" }),
      ),
    );
    const card = await screen.findByRole("region", { name: "Tests couldn't run" });
    expect(within(card).getByText(`Why: ${reason}`)).toBeTruthy();
  });

  it("keeps Draft PR open until external_action.completed, even when the approval says EXECUTED", () => {
    const base = [
      event(1, "job.created"),
      event(2, "job.state.changed", { to: "RUNNING" }),
      event(3, "job.state.changed", { to: "VERIFYING" }),
      event(4, "approval.requested"),
      event(5, "approval.decided", { decision: "approve" }),
    ];
    const executed = approval({ status: "EXECUTED" });
    const before = issueStages("COMPLETED", "PR_CREATED", base, executed);
    expect(before.map((s) => s.state)).toEqual(["done", "skipped", "done", "skipped", "done", "pending"]);
    const after = issueStages(
      "COMPLETED",
      "PR_CREATED",
      [...base, event(6, "external_action.completed")],
      executed,
    );
    expect(after.at(-1)!.state).toBe("done");
    expect(issueStages("QUEUED", null, [], null).every((s) => s.state !== "done")).toBe(true);
  });

  it("shows the agent timeline, highlights blocked egress and labels cost and report honestly", async () => {
    open(issueJob({ status: "RUNNING" }), { "GET /v1/approvals": () => json({ items: [] }) });
    const es = await stream();
    act(() => {
      es.emit(SSE_RUN_EVENT, event(1, "agent.message", { kind: "text", text: "Reading the cart code" }));
      es.emit(
        SSE_RUN_EVENT,
        event(2, "tool.requested", { toolUseId: "t1", tool: "Read", summary: "src/cart.ts" }),
      );
      es.emit(SSE_RUN_EVENT, event(3, "tool.completed", { toolUseId: "t1", tool: "Read", isError: false }));
      es.emit(SSE_RUN_EVENT, event(4, "tool.denied", { kind: "egress", target: "github.com:443" }));
      es.emit(
        SSE_RUN_EVENT,
        event(5, "agent.message", {
          kind: "summary",
          turns: 12,
          estimatedCostUsd: 0.84,
          usage: { inputTokens: 412_000, outputTokens: 38_000 },
          text: "Fixed rounding. All tests pass.",
        }),
      );
    });
    const term = screen.getByRole("region", { name: "Run output" });
    await waitFor(() => expect(term.querySelectorAll("[data-seq]")).toHaveLength(5));
    expect(term.textContent).toMatch(/Reading the cart code/);
    expect(term.textContent).toMatch(/Read src\/cart\.ts/);
    expect(term.textContent).toMatch(/Read done/);
    expect(term.querySelector("[data-alert]")!.textContent).toMatch(
      /Blocked: network blocked → github\.com:443/,
    );
    expect(term.textContent).toMatch(/12 turns · 412000 in \/ 38000 out tokens · \$0\.84 \(estimate\)/);

    const tile = (k: string) =>
      screen.getByText(k, { selector: "span.font-mono" }).nextElementSibling!.textContent;
    expect(tile("cost (estimate)")).toBe("$0.84 / $5");
    expect(tile("turns")).toBe("12 / 60");
    expect(tile("tokens in / out")).toBe("412k / 38k");
    expect(tile("branch")).toBe("named when changes are ready");
    const report = screen.getByRole("region", { name: "Agent report (unverified)" });
    expect(report.textContent).toMatch(/Fixed rounding\. All tests pass\./);
  });
});

describe("inbox", () => {
  const SECOND = "55555555-5555-4555-8555-555555555555";

  it("counts pending approvals, lists them and approves one with its own hash", async () => {
    let pending = [
      approval(),
      approval({ id: SECOND, actionHash: OTHER_HASH, action: { ...approval().action, issueNumber: 7 } }),
    ];
    const calls = mockFetch({
      "GET /v1/me": () => json(ME),
      "GET /v1/runners": () => json({ items: [runner()] }),
      "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
      "GET /v1/approvals": (c) =>
        c.query.get("status") === "PENDING" ? json({ items: pending }) : json({ items: [] }),
      "GET /v1/notifications": () => json({ items: [], unreadCount: 0 }),
      [`POST /v1/approvals/${APPROVAL_ID}/decision`]: () => {
        pending = pending.slice(1);
        return json(approval({ status: "APPROVED" }));
      },
    });
    const user = userEvent.setup();
    const { router } = renderApp(IN_PROJECT);
    await user.click(await screen.findByRole("button", { name: "Inbox, 2 pending approvals, 0 unread" }));
    expect(router.state.location.search).toMatchObject({ drawer: "inbox" });

    const list = await screen.findByRole("list", { name: "Pending approvals" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/Approval · R2/);
    expect(rows[0]!.textContent).toMatch(new RegExp(`Push ${HEAD} \\+ open a draft PR for #42`));
    expect(rows[0]!.textContent).toMatch(/acme\/web · 2 files · \+12 −3 · into main · expires in 3h/);

    await user.click(within(rows[0]!).getByRole("button", { name: "Approve push for #42 on acme/web" }));
    const confirm = screen.getByRole("alertdialog", { name: "Approve this push?" });
    await user.click(within(confirm).getByRole("button", { name: "Approve push" }));
    await waitFor(() => expect(decisions(calls)).toHaveLength(1));
    expect(decisions(calls)[0]!.body).toEqual({ decision: "approve", actionHash: HASH });

    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
    expect(
      screen.getByRole("button", { name: "Inbox, 1 pending approval, 0 unread", hidden: true }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Failures/ }));
    expect(screen.getByText("No failed runs.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^All/ }));
    await user.click(screen.getByRole("button", { name: "Open the run for #7" }));
    expect(router.state.location.search).toMatchObject({ drawer: `run:${JOB_ID}` });
  });

  it("shows the API error, then says when nothing needs the owner", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = true;
    mockFetch({
      "GET /v1/me": () => json(ME),
      "GET /v1/runners": () => json({ items: [runner()] }),
      "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
      "GET /v1/approvals": () =>
        fail ? apiError(503, "INTERNAL", "Approvals are unavailable right now.") : json({ items: [] }),
      "GET /v1/notifications": () => json({ items: [], unreadCount: 0 }),
    });
    renderApp(`${IN_PROJECT}&drawer=inbox`);
    const dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Approvals are unavailable right now.",
    );
    fail = false;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(await within(dialog).findByText(/Nothing needs you\./)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Inbox, 0 pending approvals, 0 unread", hidden: true }),
    ).toBeTruthy();
  });
});
