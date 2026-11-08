import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type PointerEvent,
  type Ref,
} from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { m, useMotionValue, useReducedMotion, useTransform, type MotionValue } from "motion/react";
import { VOICE_MAX_SECONDS, VOICE_SPEAK_MAX_CHARS, type VoiceStatus } from "@nexus/contracts";
import { ApiRequestError, api, keys } from "../lib/api.ts";
import { useScope, type Scope } from "./scope.tsx";

// Push-to-talk and spoken replies (FR-CWV-02/03, CWV-G06..G08). The mic opens only on an explicit press and every
// track is stopped on stop, End and unmount. A transcript only fills an input: the owner reads it and sends it.

const route = getRouteApi("/");

export function useVoiceStatus() {
  return useQuery({ queryKey: keys.voice, queryFn: api.voiceStatus, staleTime: 60_000 });
}

/** "this Mac" etc. for "mic on this Mac": where the microphone that is recording is. */
export function thisDevice(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "this iPhone";
  if (/iPad/.test(ua)) return "this iPad";
  if (/Android/.test(ua)) return "this phone";
  if (/Macintosh|Mac OS X/.test(ua)) return "this Mac";
  if (/Windows/.test(ua)) return "this PC";
  return "this device";
}

/** Why the mic can't record in this scope: a recording belongs to one active project (like a Talk thread). */
export const micScopeBlock = (scope: Scope): string | null =>
  !scope.project
    ? "Voice input records into one project: choose it in Scope first."
    : scope.project.archivedAt
      ? "Voice input is off: this project is archived."
      : null;

/** Opens Settings → Voice & consent (the tab is picked by the `#voice` hash). */
export function useOpenVoiceSettings() {
  const navigate = route.useNavigate();
  const { keep } = useScope();
  return () => void navigate({ search: { ...keep, drawer: "settings" }, hash: "voice" });
}

// ---------------------------------------------------------------------------------------------------------------
// Who is using the audio right now, app-wide. Spoken updates wait for both: they never talk while the owner is
// recording, nor over a reply that is being read.

const activity = { mics: new Set<object>(), replies: new Set<object>() };
const activityListeners = new Set<() => void>();

function markActivity(set: Set<object>, owner: object, on: boolean) {
  if (set.has(owner) === on) return;
  if (on) set.add(owner);
  else set.delete(owner);
  activityListeners.forEach((l) => l());
}

const subscribeActivity = (l: () => void) => {
  activityListeners.add(l);
  return () => void activityListeners.delete(l);
};
// A string snapshot: stable while nothing changes, as useSyncExternalStore needs.
const activitySnapshot = () =>
  `${activity.mics.size > 0 ? "rec" : ""}|${activity.replies.size > 0 ? "say" : ""}`;

export interface VoiceActivity {
  /** A mic is open somewhere (asking for permission or recording). A paused recording is not recording. */
  recording: boolean;
  /** A Cofounder or Talk reply is being read aloud. */
  replying: boolean;
}

export function useVoiceActivity(): VoiceActivity {
  const s = useSyncExternalStore(subscribeActivity, activitySnapshot);
  return { recording: s.startsWith("rec"), replying: s.endsWith("say") };
}

// ---------------------------------------------------------------------------------------------------------------
// Push-to-talk

// The first one the browser can record wins: Chrome/Firefox record webm/opus, Safari mp4. All are VOICE_AUDIO_TYPES.
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg"] as const;

/** `paused`: the clip is kept but nothing is recorded while NEXUS says an update; it then goes on listening. */
export type TalkPhase = "idle" | "requesting" | "listening" | "paused" | "transcribing";
export interface TalkProblem {
  kind: "denied" | "no-mic" | "unsupported" | "empty" | "settings" | "failed";
  message: string;
}

interface Recording {
  projectId: string;
  onText: (text: string) => void;
  stream: MediaStream;
  recorder: MediaRecorder;
  type: string;
  chunks: Blob[];
  /** When recording last started or resumed, and how much was recorded before that (pauses don't count). */
  resumedAt: number;
  heardMs: number;
  durationMs: number;
  timer: number;
  frame: number;
  ctx: AudioContext | null;
}

export interface PushToTalk {
  phase: TalkPhase;
  problem: TalkProblem | null;
  /** 0..1 input level while listening, for the bars. */
  level: MotionValue<number>;
  /** Asks for the mic (the browser may prompt) and records until `stop`, `cancel` or VOICE_MAX_SECONDS. */
  start: (onText: (text: string) => void) => void;
  /** Stops recording and transcribes; the words go to the `onText` given to `start`. */
  stop: () => void;
  /** End: releases the mic and drops the recording and any transcription in flight. */
  cancel: () => void;
  /** Stops recording but keeps the clip (false when not listening or the browser can't pause a recording). */
  pause: () => boolean;
  /** Goes on recording into the same clip after `pause`. */
  resume: () => void;
}

const stopTracks = (stream: MediaStream) => stream.getTracks().forEach((t) => t.stop());

function micProblem(e: unknown): TalkProblem {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return {
      kind: "denied",
      message:
        "The browser blocked the microphone. Allow it for this site (the icon next to the address bar), then press the mic again. You can keep typing meanwhile.",
    };
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return { kind: "no-mic", message: "No microphone was found. Connect one, or type instead." };
  if (name === "NotReadableError")
    return {
      kind: "no-mic",
      message:
        "The microphone is busy in another app. Close it there and press the mic again, or type instead.",
    };
  return {
    kind: "failed",
    message: "The microphone couldn't start. Press the mic to try again, or type instead.",
  };
}

function transcribeProblem(e: unknown): TalkProblem {
  if (!(e instanceof ApiRequestError))
    return { kind: "failed", message: "Your recording couldn't be transcribed. Press the mic to try again." };
  if (e.code === "UNREACHABLE")
    return {
      kind: "failed",
      message: "Your recording wasn't transcribed: NEXUS can't be reached. Press the mic to try again.",
    };
  // 403 (mic off in settings) and 409 (not set up) are fixed in Settings → Voice & consent.
  return { kind: e.status === 403 || e.status === 409 ? "settings" : "failed", message: e.message };
}

// One microphone at a time: Home shows two mics (command bar and Cofounder panel), and pressing one ends the other.
let activeMic: { owner: object; cancel: () => void } | null = null;

export function usePushToTalk(projectId: string | undefined): PushToTalk {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<TalkPhase>("idle");
  const [problem, setProblem] = useState<TalkProblem | null>(null);
  const level = useMotionValue(0);
  const session = useRef<Recording | null>(null);
  // Bumped by End and unmount: a permission prompt or transcription that settles later is dropped.
  const generation = useRef(0);
  const owner = useRef({});

  const release = (rec: Recording) => {
    if (activeMic?.owner === owner.current) activeMic = null;
    stopTracks(rec.stream);
    window.clearTimeout(rec.timer);
    cancelAnimationFrame(rec.frame);
    void rec.ctx?.close().catch(() => undefined);
    rec.ctx = null;
    level.set(0);
  };

  const meter = (rec: Recording) => {
    const Ctx =
      typeof AudioContext === "undefined"
        ? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : AudioContext;
    if (!Ctx) return;
    try {
      const ctx = new Ctx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(rec.stream).connect(analyser);
      rec.ctx = ctx;
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        level.set(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        rec.frame = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // No level bars; the recording itself doesn't need the analyser.
    }
  };

  const finish = async (rec: Recording, gen: number) => {
    if (gen !== generation.current) return;
    const blob = new Blob(rec.chunks, { type: rec.type });
    if (blob.size === 0) {
      setPhase("idle");
      setProblem({
        kind: "empty",
        message: "Nothing was recorded. Press the mic, speak, then press it again.",
      });
      return;
    }
    try {
      const t = await api.transcribe(rec.projectId, blob, rec.durationMs);
      if (gen !== generation.current) return;
      setPhase("idle");
      const text = t.text.trim();
      if (text) rec.onText(text);
      else setProblem({ kind: "empty", message: "No words were heard. Press the mic and try again." });
    } catch (e) {
      if (gen !== generation.current) return;
      setPhase("idle");
      const p = transcribeProblem(e);
      setProblem(p);
      if (p.kind === "settings") void queryClient.invalidateQueries({ queryKey: keys.voice });
    }
  };

  const stop = () => {
    const rec = session.current;
    if (!rec) return;
    session.current = null;
    const live = rec.recorder.state === "recording" ? performance.now() - rec.resumedAt : 0;
    rec.durationMs = Math.min(VOICE_MAX_SECONDS * 1000, rec.heardMs + live);
    setPhase("transcribing");
    rec.recorder.stop();
    release(rec);
  };

  const pause = () => {
    const rec = session.current;
    if (!rec || phase !== "listening" || rec.recorder.state !== "recording") return false;
    if (typeof rec.recorder.pause !== "function") return false;
    rec.recorder.pause();
    window.clearTimeout(rec.timer);
    rec.heardMs += performance.now() - rec.resumedAt;
    setPhase("paused");
    return true;
  };

  const resume = () => {
    const rec = session.current;
    if (!rec || phase !== "paused" || rec.recorder.state !== "paused") return;
    rec.recorder.resume();
    rec.resumedAt = performance.now();
    rec.timer = window.setTimeout(stop, Math.max(0, VOICE_MAX_SECONDS * 1000 - rec.heardMs));
    setPhase("listening");
  };

  const start = async (onText: (text: string) => void) => {
    if (!projectId || phase !== "idle") return;
    setProblem(null);
    const type =
      typeof MediaRecorder === "undefined"
        ? undefined
        : RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    if (!navigator.mediaDevices?.getUserMedia || !type) {
      setProblem({
        kind: "unsupported",
        message:
          "This browser can't record audio for NEXUS. Type instead, or use a current Chrome, Edge or Safari.",
      });
      return;
    }
    if (activeMic && activeMic.owner !== owner.current) activeMic.cancel();
    activeMic = { owner: owner.current, cancel: () => cancelRef.current() };
    const gen = ++generation.current;
    setPhase("requesting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (gen !== generation.current) return;
      setPhase("idle");
      setProblem(micProblem(e));
      return;
    }
    // End or unmount while the permission prompt was open: the mic must not stay on.
    if (gen !== generation.current) return stopTracks(stream);
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: type });
    } catch (e) {
      stopTracks(stream);
      setPhase("idle");
      setProblem(micProblem(e));
      return;
    }
    const rec: Recording = {
      projectId,
      onText,
      stream,
      recorder,
      type,
      chunks: [],
      resumedAt: performance.now(),
      heardMs: 0,
      durationMs: 0,
      timer: 0,
      frame: 0,
      ctx: null,
    };
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) rec.chunks.push(e.data);
    };
    recorder.onstop = () => void finish(rec, gen);
    recorder.start();
    rec.timer = window.setTimeout(stop, VOICE_MAX_SECONDS * 1000);
    session.current = rec;
    meter(rec);
    setPhase("listening");
  };

  const drop = () => {
    if (activeMic?.owner === owner.current) activeMic = null;
    generation.current++;
    const rec = session.current;
    session.current = null;
    if (!rec) return;
    rec.recorder.onstop = null;
    if (rec.recorder.state !== "inactive") rec.recorder.stop();
    release(rec);
  };
  const cancel = () => {
    drop();
    setPhase("idle");
  };

  // Unmount, or another project (the recording belongs to the one it started in), releases the mic.
  const cancelRef = useRef(cancel);
  useEffect(() => {
    cancelRef.current = cancel;
  });
  useEffect(() => () => cancelRef.current(), [projectId]);

  // An open mic holds back spoken updates until it closes or pauses.
  useEffect(() => {
    const me = owner.current;
    markActivity(activity.mics, me, phase === "requesting" || phase === "listening");
    return () => markActivity(activity.mics, me, false);
  }, [phase]);

  return { phase, problem, level, start: (onText) => void start(onText), stop, cancel, pause, resume };
}

// ---------------------------------------------------------------------------------------------------------------
// Spoken replies

export interface Speech {
  id: string;
  text: string;
  /** "server" = the owner's Azure AI Speech voice; "browser" = this browser's own speechSynthesis. */
  voice: "server" | "browser";
  loading: boolean;
}

export interface Speaker {
  /** The owner turned "speak replies" on; nothing is read aloud otherwise. */
  enabled: boolean;
  speaking: Speech | null;
  problem: string | null;
  /** Reads `text` aloud; `onDone` runs when it finished on its own (not when stopped). */
  speak: (id: string, text: string, onDone?: () => void) => void;
  stop: () => void;
}

export const voiceLabel = (s: Speech, status: VoiceStatus | undefined) =>
  s.voice === "browser" ? "browser voice" : `Azure AI Speech · ${status?.speak?.voice ?? "neural voice"}`;

export function useSpeak(projectId: string | undefined): Speaker {
  const status = useVoiceStatus();
  const [speaking, setSpeaking] = useState<Speech | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const playing = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const generation = useRef(0);
  const settings = status.data?.settings;

  const silence = () => {
    generation.current++;
    const p = playing.current;
    playing.current = null;
    if (p) {
      p.audio.pause();
      URL.revokeObjectURL(p.url);
    }
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  };
  const stop = () => {
    silence();
    setSpeaking(null);
  };

  const browserVoice = (gen: number, s: Speech, done: () => void) => {
    if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") {
      setSpeaking(null);
      setProblem(
        `This browser has no voice to read replies, and Azure AI Speech isn't set up (see ${status.data?.runbook ?? "the voice runbook"}).`,
      );
      return;
    }
    const u = new SpeechSynthesisUtterance(s.text);
    u.rate = settings?.speechRate ?? 1;
    if (settings && settings.language !== "auto") u.lang = settings.language;
    u.onend = done;
    u.onerror = (e) => {
      if (gen !== generation.current || e.error === "canceled" || e.error === "interrupted") return;
      setSpeaking(null);
      setProblem("The browser voice couldn't read the reply.");
    };
    setSpeaking({ ...s, voice: "browser", loading: false });
    speechSynthesis.speak(u);
  };

  const speak = async (id: string, text: string, onDone?: () => void) => {
    silence();
    setProblem(null);
    if (!projectId || !settings?.speakReplies) return setSpeaking(null);
    const gen = generation.current;
    const said = text.slice(0, VOICE_SPEAK_MAX_CHARS).trim();
    if (!said) return setSpeaking(null);
    const done = () => {
      if (gen !== generation.current) return;
      stop();
      onDone?.();
    };
    const s: Speech = { id, text: said, voice: "server", loading: true };
    if (!status.data?.speak) return browserVoice(gen, s, done);
    setSpeaking(s);
    try {
      const blob = await api.speak({ projectId, text: said });
      if (gen !== generation.current) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = settings.speechRate;
      audio.onended = done;
      audio.onerror = () => {
        if (gen !== generation.current) return;
        stop();
        setProblem("The reply couldn't be played.");
      };
      playing.current = { audio, url };
      setSpeaking({ ...s, loading: false });
      await audio.play();
    } catch (e) {
      if (gen !== generation.current) return;
      // 409: the Speech half isn't set up (any more); the browser's own voice still can.
      if (e instanceof ApiRequestError && e.status === 409) return browserVoice(gen, s, done);
      stop();
      setProblem(
        e instanceof ApiRequestError
          ? e.message
          : e instanceof DOMException && e.name === "NotAllowedError"
            ? "The browser blocked playback. Press Read aloud to hear the reply."
            : "The reply couldn't be played.",
      );
    }
  };

  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  });
  useEffect(() => () => stopRef.current(), [projectId]);

  // A reply being read holds back spoken updates.
  const owner = useRef({});
  useEffect(() => {
    const me = owner.current;
    markActivity(activity.replies, me, !!speaking);
    return () => markActivity(activity.replies, me, false);
  }, [speaking]);

  return {
    enabled: !!settings?.speakReplies,
    speaking,
    problem,
    speak: (id, text, onDone) => void speak(id, text, onDone),
    stop,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Components

const HOLD_MS = 350;
const SHAPE = [0.5, 1, 0.7, 0.4];

function Bar({ level, base, live }: { level: MotionValue<number>; base: number; live: boolean }) {
  const scaleY = useTransform(level, (l) => Math.min(1, 0.25 + base * 0.25 + l * (0.5 + base)));
  return (
    <m.span
      aria-hidden="true"
      className="h-4 w-[3px] rounded-sm bg-current"
      style={{ scaleY: live ? scaleY : base }}
    />
  );
}

/** Level bars: they follow the mic while listening; static with reduced motion. */
export function LevelBars({ level, live }: { level: MotionValue<number>; live: boolean }) {
  const reduced = useReducedMotion();
  return (
    <span aria-hidden="true" className="flex items-center gap-[2.5px]">
      {SHAPE.map((s, i) => (
        <Bar key={i} level={level} base={s} live={live && !reduced} />
      ))}
    </span>
  );
}

/**
 * Why the mic can't record here (null when it can), and whether Settings → Voice & consent is where to fix it.
 * `blocked`: why nothing can be recorded in this scope (no project, archived).
 */
export function useMicBlock(blocked: string | null): { why: string; settings: boolean } | null {
  const status = useVoiceStatus();
  if (blocked) return { why: blocked, settings: false };
  if (status.error) return { why: `Voice is unavailable: ${status.error.message}`, settings: false };
  if (!status.data) return { why: "Checking the voice setup…", settings: false };
  if (!status.data.transcribe)
    return {
      why: status.data.problem ?? `Voice isn't set up on the home machine yet (see ${status.data.runbook}).`,
      settings: true,
    };
  if (!status.data.settings.micEnabled)
    return { why: "The mic is off. Turn it on in Settings → Voice & consent.", settings: true };
  return null;
}

const MIC_LABEL: Record<TalkPhase, string> = {
  idle: "Talk: press to record, or hold while you speak",
  requesting: "Waiting for microphone permission: press to cancel",
  listening: "Recording: press to stop",
  paused: "Recording paused while NEXUS speaks: press to stop",
  transcribing: "Transcribing your recording",
};

/**
 * The mic. Tap to start and tap again to stop, or hold while speaking and release; Space/Enter toggle it and Escape
 * ends it. `onTranscript` gets the words for the owner to review. When it can't record, it says why; when that is
 * fixed in Settings, pressing it opens Settings → Voice & consent.
 */
export function MicButton({
  ptt,
  onTranscript,
  blocked,
  className = "size-10",
  ref,
}: {
  ptt: PushToTalk;
  onTranscript: (text: string) => void;
  /** Why nothing can be recorded in this scope (no project, archived). */
  blocked: string | null;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  const status = useVoiceStatus();
  const openSettings = useOpenVoiceSettings();
  const whyId = useId();
  const press = useRef<{ at: number } | null>(null);
  const block = useMicBlock(blocked);
  const base = `flex flex-none items-center justify-center rounded-xl ${className}`;

  if (block)
    return (
      <>
        <button
          ref={ref}
          type="button"
          aria-disabled={block.settings ? undefined : "true"}
          aria-label={block.settings ? "Voice input is off: open Settings → Voice & consent" : "Voice input"}
          aria-describedby={whyId}
          title={block.why}
          onClick={block.settings ? openSettings : undefined}
          className={`${base} bg-hair text-ink2 ${block.settings ? "" : "cursor-not-allowed opacity-45"}`}
        >
          <MicIcon off />
        </button>
        <span id={whyId} hidden>
          {block.why}
        </span>
      </>
    );

  const live = ptt.phase === "listening" || ptt.phase === "requesting" || ptt.phase === "paused";
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || ptt.phase !== "idle") return;
    press.current = { at: e.timeStamp };
    ptt.start(onTranscript);
  };
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    const p = press.current;
    press.current = null;
    // This press started the recording: a long press was hold-to-talk (release stops), a short one a tap.
    if (p) return void (e.timeStamp - p.at >= HOLD_MS && ptt.stop());
    if (ptt.phase === "idle") ptt.start(onTranscript);
    else if (ptt.phase === "listening" || ptt.phase === "paused") ptt.stop();
    else if (ptt.phase === "requesting") ptt.cancel();
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-pressed={live}
        aria-label={MIC_LABEL[ptt.phase]}
        aria-disabled={ptt.phase === "transcribing" ? "true" : undefined}
        aria-describedby={whyId}
        onPointerDown={onPointerDown}
        onClick={onClick}
        // A long touch is hold-to-talk, not the phone's context menu or text selection.
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && live) {
            e.stopPropagation();
            ptt.cancel();
          }
        }}
        className={`${base} select-none ${live ? "bg-coral text-onacc" : "bg-hair text-ink2"} ${ptt.phase === "transcribing" ? "opacity-60" : ""}`}
      >
        {ptt.phase === "listening" ? <LevelBars level={ptt.level} live /> : <MicIcon />}
      </button>
      <span id={whyId} hidden>
        {status.data?.disclosure.join(" ")}
      </span>
    </>
  );
}

function MicIcon({ off = false }: { off?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

/** The Cofounder's orb; it turns faster while voice is live. CSS animation, so reduced motion stops it. */
export function Orb({ size, live }: { size: number; live: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="relative inline-block flex-none rounded-full"
      style={{ width: size, height: size }}
    >
      <span
        className={`absolute inset-0 rounded-full ${live ? "animate-[spin_2.4s_linear_infinite]" : "animate-[spin_7s_linear_infinite]"}`}
        style={{
          background: "conic-gradient(from 0deg, var(--teal), var(--violet), var(--amber), var(--teal))",
          filter: `blur(${Math.max(0.5, size * 0.04)}px)`,
        }}
      />
      <span className="absolute rounded-full bg-glass2" style={{ inset: Math.round(size * 0.14) }} />
      <span
        className={`absolute rounded-full bg-teal ${live ? "nx-pulse" : ""}`}
        style={{ inset: Math.round(size * 0.36) }}
      />
    </span>
  );
}

const STATE_TEXT: Record<Exclude<TalkPhase, "idle">, string> = {
  requesting: "Waiting for the microphone",
  listening: "Listening",
  paused: "Listening paused",
  transcribing: "Transcribing",
};

/**
 * Voice HUD: shown while listening, transcribing or speaking (and between turns of a voice conversation), with the
 * state in words, the live caption, where the audio goes and End, which releases the mic and stops any audio.
 */
export function VoiceHud({
  ptt,
  speaker,
  conversation = false,
  onEnd,
}: {
  ptt: PushToTalk;
  speaker?: Speaker;
  /** A voice conversation is on: the HUD stays between turns. */
  conversation?: boolean;
  onEnd: () => void;
}) {
  const status = useVoiceStatus();
  const speaking = speaker?.speaking;
  if (ptt.phase === "idle" && !speaking && !conversation) return null;
  const micOn = ptt.phase === "listening" || ptt.phase === "requesting";
  // While an update is said the recording is paused: the HUD shows what is being said.
  const saying = speaking && (ptt.phase === "idle" || ptt.phase === "paused") ? speaking : null;
  const state = saying
    ? `${saying.loading ? "Preparing to speak" : "Speaking"} · ${voiceLabel(saying, status.data)}`
    : ptt.phase !== "idle"
      ? STATE_TEXT[ptt.phase]
      : "Your turn";
  const caption = saying
    ? saying.text
    : ptt.phase === "requesting"
      ? "Allow the microphone if the browser asks."
      : ptt.phase === "listening"
        ? "Speak now, then press the mic again. Your words appear in the box for you to read before anything is sent."
        : ptt.phase === "paused"
          ? "Your recording so far is kept. Listening goes on in a moment."
          : ptt.phase === "transcribing"
            ? "Turning your recording into text…"
            : "Press the mic to answer, or type.";
  const mic = micOn ? `mic on · ${thisDevice()}` : ptt.phase === "paused" ? "mic paused" : "mic off";
  return (
    <section
      aria-label="Voice"
      className="glass2 pointer-events-auto flex w-full flex-col gap-2.5 rounded-[22px] border border-line px-[18px] py-4"
    >
      <div className="flex items-center gap-2.5">
        <span className={micOn ? "text-coral" : "text-teal"}>
          <LevelBars level={ptt.level} live={ptt.phase === "listening"} />
        </span>
        <span
          role="status"
          className="kicker m-0 min-w-0 flex-1 truncate"
          style={{ color: micOn ? "var(--coral)" : "var(--teal)" }}
        >
          {state}
        </span>
        <span className="flex-none font-mono text-[10.5px] text-ink3">{mic}</span>
        <button
          type="button"
          onClick={onEnd}
          className="flex-none rounded-[10px] bg-hair px-3 py-2 text-[12px] font-medium text-ink"
        >
          End
        </button>
      </div>
      <p aria-live="polite" className="m-0 font-serif text-[20px] leading-snug text-pretty text-ink">
        {caption}
      </p>
      {status.data && status.data.disclosure.length > 0 && (
        <p className="m-0 font-mono text-[10.5px] leading-[1.5] text-ink3">
          {status.data.disclosure.join(" ")}
        </p>
      )}
    </section>
  );
}

/** Mic and playback problems in words, with the way to Settings where that's where they are fixed. */
export function VoiceProblems({ ptt, speaker }: { ptt: PushToTalk; speaker?: Speaker }) {
  const openSettings = useOpenVoiceSettings();
  const p = ptt.problem;
  const s = speaker?.problem;
  if (!p && !s) return null;
  return (
    <div role="alert" className="flex flex-col gap-1 text-[12.5px] leading-snug">
      {p && (
        <p className={`m-0 ${p.kind === "denied" || p.kind === "settings" ? "text-ink" : "text-coral"}`}>
          {p.message}
          {p.kind === "settings" && (
            <>
              {" "}
              <button type="button" onClick={openSettings} className="text-teal underline">
                Open Settings → Voice &amp; consent
              </button>
            </>
          )}
        </p>
      )}
      {s && <p className="m-0 text-coral">{s}</p>}
    </div>
  );
}

/** Read one reply aloud (or stop it). Only there when the owner turned spoken replies on. */
export function ReadAloudButton({ speaker, id, text }: { speaker: Speaker; id: string; text: string }) {
  if (!speaker.enabled) return null;
  const on = speaker.speaking?.id === id;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => (on ? speaker.stop() : speaker.speak(id, text))}
      className="rounded-full border border-hair px-2 py-0.5 font-mono text-[10.5px] text-ink2"
    >
      <span aria-hidden="true">{on ? "■ " : "▶ "}</span>read aloud
    </button>
  );
}
