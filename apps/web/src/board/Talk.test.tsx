import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionProposal, ThreadDetail, Turn } from "@nexus/contracts";
import { IN_PROJECT, ME, PROJECT_ID, json, mockFetch, renderApp, runner } from "../test/helpers.tsx";
import { PICK_PROJECT } from "./scope.tsx";

const T0 = "2026-10-28T10:00:00.000Z";
const THREAD = "55555555-5555-4555-8555-555555555555";
const JOB = "22222222-2222-4222-8222-222222222222";
const PROPOSAL = "66666666-6666-4666-8666-666666666666";
const HASH = `7f3a91c2${"0".repeat(52)}4c91`;

const turn = (over: Partial<Turn>): Turn => ({
  id: "77777777-7777-4777-8777-000000000001",
  threadId: THREAD,
  role: "USER",
  text: "How is my run?",
  intent: null,
  basis: "NONE",
  sources: [],
  proposalId: null,
  correlationId: "req-1",
  createdAt: T0,
  ...over,
});

const proposal = (over: Partial<ActionProposal> = {}): ActionProposal => ({
  id: PROPOSAL,
  threadId: THREAD,
  turnId: "77777777-7777-4777-8777-000000000004",
  riskTier: "R1",
  action: {
    type: "jobs.create",
    request: {
      jobType: "DEV_ISSUE_TO_PR",
      projectId: "0190f0a0-0000-7000-8000-000000000001",
      repositoryId: "101",
      issueNumber: 42,
      budget: { maxWallClockMinutes: 45, maxTurns: 60, maxCostUsd: 5 },
    },
    preview: 'Start a coding run for acme/web issue #42: "Fix cart totals".',
  },
  actionHash: HASH,
  status: "AWAITING_APPROVAL",
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  decidedAt: null,
  result: null,
  error: null,
  createdAt: T0,
  ...over,
});

const detail = (p: ActionProposal | null = null): ThreadDetail => ({
  thread: {
    id: THREAD,
    projectId: PROJECT_ID,
    title: "How is my run?",
    subjectJobId: JOB,
    profileVersionId: null,
    createdAt: T0,
    updatedAt: T0,
  },
  turns: [
    turn({}),
    turn({
      id: "77777777-7777-4777-8777-000000000002",
      role: "ASSISTANT",
      text: "Run 22222222 (diagnostic node-version) is running.",
      intent: { kind: "RUN_STATUS" },
      basis: "PENDING",
      sources: [{ kind: "JOB", id: JOB, label: "run 22222222 · Running", asOf: T0 }],
    }),
    ...(p
      ? [
          turn({ id: "77777777-7777-4777-8777-000000000003", text: "work on acme/web#42" }),
          turn({
            id: p.turnId,
            role: "ASSISTANT",
            text: "I can start a run for acme/web #42. Nothing starts until you confirm it on screen.",
            intent: { kind: "START_ISSUE_RUN", repositoryFullName: "acme/web", issueNumber: 42 },
            basis: "PENDING",
            proposalId: p.id,
          }),
        ]
      : []),
  ],
  proposals: p ? [p] : [],
});

const base = { "GET /v1/me": () => json(ME), "GET /v1/runners": () => json({ items: [runner()] }) };

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
});

const describedBy = (el: HTMLElement) =>
  document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent;

describe("Talk drawer", () => {
  it("opens from the Talk button, lists the project's threads and starts one in that project", async () => {
    const calls = mockFetch({
      ...base,
      "GET /v1/conversations": () => json({ items: [], nextCursor: null }),
      "POST /v1/conversations": () => json(detail().thread, 201),
      [`GET /v1/conversations/${THREAD}`]: () => json({ ...detail(), turns: [] }),
    });
    const { router } = renderApp(IN_PROJECT);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Talk" }));
    expect(await screen.findByText("No conversations yet.")).toBeTruthy();
    expect(calls.find((c) => c.path === "/v1/conversations")!.query.get("projectId")).toBe(PROJECT_ID);
    await user.click(screen.getByRole("button", { name: "New conversation" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        ws: "dev",
        project: PROJECT_ID,
        drawer: `talk:${THREAD}`,
      }),
    );
    expect(await screen.findByText(/Ask something/)).toBeTruthy();
    const creates = calls.filter((c) => c.method === "POST" && c.path === "/v1/conversations");
    expect(creates.map((c) => c.body)).toEqual([{ projectId: PROJECT_ID }]);
  });

  it("in All lists every project's threads read-only: New conversation needs a project", async () => {
    const calls = mockFetch({
      ...base,
      "GET /v1/conversations": () => json({ items: [detail().thread], nextCursor: null }),
    });
    renderApp("/?drawer=talk");
    expect(await screen.findByRole("button", { name: /How is my run\?/ })).toBeTruthy();
    expect(calls.find((c) => c.path === "/v1/conversations")!.query.has("projectId")).toBe(false);
    const create = screen.getByRole("button", { name: "New conversation" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect(describedBy(create)).toBe(PICK_PROJECT);
  });

  it("shows turns with their basis and sources; a run source opens the run drawer", async () => {
    mockFetch({ ...base, [`GET /v1/conversations/${THREAD}`]: () => json(detail()) });
    const { router } = renderApp(`/?drawer=talk:${THREAD}`);
    const log = await screen.findByRole("log", { name: "Conversation" });
    expect(within(log).getByText("pending")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(log).getByRole("button", { name: "job · run 22222222 · Running" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ drawer: `run:${JOB}` }));
  });

  it("confirms a proposal with the hash it shows, then links the queued run", async () => {
    let current = proposal();
    const calls = mockFetch({
      ...base,
      [`GET /v1/conversations/${THREAD}`]: () => json(detail(current)),
      [`POST /v1/conversations/proposals/${PROPOSAL}/decision`]: () => {
        current = proposal({ status: "EXECUTED", decidedAt: T0, result: { jobId: JOB } });
        return json(current);
      },
    });
    renderApp(`/?drawer=talk:${THREAD}`);
    const card = await screen.findByRole("region", { name: /^Proposal: Start a coding run/ });
    expect(within(card).getByText("7f3a91c2…4c91")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("button", { name: "Open the queued run" })).toBeTruthy();
    const decision = calls.find((c) => c.path === `/v1/conversations/proposals/${PROPOSAL}/decision`);
    expect(decision?.body).toEqual({ decision: "approve", actionHash: HASH });
  });

  it("sends with an Idempotency-Key, reuses it when resending after a network failure, and explains setup", async () => {
    let fail: "network" | "setup" | null = "network";
    const calls = mockFetch({
      ...base,
      [`GET /v1/conversations/${THREAD}`]: () => json(detail()),
      [`POST /v1/conversations/${THREAD}/turns`]: () => {
        if (fail === "network") throw new TypeError("Failed to fetch");
        if (fail === "setup")
          return json(
            {
              error: {
                code: "CONFLICT",
                message: "Talk needs an AI provider. On the home machine create ~/.nexus/ai.json.",
                details: { reason: "ai_provider_not_configured", runbook: "docs/runbooks/ai-provider.md" },
              },
              requestId: "req-x",
            },
            409,
          );
        return json({ userTurn: turn({}), assistantTurn: detail().turns[1], proposal: null });
      },
    });
    renderApp(`/?drawer=talk:${THREAD}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Message"), "List my runs");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/wasn't sent: NEXUS can't be reached/);

    fail = "setup";
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Talk isn't set up yet")).toBeTruthy();

    fail = null;
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect((screen.getByLabelText("Message") as HTMLInputElement).value).toBe(""));
    const posts = calls.filter((c) => c.method === "POST" && c.path.endsWith("/turns"));
    expect(posts).toHaveLength(3);
    expect(posts.map((p) => p.body)).toEqual(Array(3).fill({ text: "List my runs" }));
    const keys = new Set(posts.map((p) => p.headers.get("idempotency-key")));
    expect(keys.size).toBe(1);
  });
});

describe("command bar Ask", () => {
  it("opens a thread in the current project with the typed text as its first turn; a retry reuses both", async () => {
    let down = true;
    const calls = mockFetch({
      ...base,
      "POST /v1/conversations": () => json(detail().thread, 201),
      [`POST /v1/conversations/${THREAD}/turns`]: () => {
        if (down) throw new TypeError("Failed to fetch");
        return json({ userTurn: turn({}), assistantTurn: detail().turns[1], proposal: null });
      },
      [`GET /v1/conversations/${THREAD}`]: () => json(detail()),
    });
    const { router } = renderApp(IN_PROJECT);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Ask", pressed: false }));
    await user.type(screen.getByRole("textbox", { name: "Command" }), "How is my run?{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Can't reach the NEXUS API.*answered once/,
    );

    down = false;
    await user.type(screen.getByRole("textbox", { name: "Command" }), "{Enter}");
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        ws: "dev",
        project: PROJECT_ID,
        drawer: `talk:${THREAD}`,
      }),
    );
    expect(await screen.findByRole("log", { name: "Conversation" })).toBeTruthy();
    // The drawer is modal, so the board behind it is hidden from the accessibility tree.
    const command = screen.getByRole("textbox", { name: "Command", hidden: true }) as HTMLInputElement;
    expect(command.value).toBe("");
    const creates = calls.filter((c) => c.method === "POST" && c.path === "/v1/conversations");
    expect(creates.map((c) => c.body)).toEqual([{ projectId: PROJECT_ID }]);
    const posts = calls.filter((c) => c.method === "POST" && c.path.endsWith("/turns"));
    expect(posts.map((c) => c.body)).toEqual([{ text: "How is my run?" }, { text: "How is my run?" }]);
    expect(new Set(posts.map((c) => c.headers.get("idempotency-key"))).size).toBe(1);
  });

  it("says to pick a project first in All and sends nothing", async () => {
    const calls = mockFetch(base);
    renderApp("/");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Ask", pressed: false }));
    await user.type(screen.getByRole("textbox", { name: "Command" }), "what is running?{Enter}");
    expect(await screen.findByText(PICK_PROJECT)).toBeTruthy();
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});
