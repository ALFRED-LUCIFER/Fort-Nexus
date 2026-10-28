import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDEMPOTENCY_HEADER, type Notification, type Plan, type PlanStep } from "@nexus/contracts";
import {
  FakeEventSource,
  IN_PROJECT,
  JOB_ID,
  ME,
  PROJECT_ID,
  apiError,
  job,
  json,
  mockFetch,
  renderApp,
  project,
  runner,
  workspaces,
} from "../test/helpers.tsx";

const T0 = "2026-10-28T10:00:00.000Z";
const PLAN_ID = "55555555-5555-4555-8555-555555555555";
const HASH = "ab12cd34ef56".padEnd(64, "0");

const stepOf = (over: Partial<PlanStep> = {}): PlanStep => ({
  index: 0,
  title: "Check the runner",
  agent: "QA",
  action: {
    type: "jobs.create",
    request: { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version", projectId: PROJECT_ID },
  },
  dependsOn: [],
  status: "PENDING",
  blockedReason: null,
  artifact: null,
  error: null,
  ...over,
});
const planOf = (over: Partial<Plan> = {}): Plan => ({
  id: PLAN_ID,
  projectId: PROJECT_ID,
  goal: "Check the runner, then work on issue #42",
  status: "DRAFT",
  steps: [
    stepOf(),
    stepOf({
      index: 1,
      title: "Fix the cart totals",
      agent: "DEVELOPER",
      dependsOn: [0],
      action: {
        type: "jobs.create",
        request: {
          jobType: "DEV_ISSUE_TO_PR",
          repositoryId: "101",
          issueNumber: 42,
          projectId: PROJECT_ID,
          budget: { maxWallClockMinutes: 45, maxTurns: 60, maxCostUsd: 5 },
        },
      },
    }),
  ],
  planHash: HASH,
  profileVersionId: null,
  createdAt: T0,
  decidedAt: null,
  finishedAt: null,
  ...over,
});

let current: Plan;

function board(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    [`GET /v1/jobs/${JOB_ID}`]: () => json(job()),
    "GET /v1/approvals": () => json({ items: [] }),
    "GET /v1/plans": () => json({ items: [current] }),
    [`GET /v1/plans/${PLAN_ID}`]: () => json(current),
    [`POST /v1/plans/${PLAN_ID}/decision`]: (c) => {
      const { decision } = c.body as { decision: "approve" | "deny" };
      current = { ...current, status: decision === "approve" ? "APPROVED" : "DENIED", decidedAt: T0 };
      return json(current);
    },
    [`POST /v1/plans/${PLAN_ID}/cancel`]: () => {
      current = { ...current, status: "CANCELLED", finishedAt: T0 };
      return json(current);
    },
    ...extra,
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  current = planOf();
});

const drawer = () => screen.findByRole("dialog");

describe("Plans & queue zone", () => {
  it("lists the project's plans with status in text and drafts a plan from a goal with one Idempotency-Key per goal", async () => {
    let attempts = 0;
    const calls = board({
      "POST /v1/plans": () =>
        ++attempts === 1
          ? apiError(502, "INTERNAL", "The AI provider couldn't be reached.")
          : json(current, 201),
    });
    const user = userEvent.setup();
    renderApp(IN_PROJECT);
    const zone = await screen.findByRole("region", { name: "Plans & queue" });
    const node = await within(zone).findByRole("button", {
      name: /Check the runner, then work on issue #42/,
    });
    expect(node.textContent).toMatch(/^Draft · needs your decision · 2 steps/);
    expect(calls.find((c) => c.path === "/v1/plans")!.query.get("projectId")).toBe(PROJECT_ID);

    await user.type(within(zone).getByLabelText("Goal for the Chief of Staff"), "Check the runner");
    await user.click(within(zone).getByRole("button", { name: "Draft a plan" }));
    expect((await within(zone).findByRole("alert")).textContent).toMatch(/couldn't be reached/);
    await user.click(within(zone).getByRole("button", { name: "Draft a plan" }));

    expect(await drawer()).toBeTruthy();
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/v1/plans");
    expect(posts.map((c) => c.body)).toEqual([
      { projectId: PROJECT_ID, goal: "Check the runner" },
      { projectId: PROJECT_ID, goal: "Check the runner" },
    ]);
    expect(posts[1]!.headers.get(IDEMPOTENCY_HEADER)).toBe(posts[0]!.headers.get(IDEMPOTENCY_HEADER));
  });

  it("the All view is read-only: drafting needs a project", async () => {
    board();
    renderApp("/");
    const zone = await screen.findByRole("region", { name: "Plans & queue" });
    expect(within(zone).getByText(/choose a project to draft a plan/)).toBeTruthy();
    expect(within(zone).queryByRole("button", { name: "Draft a plan" })).toBeNull();
  });

  it("an archived project's plans are read-only", async () => {
    board({
      "GET /v1/workspaces": () => json(workspaces([project({ archivedAt: T0 })])),
    });
    renderApp(IN_PROJECT);
    const zone = await screen.findByRole("region", { name: "Plans & queue" });
    const btn = await within(zone).findByRole("button", { name: "Draft a plan" });
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById(btn.getAttribute("aria-describedby")!)!.textContent).toBe(
      "Home is archived: its plans are read-only.",
    );
  });
});

describe("plan drawer", () => {
  it("shows the AI label, steps with agent, action, dependencies and status, and approves the exact hash", async () => {
    const calls = board();
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=plan:${PLAN_ID}`);
    const d = await drawer();
    expect(await within(d).findByText(/^AI inference: unverified/)).toBeTruthy();
    const steps = within(d).getAllByRole("listitem");
    expect(steps[0]!.textContent).toMatch(
      /1Pending\s*QACheck the runnerRunner diagnostic · node-version · read-only/,
    );
    expect(steps[1]!.textContent).toMatch(/Developer · after step 1/);
    expect(steps[1]!.textContent).toMatch(
      /Issue run · repository 101 #42 · up to \$5 · the push needs its own approval/,
    );

    await user.click(within(d).getByRole("button", { name: /Approve plan ab12cd34ef56/ }));
    await within(d).findByText("Approved · starting");
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ decision: "approve", planHash: HASH });
  });

  it("a plan with blocked steps can't be approved: the reason is shown next to the disabled button; deny works", async () => {
    current = planOf({
      steps: [stepOf({ blockedReason: "QA's profile doesn't allow jobs.create.diagnostic" })],
    });
    const calls = board();
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=plan:${PLAN_ID}`);
    const d = await drawer();
    expect(
      await within(d).findByText("Blocked: QA's profile doesn't allow jobs.create.diagnostic"),
    ).toBeTruthy();
    const approve = within(d).getByRole("button", { name: /Approve plan/ });
    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById(approve.getAttribute("aria-describedby")!)!.textContent).toMatch(
      /1 blocked step: deny it/,
    );
    await user.click(within(d).getByRole("button", { name: "Deny" }));
    await within(d).findByText("Denied");
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ decision: "deny" });
  });

  it("a running plan cites verified evidence (the run opens in its drawer) and can be cancelled", async () => {
    current = planOf({
      status: "RUNNING",
      steps: [
        stepOf({
          status: "SUCCEEDED",
          artifact: {
            kind: "job",
            id: JOB_ID,
            evidence: [{ kind: "JOB", id: JOB_ID, label: "run 22222222 · completed", asOf: T0 }],
            verifiedAt: T0,
          },
        }),
        stepOf({ index: 1, status: "FAILED", error: "The run ended failed (command failed)." }),
      ],
    });
    board();
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=plan:${PLAN_ID}`);
    const d = await drawer();
    expect(await within(d).findByText("Succeeded · verified")).toBeTruthy();
    expect(within(d).getByText("The run ended failed (command failed).")).toBeTruthy();
    expect(within(d).queryByRole("button", { name: /Approve plan/ })).toBeNull();
    await user.click(within(d).getByRole("button", { name: "Cancel plan" }));
    await within(d).findByText("Cancelled");
    await user.click(within(d).getByRole("button", { name: "run 22222222 · completed" }));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toMatch(/node-version/));
  });

  it("another project's plan is read-only here", async () => {
    current = planOf({ projectId: "77777777-7777-4777-8777-777777777777" });
    board();
    renderApp(`${IN_PROJECT}&drawer=plan:${PLAN_ID}`);
    const d = await drawer();
    expect((await within(d).findByRole("button", { name: /Approve plan/ })).hasAttribute("disabled")).toBe(
      true,
    );
    expect(within(d).getByText("This plan belongs to another project: switch to it first.")).toBeTruthy();
  });
});

describe("command bar Plan mode and the Inbox deep link", () => {
  it("Plan drafts a plan from the typed goal and opens its drawer", async () => {
    const calls = board({ "POST /v1/plans": () => json(current, 201) });
    const user = userEvent.setup();
    renderApp(IN_PROJECT);
    await user.click(await screen.findByRole("button", { name: "Plan", pressed: false }));
    await user.type(screen.getByRole("textbox", { name: "Command" }), "Check the runner{Enter}");
    expect((await drawer()).textContent).toMatch(/Check the runner, then work on issue #42/);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      projectId: PROJECT_ID,
      goal: "Check the runner",
    });
  });

  it("a plan notification opens the plan", async () => {
    const n: Notification = {
      id: "44444444-4444-4444-8444-000000000001",
      projectId: PROJECT_ID,
      category: "TASK_DONE",
      title: "Plan completed · Check the runner",
      body: "All 2 steps succeeded, each verified from its source record. Open the plan for the evidence.",
      subject: { jobId: null, approvalId: null, planId: PLAN_ID },
      status: "READ",
      createdAt: T0,
    };
    board({ "GET /v1/notifications": () => json({ items: [n], unreadCount: 0 }) });
    const user = userEvent.setup();
    renderApp(`${IN_PROJECT}&drawer=inbox`);
    const inbox = await drawer();
    await user.click(await within(inbox).findByRole("button", { name: /Open the plan/ }));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toMatch(/Plan · Chief of Staff/));
  });
});
