import { vi } from "vitest";
import type { VoiceStatus } from "@nexus/contracts";

// jsdom has no microphone, MediaRecorder, AudioContext, Audio playback or speechSynthesis: these stand in for them.

export const voiceStatus = (
  over: Partial<VoiceStatus> = {},
  settings: Partial<VoiceStatus["settings"]> = {},
): VoiceStatus => ({
  configured: true,
  transcribe: { provider: "AZURE_OPENAI", deployment: "gpt-4o-mini-transcribe" },
  speak: { provider: "AZURE_SPEECH", voice: "en-US-AvaMultilingualNeural" },
  disclosure: [
    "Your recording is sent to Azure OpenAI (deployment gpt-4o-mini-transcribe) on your Foundry resource acme to turn it into text.",
    "Nothing is recorded until you press the mic.",
  ],
  runbook: "docs/runbooks/voice.md",
  problem: null,
  settings: { micEnabled: true, speakReplies: true, speechRate: 1.25, language: "en-US", ...settings },
  usageToday: { transcribedSeconds: 42, spokenCharacters: 310 },
  ...over,
});

export class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

export class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static supported = ["audio/webm;codecs=opus"];
  static isTypeSupported = (t: string) => FakeRecorder.supported.includes(t);
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly stream: MediaStream;
  readonly mimeType: string;
  constructor(stream: MediaStream, options: { mimeType: string }) {
    this.stream = stream;
    this.mimeType = options.mimeType;
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  pause() {
    if (this.state === "recording") this.state = "paused";
  }
  resume() {
    if (this.state === "paused") this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    // As in browsers: the last chunk and `stop` arrive asynchronously.
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(["clip"], { type: this.mimeType }) });
      this.onstop?.();
    }, 0);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  closed = false;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createAnalyser() {
    return { fftSize: 512, getByteTimeDomainData: (buf: Uint8Array) => buf.fill(150) };
  }
  createMediaStreamSource() {
    return { connect: () => undefined };
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

export class FakeAudio {
  static instances: FakeAudio[] = [];
  /** Set to make `play()` refuse as a browser does before any tap on the page. */
  static autoplayBlocked = false;
  playbackRate = 1;
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src: string;
  constructor(src = "") {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  play() {
    if (FakeAudio.autoplayBlocked && this.src)
      return Promise.reject(new DOMException("play() needs a user gesture", "NotAllowedError"));
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  /** The clip played to its end. */
  end() {
    this.paused = true;
    this.onended?.();
  }
}

export class FakeUtterance {
  rate = 1;
  lang = "";
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/**
 * Installs the fakes; `mic: "deny"` makes the permission prompt refuse. Returns what the tests inspect. Call
 * `removeVoiceFakes` in afterEach (navigator.mediaDevices and URL's statics aren't globals vi.unstubAllGlobals resets).
 */
export function installVoiceFakes({ mic = "allow" }: { mic?: "allow" | "deny" } = {}) {
  FakeRecorder.instances = [];
  FakeAudio.instances = [];
  FakeAudio.autoplayBlocked = false;
  FakeAudioContext.instances = [];
  const tracks: FakeTrack[] = [];
  const getUserMedia = vi.fn(async (_c: MediaStreamConstraints) => {
    if (mic === "deny") throw new DOMException("Permission denied", "NotAllowedError");
    const track = new FakeTrack();
    tracks.push(track);
    return { getTracks: () => [track] } as unknown as MediaStream;
  });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("Audio", FakeAudio);
  const spoken: FakeUtterance[] = [];
  const synth = { speak: vi.fn((u: FakeUtterance) => spoken.push(u)), cancel: vi.fn() };
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  const revoked: string[] = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:reply" });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => revoked.push(url),
  });
  return {
    getUserMedia,
    tracks,
    recorders: FakeRecorder.instances,
    contexts: FakeAudioContext.instances,
    audios: FakeAudio.instances,
    synth,
    spoken,
    revoked,
  };
}

const PATCHED: [object, string][] = [
  [navigator, "mediaDevices"],
  [URL, "createObjectURL"],
  [URL, "revokeObjectURL"],
];
const originals = new Map(PATCHED.map(([t, k]) => [k, Object.getOwnPropertyDescriptor(t, k)]));

export function removeVoiceFakes() {
  for (const [target, key] of PATCHED) {
    const d = originals.get(key);
    if (d) Object.defineProperty(target, key, d);
    else Reflect.deleteProperty(target, key);
  }
}
