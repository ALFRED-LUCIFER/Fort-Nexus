import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ThreadDetail, Turn } from "@nexus/contracts";
import {
  IN_PROJECT,
  ME,
  PROJECT_ID,
  apiError,
  json,
  mockFetch,
  renderApp,
  runner,
} from "../test/helpers.tsx";
import { installVoiceFakes, removeVoiceFakes, voiceStatus } from "../test/voiceFakes.ts";

const T0 = "2026-11-04T10:00:00.000Z";
const THREAD = "55555555-5555-4555-8555-555555555555";
const REPLY = "77777777-7777-4777-8777-000000000002";

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
const reply = turn({ id: REPLY, role: "ASSISTANT", text: "Run 22222222 is running.", basis: "PENDING" });
const detail: ThreadDetail = {
  thread: {
    id: THREAD,
    projectId: PROJECT_ID,
    title: "How is my run?",
    subjectJobId: null,
    profileVersionId: null,
    createdAt: T0,
    updatedAt: T0,
  },
  turns: [turn({}), reply],
  proposals: [],
};
const transcript = (text: string) =>
  json({ text, durationMs: 1200, provider: "AZURE_OPENAI", deployment: "gpt-4o-mini-transcribe" });
const audio = () =>
  new Response(new Blob(["mp3"]), { status: 200, headers: { "content-type": "audio/mpeg" } });

const base = { "GET /v1/me": () => json(ME), "GET /v1/runners": () => json({ items: [runner()] }) };
const describedBy = (el: HTMLElement) =>
  document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent;
const command = () => screen.getByRole("textbox", { name: "Command" }) as HTMLInputElement;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
});
afterEach(removeVoiceFakes);

describe("push-to-talk in the command bar", () => {
  it("opens the mic only on a press, stops on the second, and puts the words in the command unsent", async () => {
    const v = installVoiceFakes();
    const calls = mockFetch({
      ...base,
      "GET /v1/voice/status": () => json(voiceStatus()),
      "POST /v1/voice/transcribe": () => transcript("fix issue forty four"),
    });
    renderApp(IN_PROJECT);
    const user = userEvent.setup();
    const mic = await screen.findByRole("button", { name: /^Talk: press to record/ });
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    expect(describedBy(mic)).toMatch(/^Your recording is sent to Azure OpenAI/);
    expect(v.getUserMedia).not.toHaveBeenCalled();

    await user.click(mic);
    const recording = await screen.findByRole("button", { name: "Recording: press to stop" });
    expect(recording.getAttribute("aria-pressed")).toBe("true");
    expect(v.getUserMedia).toHaveBeenCalledWith({ audio: true });
    const hud = screen.getByRole("region", { name: "Voice" });
    expect(within(hud).getByRole("status").textContent).toBe("Listening");
    expect(within(hud).getByText(/^mic on · this /)).toBeTruthy();
    expect(within(hud).getByText(/Nothing is recorded until you press the mic\./)).toBeTruthy();

    await user.click(recording);
    await waitFor(() => expect(command().value).toBe("fix issue forty four"));
    expect(v.tracks[0]!.stopped).toBe(true);
    expect(v.contexts[0]!.closed).toBe(true);
    const sent = calls.find((c) => c.path === "/v1/voice/transcribe")!;
    expect(sent.query.get("projectId")).toBe(PROJECT_ID);
    expect(sent.headers.get("content-type")).toBe("audio/webm;codecs=opus");
    expect(Number(sent.headers.get("x-audio-duration-ms"))).toBeGreaterThanOrEqual(0);
    expect(sent.body).toBeInstanceOf(Blob);
    // A transcript is never a command: nothing was asked, drafted or planned.
    expect(calls.filter((c) => c.method === "POST" && c.path !== "/v1/voice/transcribe")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Voice" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Talk: press to record/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("hold-to-talk: releasing a long press stops and transcribes", async () => {
    installVoiceFakes();
    const calls = mockFetch({
      ...base,
      "GET /v1/voice/status": () => json(voiceStatus()),
      "POST /v1/voice/transcribe": () => transcript("what failed"),
    });
    renderApp(IN_PROJECT);
    const user = userEvent.setup();
    const mic = await screen.findByRole("button", { name: /^Talk: press to record/ });
    await user.pointer({ keys: "[MouseLeft>]", target: mic });
    await screen.findByRole("button", { name: "Recording: press to stop" });
    await new Promise((r) => setTimeout(r, 400));
    await user.pointer({ keys: "[/MouseLeft]", target: mic });
    await waitFor(() => expect(command().value).toBe("what failed"));
    expect(calls.filter((c) => c.path === "/v1/voice/transcribe")).toHaveLength(1);
  });

  it("End and unmount release every track and drop the recording", async () => {
    const v = installVoiceFakes();
    const calls = mockFetch({ ...base, "GET /v1/voice/status": () => json(voiceStatus()) });
    renderApp(IN_PROJECT);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Talk: press to record/ }));
    await screen.findByRole("button", { name: "Recording: press to stop" });
    await user.click(
      within(screen.getByRole("region", { name: "Voice" })).getByRole("button", { name: "End" }),
    );
    expect(v.tracks[0]!.stopped).toBe(true);
    expect(screen.queryByRole("region", { name: "Voice" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /^Talk: press to record/ }));
    await screen.findByRole("button", { name: "Recording: press to stop" });
    cleanup();
    expect(v.tracks[1]!.stopped).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.path === "/v1/voice/transcribe")).toHaveLength(0);
  });

  it("permission denied: says how to allow the mic and the command stays usable", async () => {
    const v = installVoiceFakes({ mic: "deny" });
    mockFetch({ ...base, "GET /v1/voice/status": () => json(voiceStatus()) });
    renderApp(IN_PROJECT);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Talk: press to record/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /blocked the microphone\. Allow it for this site.*keep typing/,
    );
    expect(v.recorders).toHaveLength(0);
    await user.type(command(), "list my runs");
    expect(command().value).toBe("list my runs");
    expect(screen.getByRole("button", { name: /^Talk: press to record/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("mic off in settings: the button says so and opens Settings → Voice & consent; nothing records", async () => {
    const v = installVoiceFakes();
    mockFetch({
      ...base,
      "GET /v1/voice/status": () => json(voiceStatus({}, { micEnabled: false })),
      "GET /v1/sessions": () => json({ items: [] }),
    });
    const { router } = renderApp(IN_PROJECT);
    const user = userEvent.setup();
    const mic = await screen.findByRole("button", {
      name: "Voice input is off: open Settings → Voice & consent",
    });
    expect(describedBy(mic)).toBe("The mic is off. Turn it on in Settings → Voice & consent.");
    await user.click(mic);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ drawer: "settings" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Voice & consent", pressed: true })).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: "Microphone" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(v.getUserMedia).not.toHaveBeenCalled();
  });

  it("not set up: names the runbook; in All the mic needs a project", async () => {
    const v = installVoiceFakes();
    mockFetch({
      ...base,
      "GET /v1/voice/status": () =>
        json(voiceStatus({ configured: false, transcribe: null, speak: null, disclosure: [] })),
    });
    renderApp(IN_PROJECT);
    const mic = await screen.findByRole("button", {
      name: "Voice input is off: open Settings → Voice & consent",
    });
    expect(describedBy(mic)).toMatch(
      /isn't set up on the home machine yet \(see docs\/runbooks\/voice\.md\)/,
    );
    cleanup();

    localStorage.clear(); // a fresh browser: nothing remembered, so "/" is the All view
    renderApp("/");
    const user = userEvent.setup();
    const blocked = await screen.findByRole("button", { name: "Voice input" });
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(blocked)).toBe("Voice input records into one project: choose it in Scope first.");
    await user.click(blocked);
    expect(v.getUserMedia).not.toHaveBeenCalled();
  });

  it("provider and network failures are said in words; a 403 links to Settings", async () => {
    installVoiceFakes();
    let fail: "forbidden" | "network" = "forbidden";
    const calls = mockFetch({
      ...base,
      "GET /v1/voice/status": () => json(voiceStatus()),
      "POST /v1/voice/transcribe": () => {
        if (fail === "network") throw new TypeError("Failed to fetch");
        return apiError(403, "FORBIDDEN", "The mic is off in Settings → Voice & consent.");
      },
    });
    renderApp(IN_PROJECT);
    const user = userEvent.setup();
    const record = async () => {
      await user.click(await screen.findByRole("button", { name: /^Talk: press to record/ }));
      await user.click(await screen.findByRole("button", { name: "Recording: press to stop" }));
    };
    await record();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/^The mic is off in Settings → Voice & consent\./);
    expect(within(alert).getByRole("button", { name: "Open Settings → Voice & consent" })).toBeTruthy();
    // The settings it was refused under are re-read.
    await waitFor(() => expect(calls.filter((c) => c.path === "/v1/voice/status").length).toBeGreaterThan(1));

    fail = "network";
    await record();
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Your recording wasn't transcribed: NEXUS can't be reached. Press the mic to try again.",
      ),
    );
    expect(command().value).toBe("");
  });
});

describe("Talk drawer voice", () => {
  const talk = (status = voiceStatus(), speak: () => Response = audio) =>
    mockFetch({
      ...base,
      "GET /v1/voice/status": () => json(status),
      [`GET /v1/conversations/${THREAD}`]: () => json(detail),
      [`POST /v1/conversations/${THREAD}/turns`]: () =>
        json({ userTurn: turn({ text: "how is my run" }), assistantTurn: reply, proposal: null }),
      "POST /v1/voice/transcribe": () => transcript("how is my run"),
      "POST /v1/voice/speak": speak,
    });

  it("a spoken send is read aloud in the owner's voice; End stops it; read aloud replays and stops", async () => {
    const v = installVoiceFakes();
    const calls = talk();
    renderApp(`${IN_PROJECT}&drawer=talk:${THREAD}`);
    const user = userEvent.setup();
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(await dialog.findByRole("button", { name: /^Talk: press to record/ }));
    await user.click(await dialog.findByRole("button", { name: "Recording: press to stop" }));
    const input = dialog.getByLabelText("Message") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("how is my run"));
    expect(calls.filter((c) => c.path.endsWith("/turns"))).toHaveLength(0);

    await user.click(dialog.getByRole("button", { name: "Send" }));
    const hud = await dialog.findByRole("region", { name: "Voice" });
    await waitFor(() =>
      expect(within(hud).getByRole("status").textContent).toBe(
        "Speaking · Azure AI Speech · en-US-AvaMultilingualNeural",
      ),
    );
    expect(within(hud).getByText("Run 22222222 is running.")).toBeTruthy();
    expect(calls.find((c) => c.path === "/v1/voice/speak")?.body).toEqual({
      projectId: PROJECT_ID,
      text: "Run 22222222 is running.",
    });
    const clip = v.audios[0]!;
    expect(clip.playbackRate).toBe(1.25);
    expect(clip.paused).toBe(false);

    await user.click(within(hud).getByRole("button", { name: "End" }));
    expect(clip.paused).toBe(true);
    expect(v.revoked).toEqual(["blob:reply"]);
    expect(dialog.queryByRole("region", { name: "Voice" })).toBeNull();

    const readAloud = dialog.getByRole("button", { name: "read aloud", pressed: false });
    await user.click(readAloud);
    await waitFor(() => expect(v.audios).toHaveLength(2));
    expect(dialog.getByRole("button", { name: "read aloud", pressed: true })).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "read aloud", pressed: true }));
    expect(v.audios[1]!.paused).toBe(true);
    expect(calls.filter((c) => c.path === "/v1/voice/speak")).toHaveLength(2);
  });

  it("without Azure AI Speech, or when it answers 409, the browser's own voice reads the reply", async () => {
    const v = installVoiceFakes();
    let calls = talk(voiceStatus({ speak: null }));
    renderApp(`${IN_PROJECT}&drawer=talk:${THREAD}`);
    const user = userEvent.setup();
    let dialog = within(await screen.findByRole("dialog"));
    await user.click(await dialog.findByRole("button", { name: "read aloud" }));
    const hud = await dialog.findByRole("region", { name: "Voice" });
    expect(within(hud).getByRole("status").textContent).toBe("Speaking · browser voice");
    expect(v.spoken.map((u) => [u.text, u.rate, u.lang])).toEqual([
      ["Run 22222222 is running.", 1.25, "en-US"],
    ]);
    expect(calls.filter((c) => c.path === "/v1/voice/speak")).toHaveLength(0);
    v.spoken[0]!.onend?.();
    await waitFor(() => expect(dialog.queryByRole("region", { name: "Voice" })).toBeNull());
    cleanup();

    calls = talk(voiceStatus(), () =>
      apiError(409, "CONFLICT", "Spoken replies need Azure AI Speech: see docs/runbooks/voice.md."),
    );
    renderApp(`${IN_PROJECT}&drawer=talk:${THREAD}`);
    dialog = within(await screen.findByRole("dialog"));
    await user.click(await dialog.findByRole("button", { name: "read aloud" }));
    await waitFor(() => expect(v.spoken).toHaveLength(2));
    expect(calls.filter((c) => c.path === "/v1/voice/speak")).toHaveLength(1);
    expect(v.audios).toHaveLength(0);
  });

  it("with spoken replies off nothing is read aloud, not even after a spoken send", async () => {
    const v = installVoiceFakes();
    const calls = talk(voiceStatus({}, { speakReplies: false }));
    renderApp(`${IN_PROJECT}&drawer=talk:${THREAD}`);
    const user = userEvent.setup();
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(await dialog.findByRole("button", { name: /^Talk: press to record/ }));
    await user.click(await dialog.findByRole("button", { name: "Recording: press to stop" }));
    await waitFor(() => expect((dialog.getByLabelText("Message") as HTMLInputElement).value).not.toBe(""));
    await user.click(dialog.getByRole("button", { name: "Send" }));
    await waitFor(() => expect((dialog.getByLabelText("Message") as HTMLInputElement).value).toBe(""));
    expect(dialog.queryByRole("button", { name: "read aloud" })).toBeNull();
    expect(calls.filter((c) => c.path === "/v1/voice/speak")).toHaveLength(0);
    expect(v.audios).toHaveLength(0);
    expect(v.synth.speak).not.toHaveBeenCalled();
  });
});

describe("Settings → Voice & consent", () => {
  it("shows providers, the disclosure and usage; each switch and choice is saved with PUT", async () => {
    let current = voiceStatus(
      {},
      { micEnabled: false, speakReplies: false, speechRate: 1, language: "auto" },
    );
    const calls = mockFetch({
      ...base,
      "GET /v1/voice/status": () => json(current),
      "PUT /v1/voice/settings": (c) => {
        current = { ...current, settings: { ...current.settings, ...(c.body as object) } };
        return json(current);
      },
    });
    renderApp(`/?drawer=settings#voice`);
    const user = userEvent.setup();
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Voice & consent", pressed: true })).toBeTruthy();
    expect(await dialog.findByText("Azure OpenAI · deployment gpt-4o-mini-transcribe")).toBeTruthy();
    expect(dialog.getByText("Azure AI Speech · en-US-AvaMultilingualNeural")).toBeTruthy();
    const disclosure = dialog.getByRole("region", { name: "What happens to your voice" });
    expect(within(disclosure).getAllByRole("listitem")).toHaveLength(2);
    expect(dialog.getByText(/today · 42 s transcribed · 310 characters spoken/)).toBeTruthy();

    const mic = dialog.getByRole("switch", { name: "Microphone" });
    await user.click(mic);
    await waitFor(() => expect(mic.getAttribute("aria-checked")).toBe("true"));
    await user.click(dialog.getByRole("switch", { name: "Speak replies" }));
    await waitFor(() =>
      expect(dialog.getByRole("switch", { name: "Speak replies" }).getAttribute("aria-checked")).toBe("true"),
    );
    await user.selectOptions(dialog.getByRole("combobox", { name: "Speech rate" }), "1.5");
    await waitFor(() => expect(current.settings.speechRate).toBe(1.5));
    await user.selectOptions(dialog.getByRole("combobox", { name: "Language" }), "de-DE");
    await waitFor(() => expect(current.settings.language).toBe("de-DE"));
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
      { micEnabled: true },
      { speakReplies: true },
      { speechRate: 1.5 },
      { language: "de-DE" },
    ]);
  });

  it("says when voice isn't set up, and shows the file problem when it is invalid", async () => {
    let status = voiceStatus({ configured: false, transcribe: null, speak: null, disclosure: [] });
    mockFetch({ ...base, "GET /v1/voice/status": () => json(status) });
    renderApp(`/?drawer=settings#voice`);
    let dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("Voice isn't set up on the home machine")).toBeTruthy();
    expect(dialog.getByText(/Follow docs\/runbooks\/voice\.md/)).toBeTruthy();
    expect(dialog.getByText("Nothing is recorded or sent while voice isn't set up.")).toBeTruthy();
    cleanup();

    status = voiceStatus({
      transcribe: null,
      speak: null,
      problem: "~/.nexus/voice.json must have mode 600 (see docs/runbooks/voice.md).",
    });
    renderApp(`/?drawer=settings#voice`);
    dialog = within(await screen.findByRole("dialog"));
    expect((await dialog.findByRole("alert")).textContent).toMatch(/has a problem.*must have mode 600/);
  });
});
