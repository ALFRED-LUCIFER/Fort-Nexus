import { useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Notification, NotificationCategory } from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { clock, useNotifications, useWorkspaces } from "../lib/queries.ts";
import { useScope, type Scope } from "./scope.tsx";

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
    // The run lives in its own project: open it there so its approval can be decided.
    void navigate({
      search: { ...keepOf(n), drawer: n.subject.jobId ? `run:${n.subject.jobId}` : "settings" },
    });
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

type ToastState = { key: string; at: number; seen: Map<string, Set<string>>; toasts: Notification[] };

/**
 * New notifications as toasts (design: Later / Open / Talk). What was already there when a scope's list first
 * loaded is the inbox's business; after that each new UNREAD one toasts once, however often it is polled.
 */
export function NotificationToasts({ hidden }: { hidden: boolean }) {
  const scope = useScope();
  const q = useNotifications(scope.project?.id, scope.ready);
  const open = useOpenNotification();
  const key = scope.project?.id ?? "all";
  const [s, setS] = useState<ToastState>({ key, at: 0, seen: new Map(), toasts: [] });

  // Derived from each new poll result during render (no effect): React's "adjust state on change" pattern.
  if (q.data && (s.key !== key || s.at !== q.dataUpdatedAt)) {
    const known = s.seen.get(key);
    const ids = q.data.items.map((n) => n.id);
    const fresh = known
      ? q.data.items.filter(
          (n) => n.status === "UNREAD" && !known.has(n.id) && !s.toasts.some((t) => t.id === n.id),
        )
      : [];
    setS({
      key,
      at: q.dataUpdatedAt,
      seen: new Map(s.seen).set(key, new Set([...(known ?? []), ...ids])),
      toasts: [...fresh, ...s.toasts].slice(0, MAX_TOASTS),
    });
  }
  const dismiss = (id: string) => setS((x) => ({ ...x, toasts: x.toasts.filter((t) => t.id !== id) }));
  const talk = useTalkAbout((n) => dismiss(n.id));
  const latest = s.toasts[0];

  return (
    <>
      {/* Mounted before anything arrives so screen readers announce the change (polite, never interrupting). */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {latest ? `New notification: ${latest.title}` : ""}
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
