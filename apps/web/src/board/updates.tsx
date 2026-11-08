import { createContext, use, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { z } from "zod";
import { VOICE_SPEAK_MAX_CHARS, type Notification, type NotificationCategory } from "@nexus/contracts";
import { ApiRequestError, api } from "../lib/api.ts";
import { useNotifications } from "../lib/queries.ts";
import { useScope } from "./scope.tsx";
import { useVoiceActivity, useVoiceStatus, type Speech } from "./voice.tsx";

// Updates while the app is open (FR-NTF-12): what arrives after a scope's list first loaded is "noticed just now"
// in the Cofounder panel (or toasts), can be read aloud on request (Tell me) or automatically when the owner opted
// in on this device, and is said inside a voice conversation. Every word comes from the notification itself, which
// the server builds from recorded facts and redacts for display: nothing here is invented or model-written.

/** Updates queued longer than this are not said any more: they are old news, and stay in the Inbox. */
export const UPDATE_STALE_MS = 2 * 60_000;

// ---------------------------------------------------------------------------------------------------------------
// "Read new updates aloud": per device, since it is about this device's speakers.

export const UpdatesVoice = z.enum(["off", "needs-me", "all"]);
export type UpdatesVoice = z.infer<typeof UpdatesVoice>;
const PREF_KEY = "nexus.updates.voice";

/** "Only things that need me": a decision waiting, something failed or needs recovery, an incident, a security event. */
export const NEEDS_ME: ReadonlySet<NotificationCategory> = new Set<NotificationCategory>([
  "APPROVAL_REQUIRED",
  "TASK_FAILED",
  "SECURITY_CRITICAL",
  "BUSINESS_EXCEPTION",
]);

// This tab's choice while storage refuses writes (private mode, policy): it holds until the page reloads.
let unsaved: UpdatesVoice | null = null;
const prefListeners = new Set<() => void>();

function readPref(): UpdatesVoice {
  if (unsaved) return unsaved;
  try {
    const p = UpdatesVoice.safeParse(localStorage.getItem(PREF_KEY));
    return p.success ? p.data : "off";
  } catch {
    return "off";
  }
}

function writePref(p: UpdatesVoice) {
  try {
    localStorage.setItem(PREF_KEY, p);
    unsaved = null;
  } catch {
    unsaved = p;
  }
  prefListeners.forEach((l) => l());
}

function subscribePref(l: () => void) {
  prefListeners.add(l);
  // Another tab on this device changed it.
  const onStorage = (e: StorageEvent) => e.key === PREF_KEY && l();
  window.addEventListener("storage", onStorage);
  return () => {
    prefListeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export function useUpdatesVoice(): [UpdatesVoice, (p: UpdatesVoice) => void] {
  return [useSyncExternalStore(subscribePref, readPref), writePref];
}

// ---------------------------------------------------------------------------------------------------------------
// What is said

const QUOTED = /["“”«»]/;
const speakable = (title: string) =>
  title
    .replace(/\s·\s/g, ", ")
    .trim()
    .replace(/[.!?…:;,]+$/, "");

/**
 * The words for one or more updates: each one's own title, and for a single update the first sentence of its body
 * when that is NEXUS's own plain text (never quoted source text, never a business record's details).
 */
export function spokenUpdate(items: readonly Notification[]): string {
  const [first] = items;
  if (!first) return "";
  if (items.length === 1) {
    const sentence = /^[^.!?]*[.!?]/.exec(first.body.trim())?.[0];
    const body =
      sentence && sentence.length <= 160 && !QUOTED.test(sentence) && first.category !== "BUSINESS_EXCEPTION"
        ? ` ${sentence}`
        : "";
    return `${speakable(first.title)}.${body}`.slice(0, VOICE_SPEAK_MAX_CHARS);
  }
  const titles = items.slice(0, 5).map((n) => `${speakable(n.title)}.`);
  const more = items.length > 5 ? ` And ${items.length - 5} more in the Inbox.` : "";
  return `${items.length} updates. ${titles.join(" ")}${more}`.slice(0, VOICE_SPEAK_MAX_CHARS);
}

// ---------------------------------------------------------------------------------------------------------------
// The provider: one per page, so one voice says updates and nothing is announced twice.

export interface Arrival {
  /** Bumped per poll that brought something new. */
  seq: number;
  /** Newest first. */
  items: Notification[];
  /** When the poll that brought them answered (ms). */
  at: number;
  /** A voice conversation with the cofounder was on: it says them instead of the whisper and the update voice. */
  toTalk: boolean;
}

export interface Whisper {
  items: Notification[];
  at: number;
}

interface Queued {
  id: string;
  ids: string[];
  text: string;
  projectId: string | null;
  at: number;
}

export interface Updates {
  arrival: Arrival | null;
  /** What is noticed and not yet opened, read or put off; several arrivals collapse into one. */
  whisper: Whisper | null;
  /** Later: the whisper goes (its updates stay unread in the Inbox) and nothing more is said about them. */
  dismiss: () => void;
  /** Tell me: says these now (a tap, so the browser lets it play), or right after the mic or a reply. */
  tell: (items: readonly Notification[]) => void;
  speaking: Speech | null;
  /** Stops the update being said and drops the ones waiting. */
  stop: () => void;
  /** The browser refused to play without a tap: "Tap to hear updates". */
  needsTap: boolean;
  hear: () => void;
  problem: string | null;
  clearProblem: () => void;
  /** The Cofounder's voice conversation is on (it then says new updates itself). */
  setTalking: (on: boolean) => void;
}

const UpdatesContext = createContext<Updates | null>(null);

export function useUpdates(): Updates {
  const u = use(UpdatesContext);
  if (!u) throw new Error("useUpdates needs an UpdatesProvider");
  return u;
}

type Detected = {
  key: string;
  at: number;
  seen: Map<string, Set<string>>;
  arrival: Arrival | null;
  whisper: Whisper | null;
};

export function UpdatesProvider({ children }: { children: ReactNode }) {
  const scope = useScope();
  const q = useNotifications(scope.project?.id, scope.ready);
  const key = scope.project?.id ?? "all";
  const [talking, setTalking] = useState(false);
  const [d, setD] = useState<Detected>({ key, at: 0, seen: new Map(), arrival: null, whisper: null });

  // Derived from each poll during render (React's "adjust state on change"): what was there when a scope's list first
  // loaded is the Inbox's business; after that each new UNREAD one arrives once, however often it is polled.
  if (q.data && (d.key !== key || d.at !== q.dataUpdatedAt)) {
    const known = d.seen.get(key);
    const fresh = known ? q.data.items.filter((n) => n.status === "UNREAD" && !known.has(n.id)) : [];
    const at = q.dataUpdatedAt;
    const arrival =
      fresh.length > 0 ? { seq: (d.arrival?.seq ?? 0) + 1, items: fresh, at, toTalk: talking } : null;
    setD({
      key,
      at,
      seen: new Map(d.seen).set(key, new Set([...(known ?? []), ...q.data.items.map((n) => n.id)])),
      arrival: arrival ?? d.arrival,
      whisper:
        arrival && !talking
          ? {
              items: [...fresh, ...(d.whisper?.items.filter((w) => !fresh.some((f) => f.id === w.id)) ?? [])],
              at,
            }
          : d.whisper,
    });
  }
  // Opened or acknowledged elsewhere (Inbox, another device): no longer "noticed".
  const statusOf = new Map(q.data?.items.map((n) => [n.id, n.status]));
  const whisperItems = d.whisper?.items.filter((n) => (statusOf.get(n.id) ?? "UNREAD") === "UNREAD") ?? [];
  const whisper = d.whisper && whisperItems.length > 0 ? { items: whisperItems, at: d.whisper.at } : null;

  const speech = useUpdateVoice(scope.project?.id);
  const [pref] = useUpdatesVoice();

  // Each arrival is queued once, filtered by this device's choice; a voice conversation says them itself.
  const handled = useRef(0);
  useEffect(() => {
    const a = d.arrival;
    if (!a || a.seq === handled.current) return;
    handled.current = a.seq;
    if (a.toTalk || pref === "off") return;
    const wanted = pref === "all" ? a.items : a.items.filter((n) => NEEDS_ME.has(n.category));
    if (wanted.length > 0) speech.enqueue(wanted, `update:${a.seq}`);
  });

  const dismiss = () => {
    speech.forget(new Set(whisper?.items.map((n) => n.id)));
    setD((x) => ({ ...x, whisper: null }));
  };

  const value: Updates = {
    arrival: d.arrival,
    whisper,
    dismiss,
    tell: speech.tell,
    speaking: speech.speaking,
    stop: speech.stop,
    needsTap: speech.needsTap,
    hear: speech.hear,
    problem: speech.problem,
    clearProblem: speech.clearProblem,
    setTalking,
  };
  return <UpdatesContext value={value}>{children}</UpdatesContext>;
}

// ---------------------------------------------------------------------------------------------------------------
// The update voice: the owner's Azure AI Speech voice when it is set up and Speak replies is on, else this browser's
// own voice. One update at a time; it waits while a mic is open or a reply is read, and gives way to both.

function useUpdateVoice(scopeProjectId: string | undefined) {
  const status = useVoiceStatus();
  const { recording, replying } = useVoiceActivity();
  const [speaking, setSpeaking] = useState<Speech | null>(null);
  const [needsTap, setNeedsTap] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const queue = useRef<Queued[]>([]);
  const current = useRef<{ item: Queued; voice: Speech["voice"] } | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const unlocked = useRef(false);
  const clipUrl = useRef<string | null>(null);
  const generation = useRef(0);
  const told = useRef(0);
  const settings = status.data?.settings;

  const releaseClip = () => {
    const el = audio.current;
    if (el) {
      el.onended = null;
      el.onerror = null;
    }
    if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
    clipUrl.current = null;
  };

  /** Silences the current update; `cancelBrowser` false when a reply already took the browser's voice. */
  const halt = (cancelBrowser: boolean): Queued | null => {
    generation.current++;
    const c = current.current;
    current.current = null;
    if (c?.voice === "server") audio.current?.pause();
    if (c?.voice === "browser" && cancelBrowser && typeof speechSynthesis !== "undefined")
      speechSynthesis.cancel();
    releaseClip();
    return c?.item ?? null;
  };

  const settle = (gen: number) => {
    if (gen !== generation.current) return false;
    current.current = null;
    releaseClip();
    setSpeaking(null);
    return true;
  };
  const blocked = (gen: number, item: Queued) => {
    if (!settle(gen)) return;
    queue.current.unshift(item);
    setNeedsTap(true);
  };

  // Safari lets an element play later only if it was played inside a tap: Tell me and "Tap to hear" are that tap.
  const unlock = () => {
    if (unlocked.current || typeof Audio === "undefined") return;
    unlocked.current = true;
    audio.current ??= new Audio();
    void Promise.resolve(audio.current.play()).catch(() => undefined);
  };

  const browserVoice = (gen: number, item: Queued) => {
    if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") {
      settle(gen);
      setProblem(
        `This browser has no voice to read updates, and Azure AI Speech isn't set up (see ${status.data?.runbook ?? "the voice runbook"}).`,
      );
      return;
    }
    const u = new SpeechSynthesisUtterance(item.text);
    u.rate = settings?.speechRate ?? 1;
    if (settings && settings.language !== "auto") u.lang = settings.language;
    u.onend = () => settle(gen);
    u.onerror = (e) => {
      if (gen !== generation.current) return;
      if (e.error === "not-allowed") return blocked(gen, item);
      // A reply took the browser's voice: this update is said after it.
      if (e.error === "canceled" || e.error === "interrupted") {
        settle(gen);
        queue.current.unshift(item);
        return;
      }
      settle(gen);
      setProblem("The browser voice couldn't read the update.");
    };
    current.current = { item, voice: "browser" };
    setSpeaking({ id: item.id, text: item.text, voice: "browser", loading: false });
    speechSynthesis.speak(u);
  };

  const serverVoice = async (gen: number, item: Queued, projectId: string) => {
    current.current = { item, voice: "server" };
    setSpeaking({ id: item.id, text: item.text, voice: "server", loading: true });
    try {
      const blob = await api.speak({ projectId, text: item.text });
      if (gen !== generation.current) return;
      audio.current ??= new Audio();
      const el = audio.current;
      releaseClip();
      clipUrl.current = URL.createObjectURL(blob);
      el.src = clipUrl.current;
      el.playbackRate = settings?.speechRate ?? 1;
      el.onended = () => settle(gen);
      el.onerror = () => {
        if (settle(gen)) setProblem("The update couldn't be played.");
      };
      setSpeaking({ id: item.id, text: item.text, voice: "server", loading: false });
      await el.play();
    } catch (e) {
      if (gen !== generation.current) return;
      if (e instanceof DOMException && e.name === "NotAllowedError") return blocked(gen, item);
      // 409: Azure AI Speech isn't set up (any more); 403: Speak replies was turned off. The browser's voice still can.
      if (e instanceof ApiRequestError && (e.status === 409 || e.status === 403)) {
        current.current = null;
        return browserVoice(gen, item);
      }
      settle(gen);
      setProblem(
        e instanceof ApiRequestError
          ? `This update couldn't be read aloud: ${e.message}`
          : "This update couldn't be read aloud.",
      );
    }
  };

  const play = (item: Queued) => {
    const gen = ++generation.current;
    setProblem(null);
    // No tap on this page yet: the browser would refuse, so ask for one instead of failing silently.
    if (navigator.userActivation?.hasBeenActive === false) {
      queue.current.unshift(item);
      setNeedsTap(true);
      return;
    }
    const projectId = item.projectId ?? scopeProjectId;
    // The server voice sends the words to Azure only when the owner turned Speak replies on.
    if (status.data?.speak && settings?.speakReplies && projectId) void serverVoice(gen, item, projectId);
    else browserVoice(gen, item);
  };

  /** Says the next update that isn't stale, unless something holds it back. */
  const pump = (tapped = false) => {
    if (current.current || recording || replying || (needsTap && !tapped)) return;
    const now = Date.now();
    queue.current = queue.current.filter((x) => now - x.at <= UPDATE_STALE_MS);
    const next = queue.current.shift();
    if (next) play(next);
  };

  // A mic opening or a reply starting interrupts an update; it is said again afterwards (unless stale by then).
  // A reply has already taken the browser's voice, so only a mic cancels it.
  const giveWay = () => {
    const item = halt(!replying);
    if (item) queue.current.unshift(item);
    setSpeaking(null);
  };
  useEffect(() => {
    if (current.current && (recording || replying)) giveWay();
    else pump();
  });

  // Leaving the page (sign out) silences it.
  const haltRef = useRef(halt);
  useEffect(() => {
    haltRef.current = halt;
  });
  useEffect(() => () => void haltRef.current(true), []);

  const item = (items: readonly Notification[], id: string): Queued => ({
    id,
    ids: items.map((n) => n.id),
    text: spokenUpdate(items),
    projectId: items[0]?.projectId ?? null,
    at: Date.now(),
  });

  return {
    speaking,
    needsTap,
    problem,
    clearProblem: () => setProblem(null),
    enqueue: (items: readonly Notification[], id: string) => {
      queue.current.push(item(items, id));
      pump();
    },
    tell: (items: readonly Notification[]) => {
      if (items.length === 0) return;
      unlock();
      setNeedsTap(false);
      const next = item(items, `tell:${++told.current}`);
      if (current.current) halt(true);
      queue.current = [next, ...queue.current.filter((x) => !x.ids.some((id) => next.ids.includes(id)))];
      setSpeaking(null);
      pump(true);
    },
    hear: () => {
      unlock();
      setNeedsTap(false);
      pump(true);
    },
    stop: () => {
      halt(true);
      queue.current = [];
      setSpeaking(null);
    },
    forget: (ids: ReadonlySet<string>) => {
      queue.current = queue.current.filter((x) => !x.ids.some((id) => ids.has(id)));
      if (current.current?.item.ids.some((id) => ids.has(id))) {
        halt(true);
        setSpeaking(null);
      }
      setProblem(null);
    },
  };
}
