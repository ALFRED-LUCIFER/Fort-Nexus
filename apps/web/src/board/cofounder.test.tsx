import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionProposal, Thread, ThreadDetail, Turn } from "@nexus/contracts";
import {
  IN_PROJECT,
  ME,
  PROJECT_ID,
  json,
  mockFetch,
  project,
  renderApp,
  runner,
  setViewport,
  workspaces,
} from "../test/helpers.tsx";
import { installVoiceFakes, removeVoiceFakes, voiceStatus } from "../test/voiceFakes.ts";

// The shell docks the panel beside every page; Today is left empty here so these tests don't depend on it.
vi.mock("./home.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./home.tsx")>()),
  TodayView: () => null,
}));

const T0 = "2026-11-04T10:00:00.000Z";
const OLD = "55555555-5555-4555-8555-000000000001";
const LATEST = "55555555-5555-4555-8555-000000000002";
const NEW = "55555555-5555-4555-8555-000000000003";
const JOB = "22222222-2222-4222-8222-222222222222";

const thread = (id: string, updatedAt: string): Thread => ({
  id,
  projectId: PROJECT_ID,
  title: "Today",
  subjectJobId: null,
  profileVersionId: null,
  createdAt: T0,
  updatedAt,
});
const turn = (over: Partial<Turn>): Turn => ({
  id: "77777777-7777-4777-8777-000000000001",
  threadId: LATEST,
  role: "USER",
  text: "What's waiting on me?",
  intent: null,
  basis: "NONE",
  sources: [],
  proposalId: null,
  correlationId: "req-1",
  createdAt: T0,
  ...over,
});
const reply = turn({
  id: "77777777-7777-4777-8777-000000000002",
  role: "ASSISTANT",
  text: "Run 22222222 is waiting for your approval.",
  basis: "OBSERVED",
  sources: [{ kind: "JOB", id: JOB, label: "run 22222222 · Awaiting approval", asOf: T0 }],
});
const proposal: ActionProposal = {
  id: "66666666-6666-4666-8666-666666666666",
  threadId: LATEST,
  turnId: reply.id,
  riskTier: "R1",
  action: {
    type: "jobs.create",
    request: {
      jobType: "DEV_ISSUE_TO_PR",
      projectId: PROJECT_ID,
      repositoryId: "101",
      issueNumber: 42,
      budget: { maxWallClockMinutes: 45, maxTurns: 60, maxCostUsd: 5 },
    },
    preview: "Start a coding run for acme/web issue #42.",
  },
  actionHash: "a".repeat(64),
  status: "AWAITING_APPROVAL",
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  decidedAt: null,
  result: null,
  error: null,
  createdAt: T0,
};
const detail = (over: Partial<ThreadDetail> = {}): ThreadDetail => ({
  thread: thread(LATEST, T0),
  turns: [turn({}), { ...reply, proposalId: proposal.id }],
  proposals: [proposal],
  ...over,
});
const answer = (threadId: string) =>
  json({
    userTurn: turn({ threadId, text: "Summarize today's runs" }),
    assistantTurn: { ...reply, threadId, text: "3 runs today, all passed." },
    proposal: null,
  });

const base = {
  "GET /v1/me": () => json(ME),
  "GET /v1/runners": () => json({ items: [runner()] }),
  "GET /v1/voice/status": () => json(voiceStatus()),
};
const aside = () => screen.getByRole("complementary", { name: "Cofounder" });
/** The panel once it has loaded (the landmark is rebuilt when the project resolves). */
const panel = async () => {
  await waitFor(() => expect(aside().textContent).not.toMatch(/Loading…/));
  return within(aside());
};

beforeEach(() => {
  // Wide enough for the docked panel.
  setViewport(1440);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
});
afterEach(removeVoiceFakes);

describe("Cofounder panel", () => {
  it("in All asks for a project and offers no input", async () => {
    mockFetch(base);
    renderApp("/");
    const p = await panel();
    expect(p.getByText("Pick a project to talk with your cofounder.")).toBeTruthy();
    expect(p.queryByRole("textbox")).toBeNull();
  });

  it("shows the project's latest thread with sources and proposals; chips fill the input and send nothing", async () => {
    const calls = mockFetch({
      ...base,
      "GET /v1/conversations": () =>
        json({ items: [thread(OLD, "2026-11-03T10:00:00.000Z"), thread(LATEST, T0)], nextCursor: null }),
      [`GET /v1/conversations/${LATEST}`]: () => json(detail()),
    });
    const { router } = renderApp(IN_PROJECT);
    const p = await panel();
    const log = await p.findByRole("log", { name: "Conversation" });
    expect(within(log).getByText("Run 22222222 is waiting for your approval.")).toBeTruthy();
    expect(within(log).getByText(/^Cofounder · /)).toBeTruthy();
    expect(within(log).getByRole("region", { name: /^Proposal: Start a coding run/ })).toBeTruthy();
    expect(calls.find((c) => c.path === "/v1/conversations")!.query.get("projectId")).toBe(PROJECT_ID);
    expect(
      p.getByText(
        "answers from Home sources only · runs execute on your home machine · pushes and merges need on-screen approval",
      ),
    ).toBeTruthy();

    const user = userEvent.setup();
    await user.click(p.getByRole("button", { name: "Summarize today's runs" }));
    expect((p.getByRole("textbox", { name: "Message your cofounder" }) as HTMLInputElement).value).toBe(
      "Summarize today's runs",
    );
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    await user.click(within(log).getByRole("button", { name: "job · run 22222222 · Awaiting approval" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ drawer: `run:${JOB}` }));
  });

  it("the first send starts a thread in the project, with an Idempotency-Key", async () => {
    let created = false;
    const calls = mockFetch({
      ...base,
      "GET /v1/conversations": () => json({ items: created ? [thread(NEW, T0)] : [], nextCursor: null }),
      "POST /v1/conversations": () => {
        created = true;
        return json(thread(NEW, T0), 201);
      },
      [`POST /v1/conversations/${NEW}/turns`]: () => answer(NEW),
      [`GET /v1/conversations/${NEW}`]: () =>
        json(
          detail({
            thread: thread(NEW, T0),
            turns: [turn({ threadId: NEW }), { ...reply, threadId: NEW, text: "3 runs today, all passed." }],
            proposals: [],
          }),
        ),
    });
    renderApp(IN_PROJECT);
    const p = await panel();
    expect(await p.findByText(/^Ask about Home:/)).toBeTruthy();
    const user = userEvent.setup();
    await user.type(
      p.getByRole("textbox", { name: "Message your cofounder" }),
      "Summarize today's runs{Enter}",
    );
    expect(await p.findByText("3 runs today, all passed.")).toBeTruthy();
    expect(
      calls.filter((c) => c.method === "POST" && c.path === "/v1/conversations").map((c) => c.body),
    ).toEqual([{ projectId: PROJECT_ID }]);
    const post = calls.find((c) => c.path === `/v1/conversations/${NEW}/turns`)!;
    expect(post.body).toEqual({ text: "Summarize today's runs" });
    expect(post.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("says honestly when Talk has no AI provider", async () => {
    mockFetch({
      ...base,
      "GET /v1/conversations": () => json({ items: [thread(LATEST, T0)], nextCursor: null }),
      [`GET /v1/conversations/${LATEST}`]: () => json(detail()),
      [`POST /v1/conversations/${LATEST}/turns`]: () =>
        json(
          {
            error: {
              code: "CONFLICT",
              message: "Talk needs an AI provider. On the home machine create ~/.nexus/ai.json.",
              details: { reason: "ai_provider_not_configured" },
            },
            requestId: "req-x",
          },
          409,
        ),
    });
    renderApp(IN_PROJECT);
    const p = await panel();
    const user = userEvent.setup();
    await user.type(await p.findByRole("textbox", { name: "Message your cofounder" }), "What failed?{Enter}");
    const alert = await p.findByRole("alert");
    expect(alert.textContent).toBe(
      "Talk isn't set up yetTalk needs an AI provider. On the home machine create ~/.nexus/ai.json.",
    );
  });

  it("conversation mode: listen, review the words, send, hear the reply, then the mic is offered again", async () => {
    const v = installVoiceFakes();
    const calls = mockFetch({
      ...base,
      "GET /v1/conversations": () => json({ items: [thread(LATEST, T0)], nextCursor: null }),
      [`GET /v1/conversations/${LATEST}`]: () => json(detail()),
      [`POST /v1/conversations/${LATEST}/turns`]: () => answer(LATEST),
      "POST /v1/voice/transcribe": () =>
        json({ text: "Summarize today's runs", durationMs: 900, provider: "AZURE_OPENAI", deployment: "d" }),
      "POST /v1/voice/speak": () =>
        new Response(new Blob(["mp3"]), { status: 200, headers: { "content-type": "audio/mpeg" } }),
    });
    renderApp(IN_PROJECT);
    const p = await panel();
    const user = userEvent.setup();
    const mode = await p.findByRole("button", { name: "Talk with your cofounder", pressed: false });
    await user.click(mode);
    expect(mode.getAttribute("aria-pressed")).toBe("true");
    const mic = await p.findByRole("button", { name: "Recording: press to stop" });
    expect(p.getByText(/^listening · mic on this /)).toBeTruthy();
    await user.click(mic);
    const input = p.getByRole("textbox", { name: "Message your cofounder" }) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Summarize today's runs"));
    // Never sent by itself.
    expect(calls.filter((c) => c.path.endsWith("/turns"))).toHaveLength(0);

    await user.click(p.getByRole("button", { name: "Send" }));
    const hud = p.getByRole("region", { name: "Voice" });
    await waitFor(() => expect(within(hud).getByText("3 runs today, all passed.")).toBeTruthy());
    expect(calls.find((c) => c.path === "/v1/voice/speak")?.body).toEqual({
      projectId: PROJECT_ID,
      text: "3 runs today, all passed.",
    });
    v.audios[0]!.end();
    await waitFor(() => expect(within(hud).getByRole("status").textContent).toBe("Your turn"));
    expect(document.activeElement).toBe(p.getByRole("button", { name: /^Talk: press to record/ }));
    expect(v.getUserMedia).toHaveBeenCalledTimes(1);

    await user.click(within(hud).getByRole("button", { name: "End" }));
    expect(p.queryByRole("region", { name: "Voice" })).toBeNull();
    expect(p.getByRole("button", { name: "Talk with your cofounder" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(v.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("one microphone at a time: the panel's mic ends the command bar's recording, which is never sent", async () => {
    const v = installVoiceFakes();
    const calls = mockFetch({
      ...base,
      "GET /v1/conversations": () => json({ items: [thread(LATEST, T0)], nextCursor: null }),
      [`GET /v1/conversations/${LATEST}`]: () => json(detail()),
      "POST /v1/voice/transcribe": () =>
        json({ text: "What failed?", durationMs: 900, provider: "AZURE_OPENAI", deployment: "d" }),
    });
    renderApp(IN_PROJECT);
    const p = await panel();
    const user = userEvent.setup();
    const bar = screen.getByRole("banner");
    await user.click(await within(bar).findByRole("button", { name: /^Talk: press to record/ }));
    await within(bar).findByRole("button", { name: "Recording: press to stop" });

    await user.click(p.getByRole("button", { name: /^Talk: press to record/ }));
    await p.findByRole("button", { name: "Recording: press to stop" });
    expect(v.tracks[0]!.stopped).toBe(true);
    expect(v.tracks[1]!.stopped).toBe(false);
    expect(within(bar).getByRole("button", { name: /^Talk: press to record/ })).toBeTruthy();

    await user.click(p.getByRole("button", { name: "Recording: press to stop" }));
    const input = p.getByRole("textbox", { name: "Message your cofounder" }) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("What failed?"));
    // Only the panel's recording was transcribed; the ended one was dropped.
    expect(calls.filter((c) => c.path === "/v1/voice/transcribe")).toHaveLength(1);
    expect((screen.getByRole("textbox", { name: "Command" }) as HTMLInputElement).value).toBe("");
  });

  it("an archived project's conversation is read-only", async () => {
    mockFetch({
      ...base,
      "GET /v1/workspaces": () => json(workspaces([project({ archivedAt: T0 })])),
      "GET /v1/conversations": () => json({ items: [thread(LATEST, T0)], nextCursor: null }),
      [`GET /v1/conversations/${LATEST}`]: () => json(detail()),
    });
    renderApp(IN_PROJECT);
    const p = await panel();
    expect(await p.findByText(/^Home is archived: its conversations are read-only/)).toBeTruthy();
    expect(await p.findByRole("log", { name: "Conversation" })).toBeTruthy();
    expect(p.queryByRole("textbox")).toBeNull();
    expect(p.queryByRole("button", { name: "Talk with your cofounder" })).toBeNull();
  });
});
