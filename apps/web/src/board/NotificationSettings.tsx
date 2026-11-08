import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ALWAYS_IN_APP,
  NotificationCategory,
  QuietHours,
  type NotificationPreferences,
  type PushDevice,
  type PushService,
} from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import {
  pushEnv,
  pushUnavailable,
  subscribeThisBrowser,
  thisBrowserEndpointHash,
  unsubscribeThisBrowser,
  type PushEnv,
} from "../lib/push.ts";
import { ago, useNow } from "../lib/queries.ts";
import { DrawerState } from "./Drawer.tsx";
import { Badge, Row, Rows, Switch, rowBtn, useOpenSettings } from "./Settings.tsx";

// Settings → Notifications (P1 wave 4 slice A, FR-NTF-03/07/09/10/11): which devices get pushes, which categories go
// where, and quiet hours. Pushes carry the Inbox's redacted text and open the right drawer after sign-in.

const CATEGORY: Record<NotificationCategory, [string, string]> = {
  APPROVAL_REQUIRED: ["Approvals waiting", "a run is ready for your review"],
  TASK_DONE: ["Finished work", "runs, plans and deep dives that completed; draft PRs opened"],
  TASK_FAILED: ["Failures", "failed runs, runs needing recovery, budget stops, incidents"],
  BUSINESS_EXCEPTION: ["Business alerts", "incidents in business apps"],
  SECURITY_CRITICAL: ["Security", "emergency stop, runner revoked"],
  INFORMATIONAL: ["Updates", "research briefs, approvals that expired"],
};
const SERVICE: Record<PushService, string> = {
  APPLE: "Apple push",
  GOOGLE: "Google push",
  MOZILLA: "Mozilla push",
  MICROSOFT: "Microsoft push",
};
const STATUS: Record<PushDevice["status"], [string, string]> = {
  ACTIVE: ["on", "var(--green)"],
  REVOKED: ["revoked", "var(--ink3)"],
  GONE: ["gone", "var(--amber)"],
};
const field = "rounded-xl border border-line bg-card px-3 py-2 font-mono text-[13px] text-ink";
const primary =
  "rounded-xl bg-teal px-4 py-2 text-[12.5px] font-medium text-onacc disabled:opacity-60 whitespace-nowrap";

export function NotificationSettings() {
  const [env] = useState(pushEnv);
  const devices = useQuery({ queryKey: keys.devices, queryFn: api.devices });
  const prefs = useQuery({ queryKey: keys.notificationPreferences, queryFn: api.notificationPreferences });
  return (
    <>
      <p className="m-0 flex-none text-[14px] leading-[1.55] text-pretty text-ink2">
        NEXUS tells your phone when something needs you or finishes: approvals, draft PRs, failed runs,
        incidents, finished plans and budget stops. A paired watch shows what the phone shows. A push carries
        the same redacted title and text as the Inbox and opens the right drawer after you sign in. Approvals
        are still decided on the phone or here.
      </p>
      {devices.data ? <Devices list={devices.data} env={env} /> : <DrawerState error={devices.error} />}
      {prefs.data ? <Preferences prefs={prefs.data} /> : <DrawerState error={prefs.error} />}
    </>
  );
}

function Devices({ list, env }: { list: Awaited<ReturnType<typeof api.devices>>; env: PushEnv }) {
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const unavailable = pushUnavailable(env);
  const mine = useQuery({
    queryKey: [...keys.devices, "this-browser"],
    queryFn: thisBrowserEndpointHash,
    enabled: !unavailable && !list.problem,
  });
  const [confirm, setConfirm] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.devices });

  const test = useMutation({
    mutationFn: (id: string) => api.testPush(id, crypto.randomUUID()),
    onSuccess: () => {
      // The push goes out on the next pass; the row then shows "last push" or the error.
      setTimeout(() => void refresh(), 4000);
    },
  });
  const revoke = useMutation({
    mutationFn: async (d: PushDevice) => {
      const revoked = await api.revokeDevice(d.id);
      if (d.endpointHash === mine.data) await unsubscribeThisBrowser().catch(() => {});
      return revoked;
    },
    onSuccess: () => setConfirm(null),
    onSettled: () => void refresh(),
  });
  const thisDevice = list.items.find((d) => d.status === "ACTIVE" && d.endpointHash === mine.data);
  const shown = list.items.filter((d) => d.status !== "REVOKED");

  return (
    <>
      <section aria-label="This device" className="flex flex-none flex-col gap-2">
        <h3 className="kicker m-0">This device</h3>
        {list.problem ? (
          <div role="alert" className="flex flex-col gap-1 rounded-[18px] bg-hair p-4">
            <span className="text-[13.5px] font-medium text-coral">
              Push isn't available on the home machine
            </span>
            <span className="text-[12.5px] leading-snug text-ink2">{list.problem}</span>
          </div>
        ) : unavailable ? (
          <div className="flex flex-col gap-1 rounded-[18px] bg-hair p-4">
            <span className="text-[13.5px] font-medium">Push can't be turned on in this browser</span>
            <span className="text-[12.5px] leading-snug text-ink2">{unavailable}</span>
          </div>
        ) : thisDevice ? (
          <p role="status" className="m-0 rounded-[18px] bg-hair p-4 text-[13px] leading-snug text-ink2">
            Push is on for this device as <strong className="text-ink">{thisDevice.label}</strong>.
          </p>
        ) : (
          <EnableHere vapidKey={list.vapidPublicKey!} onDone={() => void refresh()} />
        )}
      </section>
      <Rows label="Devices that get pushes">
        {shown.length === 0 && (
          <Row
            title="No devices yet"
            meta="Open NEXUS on your phone (installed to the Home Screen) and turn push on in this tab."
          />
        )}
        {shown.map((d) => (
          <Row
            key={d.id}
            title={`${d.label}${d.id === thisDevice?.id ? " · this device" : ""}`}
            meta={`${SERVICE[d.service]} · added ${ago(d.createdAt, now)} · last push ${ago(d.lastSentAt, now)}${d.lastError ? ` · ${d.lastError}` : ""}`}
            badge={<Badge tone={STATUS[d.status][1]}>{STATUS[d.status][0]}</Badge>}
          >
            {confirm === d.id ? (
              <span className="flex gap-1.5">
                <button type="button" onClick={() => setConfirm(null)} className={rowBtn}>
                  Keep
                </button>
                <button
                  type="button"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(d)}
                  aria-label={`Confirm revoke ${d.label}`}
                  className={`${rowBtn} text-coral`}
                >
                  Confirm revoke
                </button>
              </span>
            ) : (
              <span className="flex gap-1.5">
                {d.status === "ACTIVE" && (
                  <button
                    type="button"
                    disabled={test.isPending}
                    onClick={() => test.mutate(d.id)}
                    aria-label={`Send a test push to ${d.label}`}
                    className={rowBtn}
                  >
                    Test push
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setConfirm(d.id)}
                  aria-label={`Revoke ${d.label}`}
                  className={rowBtn}
                >
                  Revoke
                </button>
              </span>
            )}
          </Row>
        ))}
      </Rows>
      {test.isSuccess && (
        <p role="status" className="m-0 text-[12.5px] text-green">
          Test push queued. It should arrive within a few seconds; if it doesn't, the device row shows why.
        </p>
      )}
      {(test.error ?? revoke.error) && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {(test.error ?? revoke.error)!.message}
        </p>
      )}
    </>
  );
}

function EnableHere({ vapidKey, onDone }: { vapidKey: string; onDone: () => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [touched, setTouched] = useState(false);
  const invalid = touched && label.trim().length === 0;
  const enable = useMutation({
    mutationFn: async (name: string) =>
      api.subscribeDevice({ label: name, subscription: await subscribeThisBrowser(vapidKey) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...keys.devices, "this-browser"] });
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (label.trim()) enable.mutate(label.trim());
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2 rounded-[18px] border border-hair p-4">
      <label htmlFor={id} className="text-[13.5px] font-medium">
        Name this device
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          value={label}
          maxLength={60}
          placeholder="My iPhone"
          aria-invalid={invalid}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setLabel(e.target.value)}
          className={`${field} min-w-0 flex-1`}
        />
        <button type="submit" disabled={enable.isPending} className={primary}>
          {enable.isPending ? "Turning on…" : "Turn on push"}
        </button>
      </div>
      <span id={`${id}-hint`} className={`text-[12px] ${invalid ? "text-coral" : "text-ink3"}`}>
        {invalid
          ? "Give the device a name, so you can tell it apart later."
          : "Your browser asks to allow notifications. The name is yours; NEXUS never reads it from the device."}
      </span>
      {enable.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {enable.error.message}
        </p>
      )}
    </form>
  );
}

function Preferences({ prefs }: { prefs: NotificationPreferences }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (body: NotificationPreferences) => api.updateNotificationPreferences(body),
    onSuccess: (p) => {
      queryClient.setQueryData(keys.notificationPreferences, p);
      void queryClient.invalidateQueries({ queryKey: keys.notifications });
    },
  });
  const setChannel = (c: NotificationCategory, ch: "inApp" | "push", on: boolean) =>
    save.mutate({ ...prefs, categories: { ...prefs.categories, [c]: { ...prefs.categories[c], [ch]: on } } });

  return (
    <>
      <Rows label="What goes where">
        {NotificationCategory.options.map((c) => {
          const locked = ALWAYS_IN_APP.includes(c);
          return (
            <li
              key={c}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-hair px-4 py-[13px] last:border-b-0"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-[13.5px] leading-[1.3] font-medium">{CATEGORY[c][0]}</span>
                <span className="text-[12px] leading-[1.4] text-ink3">
                  {CATEGORY[c][1]}
                  {locked && " · always in the Inbox"}
                </span>
              </div>
              <span className="flex items-center gap-3 font-mono text-[11px] text-ink3">
                <span className="flex flex-col items-center gap-1">
                  Inbox
                  <Switch
                    label={`${CATEGORY[c][0]} in the Inbox`}
                    on={prefs.categories[c].inApp}
                    disabled={locked || save.isPending}
                    onChange={(on) => setChannel(c, "inApp", on)}
                  />
                </span>
                <span className="flex flex-col items-center gap-1">
                  Push
                  <Switch
                    label={`${CATEGORY[c][0]} as push`}
                    on={prefs.categories[c].push}
                    disabled={save.isPending}
                    onChange={(on) => setChannel(c, "push", on)}
                  />
                </span>
              </span>
            </li>
          );
        })}
      </Rows>
      <QuietHoursForm
        prefs={prefs}
        save={(q) => save.mutate({ ...prefs, quietHours: q })}
        saving={save.isPending}
      />
      {save.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {save.error.message}
        </p>
      )}
      {save.isSuccess && (
        <p role="status" className="m-0 text-[12.5px] text-green">
          Saved.
        </p>
      )}
    </>
  );
}

/**
 * The Inbox's notify-policy footer: where these notices also go. Silent until both answers are in (an error here
 * must never cover the Inbox itself).
 */
export function NotifyPolicy() {
  const openSettings = useOpenSettings();
  const devices = useQuery({ queryKey: keys.devices, queryFn: api.devices });
  const prefs = useQuery({ queryKey: keys.notificationPreferences, queryFn: api.notificationPreferences });
  if (!devices.data || !prefs.data) return null;
  const active = devices.data.items.filter((d) => d.status === "ACTIVE").length;
  const q = prefs.data.quietHours;
  const text =
    active === 0
      ? "Phone push is off: no device is set up."
      : `Also pushed to ${active} ${active === 1 ? "device" : "devices"}${q.enabled ? ` · quiet ${q.start}–${q.end} (${q.timezone}), then one summary` : ""}.`;
  return (
    <p className="m-0 mt-auto flex flex-none flex-wrap items-center gap-x-2 gap-y-1 border-t border-hair pt-3 text-[12px] text-ink3">
      <span>{text}</span>
      <button type="button" onClick={() => openSettings("notif")} className="font-medium text-teal underline">
        {active === 0 ? "Set up push" : "Change"}
        <span className="sr-only"> in Settings → Notifications</span>
      </button>
    </p>
  );
}

function QuietHoursForm({
  prefs,
  save,
  saving,
}: {
  prefs: NotificationPreferences;
  save: (q: QuietHours) => void;
  saving: boolean;
}) {
  const id = useId();
  const [q, setQ] = useState(prefs.quietHours);
  const parsed = QuietHours.safeParse(q);
  const problem = parsed.success ? null : parsed.error.issues[0]!.message;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (parsed.success) save(parsed.data);
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Quiet hours"
      className="flex flex-none flex-col gap-3 rounded-[18px] border border-hair p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col gap-1">
          <span className="text-[13.5px] font-medium">Quiet hours</span>
          <span className="text-[12px] text-ink3">
            {q.enabled
              ? `Pushes wait until ${q.end}, then arrive as one summary.`
              : "Off: pushes arrive as they happen."}
          </span>
        </span>
        <Switch
          label="Quiet hours"
          on={q.enabled}
          disabled={saving}
          onChange={(on) => setQ({ ...q, enabled: on })}
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-ink2">
          From
          <input
            type="time"
            value={q.start}
            onChange={(e) => setQ({ ...q, start: e.target.value })}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink2">
          Until
          <input
            type="time"
            value={q.end}
            onChange={(e) => setQ({ ...q, end: e.target.value })}
            className={field}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[12px] text-ink2">
          Time zone
          <input
            value={q.timezone}
            aria-describedby={`${id}-tz`}
            onChange={(e) => setQ({ ...q, timezone: e.target.value.trim() })}
            className={field}
          />
        </label>
      </div>
      <span id={`${id}-tz`} className="text-[12px] text-ink3">
        An IANA name such as Asia/Dubai or Europe/Vienna.
      </span>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px]">Security notices still come through</span>
        <Switch
          label="Security notices still come through"
          on={q.urgentBypass}
          disabled={saving}
          onChange={(on) => setQ({ ...q, urgentBypass: on })}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px]">Approvals come through too</span>
        <Switch
          label="Approvals come through too"
          on={q.approvalsUrgent}
          disabled={saving || !q.urgentBypass}
          onChange={(on) => setQ({ ...q, approvalsUrgent: on })}
        />
      </div>
      {problem && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {problem}
        </p>
      )}
      <button type="submit" disabled={saving || !parsed.success} className={`${primary} self-start`}>
        {saving ? "Saving…" : "Save quiet hours"}
      </button>
    </form>
  );
}
