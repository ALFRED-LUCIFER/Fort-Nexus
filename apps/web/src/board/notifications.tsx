import { useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Notification, NotificationCategory } from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { clock, useNotifications, useNow, useWorkspaces } from "../lib/queries.ts";
import { useScope, type Scope } from "./scope.tsx";
import { NEEDS_ME, useUpdates, type Updates } from "./updates.tsx";
import { voiceLabel, useVoiceStatus } from "./voice.tsx";

const route = getRouteApi("/");
const MAX_TOASTS = 3;

// Design dInbox / toasts: category colour + the Inbox tab each one lives in.
export const CATEGORY: Record<NotificationCategory, { tone: string; tab: string }> = {
  TASK_DONE: { tone: "var(--teal)", tab: "notice" },
  INFORMATIONAL: { tone: "var(--ink3)", tab: "notice" },
  TASK_FAILED: { tone: "var(--coral)", tab: "failure" },
  APPROVAL_REQUIRED: { tone: "var(--amber)", tab: "approval" },
  BUSINESS_EXCEPTION: { tone: "var(--amber)", tab: "business" },
  SECURITY_CRITICAL: { tone: "var(--coral)", tab: "security" },
};

/** The scope's notifications plus the badge count: unread ones, except approval notices (their pending card counts). */
export function useScopeNotifications() {
  const scope = useScope();
  const q = useNotifications(scope.project?.id, scope.ready);
  // shortcut: counts the newest 100 only; use NotificationList.unreadCount once approvals stop being double-listed.
  const unread = q.data?.items.filter(
    (n) => n.status === "UNREAD" && n.category !== "APPROVAL_REQUIRED",
  ).length;
  return { ...q, unread };
}

/** The scope a notification belongs to: its run's project (owner-wide notices keep the current scope). */
function useKeepOf() {
  const scope = useScope();
  const workspaces = useWorkspaces();
  return (n: Notification): Scope["keep"] => {
    const ws = workspaces.data?.items.find((w) => w.projects.some((p) => p.id === n.projectId));
    return ws
      ? { ws: ws.mode === "DEV" ? "dev" : "business", project: n.projectId ?? undefined }
      : scope.keep;
  };
}

/** Opening a notification marks it READ and deep-links to the exact run (its approval is in that drawer). */
export function useOpenNotification() {
  const navigate = route.useNavigate();
  const keepOf = useKeepOf();
  const queryClient = useQueryClient();
  const read = useMutation({
    mutationFn: (id: string) => api.setNotificationStatus(id, "READ"),
    // A failed mark leaves it unread in the inbox; nothing else depends on it.
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.notifications }),
  });
  return (n: Notification) => {
    if (n.status === "UNREAD") read.mutate(n.id);
    // The run (or incident) lives in its own project: open it there so it can be decided.
    const drawer = n.subject.jobId
      ? `run:${n.subject.jobId}`
      : n.subject.incidentId
        ? `incident:${n.subject.incidentId}`
        : n.subject.planId
          ? `plan:${n.subject.planId}`
          : "settings";
    void navigate({ search: { ...keepOf(n), drawer } });
  };
}

const NOTHING_TO_TALK_ABOUT = "This notice isn't about a run, so there's nothing to talk about.";

/** Talk about a notification's run: a new thread in the run's project, with the run as its subject (FR-CWV-04). */
function useTalkAbout(onOpened: (n: Notification) => void) {
  const navigate = route.useNavigate();
  const keepOf = useKeepOf();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { n: Notification; projectId: string; jobId: string }) =>
      api.createThread({ projectId: a.projectId, subjectJobId: a.jobId }),
    onSuccess: (thread, { n }) => {
      void queryClient.invalidateQueries({ queryKey: keys.threads });
      onOpened(n);
      void navigate({ search: { ...keepOf(n), drawer: `talk:${thread.id}` } });
    },
  });
}

type ToastState = { seq: number; toasts: Notification[] };

/**
 * New notifications as toasts (design: Later / Open / Talk, plus Tell me). What was already there when a scope's
 * list first loaded is the inbox's business; after that each new UNREAD one toasts once, however often it is polled.
 * `muted`: the docked Cofounder panel shows them as its whisper instead.
 */
export function NotificationToasts({ hidden, muted = false }: { hidden: boolean; muted?: boolean }) {
  const updates = useUpdates();
  const open = useOpenNotification();
  const arrival = updates.arrival;
  const [s, setS] = useState<ToastState>({ seq: arrival?.seq ?? 0, toasts: [] });

  // Each arrival once, during render (no effect): React's "adjust state on change" pattern.
  if (arrival && arrival.seq !== s.seq) {
    const fresh =
      muted || arrival.toTalk ? [] : arrival.items.filter((n) => !s.toasts.some((t) => t.id === n.id));
    setS({ seq: arrival.seq, toasts: [...fresh, ...s.toasts].slice(0, MAX_TOASTS) });
  }
  const dismiss = (id: string) => setS((x) => ({ ...x, toasts: x.toasts.filter((t) => t.id !== id) }));
  const talk = useTalkAbout((n) => dismiss(n.id));
  const latest = arrival?.items[0];

  return (
    <>
      {/* Mounted before anything arrives so screen readers announce the change (polite, never interrupting). */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {!latest
          ? ""
          : arrival.items.length > 1
            ? `${arrival.items.length} new notifications. Latest: ${latest.title}`
            : `New notification: ${latest.title}`}
      </div>
      {!hidden && s.toasts.length > 0 && (
        <section
          aria-label="New notifications"
          className="pointer-events-none absolute top-20 right-4 z-[9] flex w-[min(360px,calc(100%-32px))] flex-col gap-2.5"
        >
          {s.toasts.map((n) => {
            const tone = CATEGORY[n.category].tone;
            const { projectId } = n;
            const { jobId } = n.subject;
            const talkError = talk.variables?.n.id === n.id ? talk.error : null;
            return (
              <article
                key={n.id}
                aria-labelledby={`toast-${n.id}`}
                className="nx-drawer glass2 pointer-events-auto flex flex-col gap-2 rounded-[20px] border border-line px-4 py-3.5 shadow-nx"
              >
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className="size-[7px] rounded-full" style={{ background: tone }} />
                  <span className="kicker" style={{ color: tone }}>
                    {n.category}
                  </span>
                  <span className="flex-1" />
                  <span className="font-mono text-[10.5px] text-ink3">{clock(n.createdAt)}</span>
                </div>
                <span id={`toast-${n.id}`} className="text-[14px] leading-[1.35] font-medium text-ink">
                  {n.title}
                </span>
                <span className="text-[12px] leading-[1.45] text-pretty text-ink2">{n.body}</span>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => dismiss(n.id)}
                    className="rounded-[11px] border border-hair px-[11px] py-[9px] text-[12px] font-medium text-ink2"
                  >
                    Later
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      dismiss(n.id);
                      open(n);
                    }}
                    className="flex-1 rounded-[11px] border border-hair px-[11px] py-[9px] text-[12px] font-medium text-ink"
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    disabled={talk.isPending || !projectId || !jobId}
                    aria-describedby={projectId && jobId ? undefined : `toast-talk-${n.id}`}
                    onClick={() => projectId && jobId && talk.mutate({ n, projectId, jobId })}
                    className="flex-1 rounded-[11px] bg-teal px-[11px] py-[9px] text-[12px] font-medium text-onacc disabled:opacity-60"
                  >
                    Talk
                  </button>
                  <button
                    type="button"
                    onClick={() => updates.tell([n])}
                    className="rounded-[11px] border border-hair px-[11px] py-[9px] text-[12px] font-medium whitespace-nowrap text-ink"
                  >
                    Tell me
                  </button>
                </div>
                {!(projectId && jobId) && (
                  <span id={`toast-talk-${n.id}`} hidden>
                    {NOTHING_TO_TALK_ABOUT}
                  </span>
                )}
                {talkError && (
                  <p role="alert" className="m-0 text-[12px] leading-snug text-coral">
                    {talkError.message}
                  </p>
                )}
              </article>
            );
          })}
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The Cofounder's whisper and the update voice (FR-NTF-12)

const quiet =
  "rounded-[11px] border border-hair px-[11px] py-2 text-[12px] font-medium whitespace-nowrap text-ink2";
const strong = "rounded-[11px] bg-teal px-[11px] py-2 text-[12px] font-medium whitespace-nowrap text-onacc";

/** "just now", then how long ago: the whisper stays until it is opened, read or put off. */
function noticedAgo(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000);
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : `at ${clock(new Date(at).toISOString())}`;
}

/** The colour of what matters most among them: something that needs the owner first. */
const toneOf = (items: readonly Notification[]) =>
  CATEGORY[(items.find((n) => NEEDS_ME.has(n.category)) ?? items[0])!.category].tone;

/** Speaking… with Stop, "Tap to hear updates" when the browser wants a tap first, and playback problems. */
function UpdateVoiceState({ u }: { u: Updates }) {
  const status = useVoiceStatus();
  return (
    <>
      {u.speaking && (
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="nx-pulse size-[7px] flex-none rounded-full bg-teal" />
          <span role="status" className="min-w-0 flex-1 truncate font-mono text-[11px] text-teal">
            {u.speaking.loading ? "Preparing to speak" : "Speaking…"} · {voiceLabel(u.speaking, status.data)}
          </span>
          <button type="button" onClick={u.stop} className={quiet}>
            Stop
          </button>
        </div>
      )}
      {u.needsTap && (
        <button type="button" onClick={u.hear} className={`${strong} self-start`}>
          Tap to hear updates
        </button>
      )}
      {u.problem && (
        <div role="alert" className="flex items-center gap-2">
          <p className="m-0 min-w-0 flex-1 text-[12px] leading-snug text-coral">{u.problem}</p>
          <button type="button" onClick={u.clearProblem} className={quiet}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}

/**
 * "NEXUS · noticed just now" at the top of the docked Cofounder panel: what arrived, in the notification's own
 * words. Tell me says it, Open opens what it is about (several: the Inbox), Later puts it off; it stays in the Inbox.
 */
export function UpdateWhisper() {
  const u = useUpdates();
  const open = useOpenNotification();
  const navigate = route.useNavigate();
  const { keep } = useScope();
  const now = useNow(15_000);
  const w = u.whisper;
  if (!w) {
    if (!u.speaking && !u.needsTap && !u.problem) return null;
    return (
      <section
        aria-label="Spoken updates"
        className="flex flex-none flex-col gap-2 border-b border-hair px-4 py-3"
      >
        <UpdateVoiceState u={u} />
      </section>
    );
  }
  const [first] = w.items;
  const tone = toneOf(w.items);
  const openIt = () => {
    u.dismiss();
    if (w.items.length === 1 && first) open(first);
    else void navigate({ search: { ...keep, drawer: "inbox" } });
  };
  return (
    <section
      aria-label="NEXUS noticed"
      className="nx-drawer flex flex-none flex-col gap-2 border-b border-hair px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="size-[7px] flex-none rounded-full" style={{ background: tone }} />
        <span className="kicker" style={{ color: tone }}>
          NEXUS · noticed {noticedAgo(w.at, now)}
        </span>
      </div>
      {w.items.length === 1 && first ? (
        <>
          <p className="m-0 text-[14px] leading-[1.35] font-medium text-ink">{first.title}</p>
          <p className="m-0 line-clamp-2 text-[12px] leading-[1.45] text-pretty text-ink2">{first.body}</p>
        </>
      ) : (
        <p className="m-0 line-clamp-3 text-[13.5px] leading-[1.4] text-ink">
          <span className="font-medium">{w.items.length} updates:</span>{" "}
          {w.items.map((n) => n.title).join(" · ")}
        </p>
      )}
      <UpdateVoiceState u={u} />
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => u.tell(w.items)} className={strong}>
          Tell me
        </button>
        <button type="button" onClick={openIt} className={`${quiet} text-ink`}>
          {w.items.length === 1 ? "Open" : "Open Inbox"}
        </button>
        <button type="button" onClick={u.dismiss} className={quiet}>
          Later
        </button>
      </div>
    </section>
  );
}

/** Where the update voice shows when the Cofounder panel isn't docked: above the phone's bottom nav. */
export function UpdateVoiceBar() {
  const u = useUpdates();
  if (!u.speaking && !u.needsTap && !u.problem) return null;
  return (
    <section
      aria-label="Spoken updates"
      className="glass2 pointer-events-auto absolute right-4 bottom-[calc(76px+env(safe-area-inset-bottom))] left-4 z-[9] flex flex-col gap-2 rounded-[18px] border border-line px-4 py-3 shadow-nx md:bottom-4 md:left-auto md:w-[360px]"
    >
      <UpdateVoiceState u={u} />
    </section>
  );
}

/**
 * An update said inside a voice conversation: an observed line from NEXUS's records (not a model turn), with the
 * notifications it comes from as sources.
 */
export function NoticedItem({ items, at }: { items: readonly Notification[]; at: number }) {
  const open = useOpenNotification();
  const [first] = items;
  if (!first) return null;
  return (
    <li className="flex flex-col items-start gap-1.5">
      <span className="flex items-center gap-2 font-mono text-[10.5px] text-ink3">
        NEXUS · noticed {clock(new Date(at).toISOString())}
        <span
          className="rounded-full border px-1.5 py-0.5"
          style={{ borderColor: "var(--green)", color: "var(--green)" }}
          title="From NEXUS's own records"
        >
          observed
        </span>
      </span>
      <p className="m-0 max-w-[min(560px,92%)] rounded-[18px_18px_18px_6px] border border-hair px-4 py-3 text-[14px] leading-[1.55] break-words text-ink">
        {items.length === 1 ? (
          <>
            <span className="font-medium">{first.title}</span>
            <br />
            <span className="text-ink2">{first.body}</span>
          </>
        ) : (
          <>
            <span className="font-medium">{items.length} updates:</span>{" "}
            {items.map((n) => n.title).join(" · ")}
          </>
        )}
      </p>
      <ul aria-label="Sources" className="m-0 flex max-w-[560px] list-none flex-wrap gap-1.5 p-0">
        {items.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => open(n)}
              className="inline-flex max-w-[300px] items-center rounded-full border border-hair px-2 py-1 font-mono text-[10.5px] leading-tight text-ink2 underline"
            >
              <span className="truncate">notification · {n.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </li>
  );
}
