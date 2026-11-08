import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Notification, Thread, ThreadDetail, Turn, VoiceStatus } from "@nexus/contracts";
import {
  FakeEventSource,
  IN_PROJECT,
  JOB_ID,
  ME,
  PROJECT_ID,
  json,
  mockFetch,
  renderApp,
  runner,
  setViewport,
  type Call,
} from "../test/helpers.tsx";
import { FakeAudio, installVoiceFakes, removeVoiceFakes, voiceStatus } from "../test/voiceFakes.ts";

// The docked panel sits beside every page; Today is left empty so these tests don't depend on it.
vi.mock("./home.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./home.tsx")>()),
  TodayView: () => null,
}));

const T0 = "2026-11-08T10:00:00.000Z";
const PREF = "nexus.updates.voice";
let seq = 0;
const note = (over: Partial<Notification> = {}): Notification => ({
  id: `44444444-4444-4444-8444-${String(++seq).padStart(12, "0")}`,
  projectId: PROJECT_ID,
  category: "TASK_FAILED",
  title: "Run failed · acme/web#42",
  body: "The command ran past its time limit. Start it again.",
  subject: { jobId: JOB_ID, approvalId: null },
  status: "UNREAD",
  createdAt: T0,
  ...over,
});
const audio = () =>
  new Response(new Blob(["mp3"]), { status: 200, headers: { "content-type": "audio/mpeg" } });

const THREAD = "55555555-5555-4555-8555-000000000002";
const thread: Thread = {
  id: THREAD,
  projectId: PROJECT_ID,
  title: "Today",
  subjectJobId: null,
  profileVersionId: null,
  createdAt: T0,
  updatedAt: T0,
};
const reply: Turn = {
  id: "77777777-7777-4777-8777-000000000002",
  threadId: THREAD,
  role: "ASSISTANT",
  text: "Nothing is waiting on you.",
  intent: null,
  basis: "OBSERVED",
  sources: [],
  proposalId: null,
  correlationId: "req-1",
  createdAt: "2026-11-08T09:00:00.000Z",
};
const detail: ThreadDetail = { thread, turns: [reply], proposals: [] };

function board(
  notifications: () => Notification[],
  status: VoiceStatus = voiceStatus({ speak: null }),
  extra: Parameters<typeof mockFetch>[0] = {},
) {
  return mockFetch({
    "GET /v1/me": () => json(ME),
    "GET /v1/runners": () => json({ items: [runner()] }),
    "GET /v1/jobs": () => json({ items: [], nextCursor: null }),
    "GET /v1/approvals": () => json({ items: [] }),
    "GET /v1/voice/status": () => json(status),
    "GET /v1/conversations": () => json({ items: [thread], nextCursor: null }),
    [`GET /v1/conversations/${THREAD}`]: () => json(detail),
    "POST /v1/voice/speak": audio,
    "POST /v1/voice/transcribe": () =>
      json({ text: "What failed?", durationMs: 900, provider: "AZURE_OPENAI", deployment: "d" }),
    "GET /v1/notifications": () => {
      const items = notifications();
      return json({ items, unreadCount: items.filter((n) => n.status === "UNREAD").length });
    },
    ...extra,
  });
}

const poll = () => act(() => vi.advanceTimersByTimeAsync(5_000));
const aside = () => screen.getByRole("complementary", { name: "Cofounder" });
/** The panel once it has loaded (the landmark is rebuilt when the project resolves). */
const panel = async () => {
  await waitFor(() => expect(aside().textContent).not.toMatch(/Loading…/));
  return within(aside());
};
const whisper = () => screen.findByRole("region", { name: "NEXUS noticed" });
const speaks = (calls: Call[]) => calls.filter((c) => c.path === "/v1/voice/speak");
const marks = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/notifications/"));
const setup = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

beforeEach(() => {
  setViewport(1440);
  localStorage.clear();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  removeVoiceFakes();
});

describe("Cofounder whisper", () => {
  it("whispers only what arrives after load, instead of a toast; Open marks it read and opens its run", async () => {
    installVoiceFakes();
    const backlog = note({ title: "Old news" });
    let items = [backlog];
    const calls = board(() => items);
    const user = setup();
    const { router } = renderApp(IN_PROJECT);
    await panel();
    await screen.findByRole("button", { name: /^Inbox, 0 pending approvals, 1 unread/ });
    await poll();
    expect(screen.queryByRole("region", { name: "NEXUS noticed" })).toBeNull();

    const failed = note();
    items = [failed, backlog];
    await poll();
    const w = within(await whisper());
    expect(w.getByText("NEXUS · noticed just now")).toBeTruthy();
    expect(w.getByText(failed.title)).toBeTruthy();
    expect(w.getByText(failed.body)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "New notifications" })).toBeNull();
    expect(screen.getByText(`New notification: ${failed.title}`).getAttribute("aria-live")).toBe("polite");

    await poll(); // polled again: still one, and nothing said (reading aloud is off by default)
    expect(w.getAllByRole("button", { name: "Tell me" })).toHaveLength(1);
    await user.click(w.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(marks(calls)).toHaveLength(1));
    expect(marks(calls)[0]).toMatchObject({
      path: `/v1/notifications/${failed.id}/status`,
      body: { status: "READ" },
    });
    expect(router.state.location.search).toMatchObject({ project: PROJECT_ID, drawer: `run:${JOB_ID}` });
    expect(screen.queryByRole("region", { name: "NEXUS noticed" })).toBeNull();
    expect(speaks(calls)).toHaveLength(0);
  });

  it("Tell me reads it with the browser voice and Stop silences it; Later puts it off without marking it", async () => {
    const v = installVoiceFakes();
    let items: Notification[] = [];
    const calls = board(() => items);
    const user = setup();
    renderApp(IN_PROJECT);
    await panel();
    await poll();
    items = [note()];
    await poll();
    const region = await whisper();
    expect(v.synth.speak).not.toHaveBeenCalled();

    await user.click(within(region).getByRole("button", { name: "Tell me" }));
    expect(v.spoken.map((u) => [u.text, u.rate, u.lang])).toEqual([
      ["Run failed, acme/web#42. The command ran past its time limit.", 1.25, "en-US"],
    ]);
    expect(within(region).getByRole("status").textContent).toBe("Speaking… · browser voice");
    expect(speaks(calls)).toHaveLength(0);
    await user.click(within(region).getByRole("button", { name: "Stop" }));
    expect(v.synth.cancel).toHaveBeenCalled();
    expect(within(region).queryByRole("status")).toBeNull();

    await user.click(within(region).getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("region", { name: "NEXUS noticed" })).toBeNull();
    await poll();
    expect(screen.queryByRole("region", { name: "NEXUS noticed" })).toBeNull();
    expect(marks(calls)).toEqual([]);
    expect(screen.getByRole("button", { name: /^Inbox, 0 pending approvals, 1 unread/ })).toBeTruthy();
  });

  it("several arriving together collapse into one; Tell me says them all, Open goes to the Inbox", async () => {
    const v = installVoiceFakes();
    let items: Notification[] = [];
    board(() => items);
    const user = setup();
    const { router } = renderApp(IN_PROJECT);
    await panel();
    await poll();
    const a = note({ category: "APPROVAL_REQUIRED", title: "Ready for review · acme/web#42" });
    const b = note({ category: "TASK_DONE", title: "Draft PR #7 opened · acme/web#41" });
    items = [a, b];
    await poll();
    const region = await whisper();
    expect(within(region).getByText(/updates:/).parentElement!.textContent).toBe(
      `2 updates: ${a.title} · ${b.title}`,
    );
    const c = note({ title: "Run failed · acme/web#40" });
    items = [c, a, b];
    await poll();
    expect(within(region).getByText(/updates:/).parentElement!.textContent).toBe(
      `3 updates: ${c.title} · ${a.title} · ${b.title}`,
    );

    await user.click(within(region).getByRole("button", { name: "Tell me" }));
    expect(v.spoken[0]!.text).toBe(
      "3 updates. Run failed, acme/web#40. Ready for review, acme/web#42. Draft PR #7 opened, acme/web#41.",
    );
    await user.click(within(region).getByRole("button", { name: "Open Inbox" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ drawer: "inbox" }));
  });
});

describe("reading new updates aloud", () => {
  it("“Only things that need me” says failures, not finished runs; “Everything” says both, in the Azure voice", async () => {
    const v = installVoiceFakes();
    localStorage.setItem(PREF, "needs-me");
    let items: Notification[] = [];
    const calls = board(() => items, voiceStatus());
    renderApp(IN_PROJECT);
    await panel();
    await poll();

    items = [
      note({ category: "TASK_DONE", title: "Draft PR #7 opened · acme/web#42", body: "Tests passed." }),
    ];
    await poll();
    await whisper();
    expect(speaks(calls)).toHaveLength(0);

    const failed = note();
    items = [failed, ...items];
    await poll();
    await waitFor(() => expect(speaks(calls)).toHaveLength(1));
    expect(speaks(calls)[0]!.body).toEqual({
      projectId: PROJECT_ID,
      text: "Run failed, acme/web#42. The command ran past its time limit.",
    });
    const region = await whisper();
    await waitFor(() =>
      expect(within(region).getByRole("status").textContent).toBe(
        "Speaking… · Azure AI Speech · en-US-AvaMultilingualNeural",
      ),
    );
    expect(v.audios.at(-1)!.src).toBe("blob:reply");
    v.audios.at(-1)!.end();
    await waitFor(() => expect(within(region).queryByRole("status")).toBeNull());
    cleanup();

    localStorage.setItem(PREF, "all");
    items = [];
    renderApp(IN_PROJECT);
    await panel();
    await poll();
    items = [
      note({ category: "TASK_DONE", title: "Draft PR #8 opened · acme/web#43", body: "Tests passed." }),
    ];
    await poll();
    await waitFor(() => expect(speaks(calls)).toHaveLength(2));
    expect(speaks(calls)[1]!.body).toMatchObject({ text: "Draft PR #8 opened, acme/web#43. Tests passed." });
  });

  it("waits while the owner records and while a reply is read, and drops what is stale by then", async () => {
    const v = installVoiceFakes();
    localStorage.setItem(PREF, "all");
    let items: Notification[] = [];
    board(() => items);
    const user = setup();
    renderApp(IN_PROJECT);
    const p = await panel();
    await poll();

    // Recording in the command bar: the update waits for the mic to close.
    const bar = within(screen.getByRole("banner"));
    await user.click(await bar.findByRole("button", { name: /^Talk: press to record/ }));
    await bar.findByRole("button", { name: "Recording: press to stop" });
    items = [note({ title: "Run failed · acme/web#1" })];
    await poll();
    await whisper();
    expect(v.spoken).toHaveLength(0);
    await user.click(bar.getByRole("button", { name: "Recording: press to stop" }));
    await waitFor(() =>
      expect(v.spoken.map((u) => u.text)).toEqual([
        "Run failed, acme/web#1. The command ran past its time limit.",
      ]),
    );
    v.spoken[0]!.onend?.();

    // A reply being read: the update is said after it.
    await user.click(p.getByRole("button", { name: "read aloud" }));
    expect(v.spoken[1]!.text).toBe("Nothing is waiting on you.");
    items = [note({ title: "Run failed · acme/web#2" }), ...items];
    await poll();
    expect(v.spoken).toHaveLength(2);
    v.spoken[1]!.onend?.();
    await waitFor(() => expect(v.spoken).toHaveLength(3));
    expect(v.spoken[2]!.text).toMatch(/^Run failed, acme\/web#2\./);
    v.spoken[2]!.onend?.();

    // Held back for more than two minutes: old news, not said.
    await user.click(p.getByRole("button", { name: "read aloud" }));
    expect(v.spoken).toHaveLength(4);
    items = [note({ title: "Run failed · acme/web#3" }), ...items];
    await poll();
    await act(() => vi.advanceTimersByTimeAsync(125_000));
    v.spoken[3]!.onend?.();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(v.spoken).toHaveLength(4);
    expect(within(await whisper()).getByText(/updates:/).parentElement!.textContent).toMatch(/acme\/web#3/);
  });

  it("when the browser blocks playback until a tap, asks “Tap to hear updates” and plays on that tap", async () => {
    const v = installVoiceFakes();
    FakeAudio.autoplayBlocked = true;
    localStorage.setItem(PREF, "all");
    let items: Notification[] = [];
    const calls = board(() => items, voiceStatus());
    const user = setup();
    renderApp(IN_PROJECT);
    await panel();
    await poll();
    items = [note()];
    await poll();
    const region = await whisper();
    const tap = await within(region).findByRole("button", { name: "Tap to hear updates" });
    expect(within(region).queryByRole("status")).toBeNull();
    await poll(); // asked once, not retried behind the owner's back
    expect(speaks(calls)).toHaveLength(1);

    FakeAudio.autoplayBlocked = false; // the tap is the gesture the browser waited for
    await user.click(tap);
    await waitFor(() => expect(speaks(calls)).toHaveLength(2));
    await waitFor(() => expect(v.audios.some((a) => a.src === "blob:reply" && !a.paused)).toBe(true));
    expect(within(region).queryByRole("button", { name: "Tap to hear updates" })).toBeNull();
    expect(within(region).getByRole("status").textContent).toMatch(/^Speaking… · Azure AI Speech/);
  });
});

describe("Settings → Voice & consent: updates", () => {
  it("says what works now; the choice is kept on this device, and holds when storage is blocked", async () => {
    installVoiceFakes();
    board(() => [], voiceStatus({ configured: false, transcribe: null, speak: null, disclosure: [] }));
    const user = setup();
    renderApp(`/?drawer=settings#voice`);
    let dialog = within(await screen.findByRole("dialog"));
    const works = within(await dialog.findByRole("region", { name: "What works now" }));
    expect(works.getByText(/Voice input needs/).textContent).toBe(
      "Voice input needs ~/.nexus/voice.json on the home machine with a transcribe part. How to set it up: docs/runbooks/voice.md.",
    );
    expect(
      works.getByText(/^Spoken replies and updates work now with this browser's own voice\./),
    ).toBeTruthy();
    const group = within(dialog.getByRole("group", { name: "Read new updates aloud · this device" }));
    expect((group.getByRole("radio", { name: "Off" }) as HTMLInputElement).checked).toBe(true);
    expect(dialog.getByText(/^Read with this browser's voice \(browser voice\)\./)).toBeTruthy();

    await user.click(group.getByRole("radio", { name: "Only things that need me" }));
    expect(localStorage.getItem(PREF)).toBe("needs-me");
    cleanup();
    renderApp(`/?drawer=settings#voice`);
    dialog = within(await screen.findByRole("dialog"));
    let radios = within(await dialog.findByRole("group", { name: "Read new updates aloud · this device" }));
    expect(
      (radios.getByRole("radio", { name: "Only things that need me" }) as HTMLInputElement).checked,
    ).toBe(true);
    cleanup();

    // Private mode or a policy: storage throws. The page still works and the choice holds until reload.
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    renderApp(`/?drawer=settings#voice`);
    dialog = within(await screen.findByRole("dialog"));
    radios = within(await dialog.findByRole("group", { name: "Read new updates aloud · this device" }));
    expect((radios.getByRole("radio", { name: "Off" }) as HTMLInputElement).checked).toBe(true);
    await user.click(radios.getByRole("radio", { name: "Everything" }));
    expect((radios.getByRole("radio", { name: "Everything" }) as HTMLInputElement).checked).toBe(true);

    getItem.mockRestore();
    setItem.mockRestore();
    await user.click(radios.getByRole("radio", { name: "Off" }));
    expect(localStorage.getItem(PREF)).toBe("off");
    expect((radios.getByRole("radio", { name: "Off" }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("Talk with your cofounder", () => {
  it("says a new update in the conversation as an observed line, pausing the mic, then listens again", async () => {
    const v = installVoiceFakes();
    localStorage.setItem(PREF, "all"); // the conversation says it; the update voice doesn't say it twice
    let items: Notification[] = [];
    const calls = board(() => items, voiceStatus());
    const user = setup();
    renderApp(IN_PROJECT);
    const p = await panel();
    await p.findByRole("log", { name: "Conversation" });
    await poll();
    await user.click(p.getByRole("button", { name: "Talk with your cofounder", pressed: false }));
    await p.findByRole("button", { name: "Recording: press to stop" });

    const failed = note();
    items = [failed];
    await poll();
    const log = p.getByRole("log", { name: "Conversation" });
    const line = within(log)
      .getByText(/^NEXUS · noticed /)
      .closest("li")!;
    expect(within(line).getByText("observed")).toBeTruthy();
    expect(within(line).getByText(failed.title)).toBeTruthy();
    expect(within(line).getByRole("button", { name: `notification · ${failed.title}` })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "NEXUS noticed" })).toBeNull();
    expect(screen.queryByRole("region", { name: "New notifications" })).toBeNull();

    // Nothing is recorded while it is said.
    await waitFor(() => expect(speaks(calls)).toHaveLength(1));
    expect(speaks(calls)[0]!.body).toEqual({
      projectId: PROJECT_ID,
      text: "Run failed, acme/web#42. The command ran past its time limit.",
    });
    expect(v.recorders[0]!.state).toBe("paused");
    const hud = p.getByRole("region", { name: "Voice" });
    await waitFor(() =>
      expect(within(hud).getByRole("status").textContent).toBe(
        "Speaking · Azure AI Speech · en-US-AvaMultilingualNeural",
      ),
    );
    expect(within(hud).getByText("mic paused")).toBeTruthy();

    v.audios.at(-1)!.end();
    await waitFor(() => expect(within(hud).getByRole("status").textContent).toBe("Listening"));
    expect(v.recorders[0]!.state).toBe("recording");
    expect(p.getByRole("button", { name: "Recording: press to stop" })).toBeTruthy();
    expect(v.getUserMedia).toHaveBeenCalledTimes(1);
    expect(speaks(calls)).toHaveLength(1);

    // The clip keeps what was said before and after the update.
    await user.click(p.getByRole("button", { name: "Recording: press to stop" }));
    await waitFor(() =>
      expect((p.getByRole("textbox", { name: "Message your cofounder" }) as HTMLInputElement).value).toBe(
        "What failed?",
      ),
    );
  });
});
