import type {
  NotificationCategory,
  NotificationPreferences,
  PushPayload,
  QuietHours,
  WorkspaceMode,
} from "@nexus/contracts";

// Pure rules of slice A: quiet hours, what bypasses them, and where a push opens the app.

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The wall-clock minute of the day at `at` in `timezone` (IANA). */
export function localMinute(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/** Inside [start, end) of the owner's local day; a window like 22:00–07:00 wraps past midnight. */
export function isQuietAt(q: QuietHours, at: Date): boolean {
  if (!q.enabled) return false;
  const m = localMinute(at, q.timezone);
  const start = minutes(q.start);
  const end = minutes(q.end);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** Urgent: pushed with high urgency and, with `urgentBypass`, through quiet hours. */
export const isUrgent = (category: NotificationCategory, q: QuietHours) =>
  category === "SECURITY_CRITICAL" || (category === "APPROVAL_REQUIRED" && q.approvalsUrgent);

export const bypassesQuiet = (category: NotificationCategory, q: QuietHours) =>
  q.urgentBypass && isUrgent(category, q);

export const pushOn = (p: NotificationPreferences, category: NotificationCategory) =>
  p.categories[category].push;

type LinkSubject = {
  projectId: string | null;
  jobId: string | null;
  incidentId: string | null;
  planId: string | null;
  deepDiveId: string | null;
  researchRunId: string | null;
};

/**
 * Where a notification opens (the board's `drawer=` deep links, router.tsx BoardSearch), in its own workspace and
 * project so it can be decided there. Anything without its own drawer opens the Inbox.
 */
export function deepLink(n: LinkSubject, mode: WorkspaceMode | null): string {
  const drawer = n.jobId
    ? `run:${n.jobId}`
    : n.incidentId
      ? `incident:${n.incidentId}`
      : n.planId
        ? `plan:${n.planId}`
        : n.deepDiveId
          ? `research:${n.deepDiveId}`
          : n.researchRunId
            ? "research"
            : "inbox";
  const q = new URLSearchParams();
  if (n.projectId && mode) {
    q.set("ws", mode === "DEV" ? "dev" : "business");
    q.set("project", n.projectId);
  }
  q.set("drawer", drawer);
  return `/?${q.toString()}`;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export const DIGEST_LIST_MAX = 5;

/** One push for everything held during quiet hours, oldest first. */
export function digestPayload(titles: string[], digestKey: string): PushPayload {
  const n = titles.length;
  const shown = titles.slice(0, DIGEST_LIST_MAX).map((t) => `• ${clip(t, 120)}`);
  if (n > DIGEST_LIST_MAX) shown.push(`+${n - DIGEST_LIST_MAX} more in the Inbox`);
  return {
    title: `While you were in quiet hours · ${n} ${n === 1 ? "update" : "updates"}`,
    body: shown.join("\n"),
    url: "/?drawer=inbox",
    tag: `digest-${digestKey}`.slice(0, 64),
  };
}

export const TEST_PAYLOAD = (label: string): PushPayload => ({
  title: "NEXUS test push",
  body: `Push works on ${clip(label, 60)}. Alerts you opt into in Settings → Notifications arrive here.`,
  url: "/?drawer=settings#notif",
  tag: "nexus-test",
});
