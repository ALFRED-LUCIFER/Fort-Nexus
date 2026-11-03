import { useId, useState, type FormEvent, type ReactNode } from "react";
import { getRouteApi, useLocation } from "@tanstack/react-router";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import {
  SetDailyBudgetRequest,
  VoiceSettings,
  type OwnerSession,
  type Runner,
  type SystemControls,
  type UpdateVoiceSettingsRequest,
} from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { RUNNER_TONE, ago, until, useNow, useRunners, useSystem } from "../lib/queries.ts";
import { AgentProfilesSettings } from "./agents.tsx";
import { AutomationsSettings } from "./AutomationsSettings.tsx";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";
import { useVoiceStatus } from "./voice.tsx";
import { WorkspacesSettings } from "./WorkspacesSettings.tsx";

const route = getRouteApi("/");

// Design dSettings tabs. Security & devices, Workspaces, Automations, Agent profiles, Budgets & limits and Voice &
// consent are real; the rest say honestly what exists. `#voice` opens on Voice & consent (the mic links there).
const TABS = [
  ["conn", "Connections"],
  ["ws", "Workspaces"],
  ["auto", "Automations"],
  ["profiles", "Agent profiles"],
  ["sec", "Security & devices"],
  ["remote", "Remote access"],
  ["limits", "Budgets & limits"],
  ["backup", "Backups"],
  ["notif", "Notifications"],
  ["voice", "Voice & consent"],
  ["audit", "Audit log"],
  ["privacy", "Data & privacy"],
  ["system", "System health"],
] as const;
type Tab = (typeof TABS)[number][0];

const LATER: Record<Exclude<Tab, "sec" | "limits" | "ws" | "auto" | "profiles" | "voice">, string> = {
  conn: "Managing connections here arrives in P1. Today the only connection is the NEXUS GitHub App, set up on the home machine.",
  remote:
    "Remote access is configured on the home machine (Tailscale Serve, see the runbook). Managing it here arrives in P1.",
  backup: "Backups run on the home machine (see the backup runbook). Viewing them here arrives in P1.",
  notif: "Notification settings arrive in P1. Approvals already show in the Inbox.",
  audit:
    "Every action is already recorded in the append-only audit log on the home machine. Browsing it here arrives in P1.",
  privacy: "Data-sharing controls arrive in P1 with business connectors.",
  system: "System health arrives in P1. Runner status is in the Systems zone.",
};

const seg = (on: boolean) =>
  `rounded-[10px] px-3 py-[9px] text-[12px] font-medium leading-none whitespace-nowrap ${on ? "bg-glass2 text-ink shadow-[0_1px_3px_rgba(0,0,0,.12)]" : "text-ink3"}`;
const rowBtn =
  "rounded-[11px] border border-hair px-[11px] py-2 text-[12px] font-medium whitespace-nowrap text-ink disabled:opacity-60";

export function SettingsDrawer({ banner, onClose }: { banner?: ReactNode; onClose: () => void }) {
  const hash = useLocation({ select: (l) => l.hash });
  const [tab, setTab] = useState<Tab>(() => (hash.replace(/^#/, "") === "voice" ? "voice" : "sec"));
  return (
    <Drawer banner={banner} onClose={onClose}>
      <DrawerHeader kicker="Settings · owner" title="Settings" />
      <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-6 pt-5 pb-6">
        <div
          role="group"
          aria-label="Settings section"
          className="flex flex-none flex-wrap gap-1 rounded-[14px] bg-hair p-1"
        >
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
              className={seg(tab === id)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "sec" ? (
          <Security />
        ) : tab === "limits" ? (
          <Limits />
        ) : tab === "ws" ? (
          <WorkspacesSettings />
        ) : tab === "auto" ? (
          <AutomationsSettings />
        ) : tab === "profiles" ? (
          <AgentProfilesSettings />
        ) : tab === "voice" ? (
          <VoiceConsent />
        ) : (
          <p className="m-0 flex-none text-[14px] leading-[1.55] text-pretty text-ink2">{LATER[tab]}</p>
        )}
      </div>
    </Drawer>
  );
}

function Rows({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-none flex-col gap-2">
      <h3 className="kicker m-0">{label}</h3>
      <ul className="m-0 list-none overflow-hidden rounded-[18px] border border-hair p-0">{children}</ul>
    </section>
  );
}

function Row({
  title,
  meta,
  badge,
  children,
}: {
  title: string;
  meta: string;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-hair px-4 py-[13px] last:border-b-0">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-[13.5px] leading-[1.3] font-medium">{title}</span>
        <span className="truncate font-mono text-[11.5px] leading-[1.4] text-ink3">{meta}</span>
      </div>
      <span>{badge}</span>
      <span>{children}</span>
    </li>
  );
}

const Badge = ({ tone, children }: { tone: string; children: ReactNode }) => (
  <span
    className="rounded-full px-2 py-[5px] font-mono text-[10px] leading-none whitespace-nowrap"
    style={{ color: tone, background: "var(--hair)" }}
  >
    {children}
  </span>
);

/** "Chrome on Mac" from a user agent; the full string stays in the title attribute. */
function device(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /iPhone|iPad/.test(ua)
    ? "iPhone/iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Macintosh|Mac OS X/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "unknown OS";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  return `${browser} on ${os}`;
}

function Security() {
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const sessions = useQuery({ queryKey: keys.sessions, queryFn: api.sessions });
  const runners = useRunners();
  const [confirmRunner, setConfirmRunner] = useState<string | null>(null);

  const revokeSession = useMutation({
    mutationFn: (s: OwnerSession) => api.revokeSession(s.id),
    onSuccess: async (_r, s) => {
      if (!s.current) return void queryClient.invalidateQueries({ queryKey: keys.sessions });
      // Revoking this browser's own session is signing out.
      queryClient.clear();
      await navigate({ to: "/login" });
    },
  });
  const revokeRunner = useMutation({
    mutationFn: (id: string) => api.revokeRunner(id),
    onSuccess: () => setConfirmRunner(null),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.runners }),
  });

  return (
    <>
      <p className="m-0 flex-none text-[14px] leading-[1.55] text-ink2">
        Who and what can act. Revoking a session signs that browser out; revoking a runner stops it taking
        work until it is paired again. Both are audited.
      </p>
      {sessions.data ? (
        <Rows label="Signed-in browsers">
          {sessions.data.map((s) => (
            <Row
              key={s.id}
              title={device(s.userAgent)}
              meta={`${s.ipAddress ?? "unknown address"} · signed in ${ago(s.createdAt, now)} · expires ${until(s.expiresAt, now)}`}
              badge={s.current && <Badge tone="var(--green)">this browser</Badge>}
            >
              <button
                type="button"
                disabled={revokeSession.isPending}
                onClick={() => revokeSession.mutate(s)}
                aria-label={`${s.current ? "Sign out" : "Revoke"} ${device(s.userAgent)}`}
                className={rowBtn}
              >
                {s.current ? "Sign out" : "Revoke"}
              </button>
            </Row>
          ))}
        </Rows>
      ) : (
        <DrawerState error={sessions.error} />
      )}
      {revokeSession.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {revokeSession.error.message}
        </p>
      )}
      {runners.data ? (
        <Rows label="Paired runners">
          {runners.data.length === 0 && (
            <Row title="No runner paired" meta="Pair one from the Systems zone." />
          )}
          {runners.data.map((r: Runner) => (
            <Row
              key={r.id}
              title={r.name}
              meta={`${r.os} · v${r.version} · last heartbeat ${ago(r.lastHeartbeatAt, now)}`}
              badge={<Badge tone={RUNNER_TONE[r.status]}>{r.status.toLowerCase()}</Badge>}
            >
              {r.status !== "REVOKED" &&
                (confirmRunner === r.id ? (
                  <span className="flex gap-1.5">
                    <button type="button" onClick={() => setConfirmRunner(null)} className={rowBtn}>
                      Keep
                    </button>
                    <button
                      type="button"
                      disabled={revokeRunner.isPending}
                      onClick={() => revokeRunner.mutate(r.id)}
                      aria-label={`Confirm revoke ${r.name}`}
                      className={`${rowBtn} text-coral`}
                    >
                      Confirm revoke
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Revoke ${r.name}`}
                    onClick={() => setConfirmRunner(r.id)}
                    className={rowBtn}
                  >
                    Revoke
                  </button>
                ))}
            </Row>
          ))}
        </Rows>
      ) : (
        <DrawerState error={runners.error} />
      )}
      {revokeRunner.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {revokeRunner.error.message}
        </p>
      )}
    </>
  );
}

const money = (n: number) => `$${n.toFixed(2)}`;

function Limits() {
  const system = useSystem();
  if (!system.data) return <DrawerState error={system.error} />;
  const b = system.data.budget;
  const pct = Math.min(100, (b.spentTodayUsd / b.dailyCapUsd) * 100);
  const resets = new Date(b.resetsAt).toLocaleString([], {
    timeZone: b.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return (
    <>
      <p className="m-0 flex-none text-[14px] leading-[1.55] text-ink2">
        Hard ceilings so nothing runs away while you are not looking.
      </p>
      <div className="flex flex-none flex-col gap-2.5 rounded-[18px] bg-hair p-4">
        <div className="flex justify-between gap-3 font-mono text-[12px] text-ink2">
          <span id="spend-label">Today's AI spend · estimate</span>
          <span>
            {money(b.spentTodayUsd)} / {money(b.dailyCapUsd)}
          </span>
        </div>
        <span
          role="meter"
          aria-labelledby="spend-label"
          aria-valuemin={0}
          aria-valuemax={b.dailyCapUsd}
          aria-valuenow={b.spentTodayUsd}
          aria-valuetext={`${money(b.spentTodayUsd)} of ${money(b.dailyCapUsd)}`}
          className="h-2.5 overflow-hidden rounded-[5px] bg-hair"
        >
          <span
            className="block h-full rounded-[5px]"
            style={{
              width: `${pct}%`,
              background: b.exhausted ? "var(--coral)" : pct >= 80 ? "var(--amber)" : "var(--teal)",
            }}
          />
        </span>
        <span className="font-mono text-[11.5px] text-ink3">
          resets {resets} ({b.timezone}) · provider-reported estimates, not an invoice
        </span>
        {b.exhausted && (
          <p role="status" className="m-0 text-[12.5px] text-coral">
            Today's cap is used up. New issue runs are refused until it resets or you raise it.
          </p>
        )}
      </div>
      <BudgetEditor current={b.dailyCapUsd} />
      <p className="m-0 flex-none text-[12.5px] leading-[1.5] text-ink3">
        Each issue run also has its own cost cap (default $5, at most $50), set when you start it. A run is
        refused when its cap doesn't fit in what is left today, and never gets more than what is left.
      </p>
    </>
  );
}

function BudgetEditor({ current }: { current: number }) {
  const queryClient = useQueryClient();
  const id = useId();
  const [value, setValue] = useState(String(current));
  const [touched, setTouched] = useState(false);
  const parsed = SetDailyBudgetRequest.safeParse({ dailyCapUsd: value.trim() === "" ? NaN : Number(value) });
  const invalid = touched && (!parsed.success || Math.round(parsed.data.dailyCapUsd * 100) < 1);
  const save = useMutation({
    mutationFn: (usd: number) => api.setDailyBudget(usd),
    onSuccess: (s) => queryClient.setQueryData<SystemControls>(keys.system, s),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (parsed.success && Math.round(parsed.data.dailyCapUsd * 100) >= 1)
      save.mutate(parsed.data.dailyCapUsd);
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-none flex-col gap-2 rounded-[18px] border border-hair p-4"
    >
      <label htmlFor={id} className="text-[13.5px] font-medium">
        Daily AI budget (USD)
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min="0.01"
          max="1000"
          step="0.01"
          value={value}
          aria-invalid={invalid}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            setValue(e.target.value);
            save.reset();
          }}
          className="w-36 rounded-xl border border-line bg-card px-3 py-2 font-mono text-[13px]"
        />
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-xl bg-teal px-4 py-2 text-[12.5px] font-medium text-onacc disabled:opacity-60"
        >
          {save.isPending ? "Saving…" : "Save cap"}
        </button>
      </div>
      <span id={`${id}-hint`} className={`text-[12px] ${invalid ? "text-coral" : "text-ink3"}`}>
        {invalid
          ? "Enter an amount from $0.01 to $1000."
          : "Whole cents, up to $1000 a day. The change is audited."}
      </span>
      {save.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {save.error.message}
        </p>
      )}
      {save.isSuccess && (
        <p role="status" className="m-0 text-[12.5px] text-green">
          Saved: {money(save.data.budget.dailyCapUsd)} a day.
        </p>
      )}
    </form>
  );
}

const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
const LANGUAGES: [string, string][] = [
  ["auto", "Detect automatically"],
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["de-DE", "German"],
  ["fr-FR", "French"],
  ["es-ES", "Spanish"],
  ["it-IT", "Italian"],
  ["nl-NL", "Dutch"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["ar-AE", "Arabic (UAE)"],
  ["hi-IN", "Hindi"],
  ["ja-JP", "Japanese"],
];

function Switch({
  label,
  on,
  disabled,
  onChange,
}: {
  label: string;
  on: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`flex h-7 w-12 items-center rounded-full p-[3px] disabled:opacity-60 ${on ? "justify-end bg-teal" : "justify-start bg-hair"}`}
    >
      <span
        aria-hidden="true"
        className="size-[22px] rounded-full bg-card shadow-[0_1px_3px_rgba(0,0,0,.2)]"
      />
    </button>
  );
}

/**
 * Voice & consent (FR-CSP-02/05): who hears the audio, what they keep, and the owner's switches. The mic and spoken
 * replies are turned on and off separately; the disclosure sits above the switch that turns the mic on.
 */
function VoiceConsent() {
  const queryClient = useQueryClient();
  const status = useVoiceStatus();
  const save = useMutation({
    mutationFn: (body: UpdateVoiceSettingsRequest) => api.updateVoiceSettings(body),
    onSuccess: (s) => queryClient.setQueryData(keys.voice, s),
  });
  if (!status.data) return <DrawerState error={status.error} />;
  const v = status.data;
  const s = v.settings;
  const set = (body: UpdateVoiceSettingsRequest) => save.mutate(body);
  const rates = RATES.includes(s.speechRate) ? RATES : [...RATES, s.speechRate].sort((a, b) => a - b);
  const languages = LANGUAGES.some(([l]) => l === s.language)
    ? LANGUAGES
    : [...LANGUAGES, [s.language, s.language]];
  const select =
    "rounded-lg border border-hair bg-hair px-2 py-1.5 font-mono text-[12px] text-ink disabled:opacity-60";

  return (
    <>
      <p className="m-0 flex-none text-[14px] leading-[1.55] text-ink2">
        Voice is a channel, not a bypass. The mic opens only when you press it, what you said waits in the
        input until you send it, and anything that changes something still needs your on-screen confirm.
      </p>
      {v.problem ? (
        <div role="alert" className="flex flex-none flex-col gap-1 rounded-[18px] bg-hair p-4">
          <span className="text-[13.5px] font-medium text-coral">
            The voice setup on the home machine has a problem
          </span>
          <span className="text-[12.5px] leading-snug text-ink2">{v.problem}</span>
          <span className="font-mono text-[11.5px] text-ink3">see {v.runbook}</span>
        </div>
      ) : (
        !v.configured && (
          <div className="flex flex-none flex-col gap-1 rounded-[18px] bg-hair p-4">
            <span className="text-[13.5px] font-medium">Voice isn't set up on the home machine</span>
            <span className="text-[12.5px] leading-snug text-ink2">
              Follow {v.runbook} to connect your Foundry resource. Until then nothing is recorded or sent
              anywhere; replies can still be read aloud by this browser's own voice.
            </span>
          </div>
        )
      )}
      <Rows label="Providers">
        <Row
          title="Speech to text"
          meta={v.transcribe ? `Azure OpenAI · deployment ${v.transcribe.deployment}` : "not set up"}
          badge={
            <Badge tone={v.transcribe ? "var(--green)" : "var(--ink3)"}>
              {v.transcribe ? "ready" : "off"}
            </Badge>
          }
        />
        <Row
          title="Spoken replies"
          meta={
            v.speak
              ? `Azure AI Speech · ${v.speak.voice}`
              : "not set up · this browser's own voice reads replies"
          }
          badge={
            <Badge tone={v.speak ? "var(--green)" : "var(--amber)"}>
              {v.speak ? "ready" : "browser voice"}
            </Badge>
          }
        />
      </Rows>
      <section aria-label="What happens to your voice" className="flex flex-none flex-col gap-2">
        <h3 className="kicker m-0">What happens to your voice</h3>
        {v.disclosure.length > 0 ? (
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-[1.5] text-ink2">
            {v.disclosure.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-[13px] leading-[1.5] text-ink2">
            Nothing is recorded or sent while voice isn't set up.
          </p>
        )}
      </section>
      <Rows label="Your choices">
        <Row
          title="Microphone · push-to-talk"
          meta={s.micEnabled ? "on · records only while you press the mic" : "off · nothing can record"}
        >
          <Switch
            label="Microphone"
            on={s.micEnabled}
            disabled={save.isPending}
            onChange={(on) => set({ micEnabled: on })}
          />
        </Row>
        <Row
          title="Speak replies"
          meta={
            s.speakReplies ? "on · replies to what you said are read aloud" : "off · replies stay on screen"
          }
        >
          <Switch
            label="Speak replies"
            on={s.speakReplies}
            disabled={save.isPending}
            onChange={(on) => set({ speakReplies: on })}
          />
        </Row>
        <Row title="Speech rate" meta="how fast replies are read">
          <select
            aria-label="Speech rate"
            value={s.speechRate}
            disabled={save.isPending}
            onChange={(e) =>
              set({ speechRate: VoiceSettings.shape.speechRate.parse(Number(e.target.value)) })
            }
            className={select}
          >
            {rates.map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
        </Row>
        <Row title="Language" meta="for recognition and the voice">
          <select
            aria-label="Language"
            value={s.language}
            disabled={save.isPending}
            onChange={(e) => set({ language: VoiceSettings.shape.language.parse(e.target.value) })}
            className={select}
          >
            {languages.map(([l, name]) => (
              <option key={l} value={l}>
                {name}
              </option>
            ))}
          </select>
        </Row>
      </Rows>
      {save.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {save.error.message}
        </p>
      )}
      <p className="m-0 flex-none font-mono text-[11.5px] leading-[1.5] text-ink3">
        today · {Math.round(v.usageToday.transcribedSeconds)} s transcribed · {v.usageToday.spokenCharacters}{" "}
        characters spoken · Azure bills per audio minute and per character
      </p>
    </>
  );
}
