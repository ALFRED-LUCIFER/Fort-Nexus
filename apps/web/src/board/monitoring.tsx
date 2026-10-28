import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CreateMonitoredAppRequest,
  type AppHealth,
  type CheckError,
  type HealthCheck,
  type Incident,
  type IncidentStatus,
  type IncidentTriage,
  type MonitoredApp,
} from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { ago, clock, useNow } from "../lib/queries.ts";
import { AiError, AiLabel } from "./aiInference.tsx";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";
import { P1Button } from "./P1Button.tsx";
import { PICK_PROJECT, useScope, type Scope } from "./scope.tsx";
import { EmptyZone, Node } from "./zones.tsx";

// EPIC MON: app health on the board, the Systems drawer (register / check / pause) and the incident drawer.

const POLL_MS = 30_000;
const INCIDENT_POLL_MS = 15_000;
// shortcut: the zone shows the first 3 apps; the Systems drawer lists all of them.
const ZONE_APPS = 3;

const field =
  "min-w-0 rounded-xl border border-hair bg-card px-3 py-2 text-[13px] text-ink placeholder:text-ink3";
const ghostBtn =
  "rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink disabled:opacity-45";
const primaryBtn = "rounded-xl bg-teal px-4 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60";

// Colour is always paired with text (WCAG 1.4.1). UNKNOWN never reads as healthy (MON-G02).
export const HEALTH: Record<AppHealth, { short: string; text: string; tone: string }> = {
  HEALTHY: { short: "Healthy", text: "Healthy", tone: "var(--green)" },
  DEGRADED: { short: "Degraded", text: "Degraded, failing below the threshold", tone: "var(--amber)" },
  DOWN: { short: "Down", text: "Down", tone: "var(--coral)" },
  UNKNOWN: { short: "Unknown", text: "Unknown, home host can't see it", tone: "var(--ink3)" },
};
const HOME_HOST =
  "Checks run on the home host: while it is off or offline, status is unknown, never assumed healthy.";

const ERROR: Record<CheckError, string> = {
  TIMEOUT: "Timed out",
  DNS: "Name didn't resolve",
  CONNECT: "Connection failed",
  TLS: "TLS failed",
  HTTP_STATUS: "HTTP error",
  REDIRECT: "Redirect, not followed",
  BLOCKED_TARGET: "Refused: private or reserved address",
};
const STATUS: Record<IncidentStatus, { text: string; tone: string }> = {
  OPEN: { text: "Open", tone: "var(--coral)" },
  ACKNOWLEDGED: { text: "Acknowledged", tone: "var(--amber)" },
  RESOLVED: { text: "Resolved", tone: "var(--green)" },
};

export const useMonitoredApps = (projectId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: keys.monitoredApps(projectId),
    queryFn: () => api.monitoredApps(projectId),
    enabled,
    refetchInterval: POLL_MS,
  });

/** Why apps or incidents can't be changed here; null when they can (an archived project's are read-only). */
function writeBlocked(scope: Scope, projectId?: string) {
  if (!scope.project) return PICK_PROJECT;
  if (projectId && projectId !== scope.project.id)
    return "This belongs to another project: switch to it first.";
  if (scope.project.archivedAt)
    return `${scope.project.name} is archived: its apps and incidents are read-only.`;
  return null;
}

const host = (url: string) => new URL(url).host;
const checkText = (c: HealthCheck) =>
  c.ok
    ? `Passed · HTTP ${c.statusCode} · ${c.latencyMs} ms`
    : `${ERROR[c.error!]}${c.statusCode ? ` · HTTP ${c.statusCode}` : ""}`;

function Chip({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className="kicker inline-flex items-center gap-1.5" style={{ color: tone }}>
      <span aria-hidden="true" className="size-1.5 flex-none rounded-full" style={{ background: tone }} />
      {children}
    </span>
  );
}

/** Blocked actions stay visible but disabled, with the reason next to them. */
function Reason({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="m-0 text-[12.5px] leading-snug text-ink2">
      {children}
    </p>
  );
}

// ---------------------------------------------------------------- zone

/** Systems-zone app nodes: one opens its active incident, otherwise the Systems drawer. */
export function AppNodes({
  onOpenIncident,
  onOpenSystems,
}: {
  onOpenIncident: (id: string) => void;
  onOpenSystems: () => void;
}) {
  const now = useNow(30_000);
  const scope = useScope();
  const apps = useMonitoredApps(scope.project?.id, scope.ready);
  const items = apps.data ?? [];
  return (
    <section aria-labelledby="sys-apps" className="flex flex-col gap-3">
      <h3 id="sys-apps" className="kicker m-0">
        Apps
      </h3>
      {!apps.data ? (
        <EmptyZone>{apps.error?.message ?? "Loading…"}</EmptyZone>
      ) : items.length === 0 ? (
        <EmptyZone>
          No apps monitored{scope.project ? ` in ${scope.project.name}` : ""} yet. Register a health URL and
          NEXUS checks it on a schedule.
        </EmptyZone>
      ) : (
        <ul className="m-0 flex list-none flex-wrap content-start gap-[30px] p-0">
          {items.slice(0, ZONE_APPS).map((a) => (
            <li key={a.id}>
              <Node
                dot={HEALTH[a.health].tone}
                live={a.health === "DOWN"}
                kicker={`${HEALTH[a.health].short} · ${a.environment}`}
                title={a.name}
                meta={appMeta(a, now)}
                onClick={() => (a.openIncidentId ? onOpenIncident(a.openIncidentId) : onOpenSystems())}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 max-w-[460px] text-[12.5px] leading-normal text-ink3">{HOME_HOST}</p>
      <button type="button" onClick={onOpenSystems} className={`${ghostBtn} self-start`}>
        {items.length > ZONE_APPS
          ? `All ${items.length} apps →`
          : items.length
            ? "Manage apps"
            : "Register an app"}
      </button>
    </section>
  );
}

function appMeta(a: MonitoredApp, now: number) {
  const when = a.disabled
    ? "checks paused"
    : a.lastCheckedAt
      ? `checked ${ago(a.lastCheckedAt, now)}`
      : "never checked";
  return a.health === "UNKNOWN" ? `home host can't see it · ${when}` : when;
}

/** Zone subtitle: how many apps and how many need attention. */
export function appsSub(apps: readonly MonitoredApp[] | undefined) {
  if (!apps?.length) return "";
  const down = apps.filter((a) => a.health === "DOWN" || a.health === "DEGRADED").length;
  return `${apps.length} ${apps.length === 1 ? "app" : "apps"}${down ? ` · ${down} failing` : ""}`;
}

// ---------------------------------------------------------------- systems drawer

export function SystemsDrawer({
  banner,
  onClose,
  onOpenIncident,
}: {
  banner?: ReactNode;
  onClose: () => void;
  onOpenIncident: (id: string) => void;
}) {
  const scope = useScope();
  const apps = useMonitoredApps(scope.project?.id, scope.ready);
  const [registering, setRegistering] = useState(false);
  const blocked = writeBlocked(scope);
  const reasonId = useId();
  return (
    <Drawer banner={banner} onClose={onClose}>
      <DrawerHeader kicker="Systems · health checks from the home host" title="Monitored apps" />
      <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-6 pt-5 pb-6">
        <p className="m-0 text-[13px] leading-relaxed text-ink2">{HOME_HOST}</p>
        <div className="flex items-center gap-3">
          <h3 className="kicker m-0 flex-1">
            Apps{scope.project ? ` · ${scope.project.name}` : " · all projects"}
          </h3>
          <button
            type="button"
            aria-expanded={registering}
            disabled={!!blocked}
            aria-describedby={blocked ? reasonId : undefined}
            onClick={() => setRegistering((r) => !r)}
            className={ghostBtn}
          >
            {registering ? "Close form" : "Register an app"}
          </button>
        </div>
        {blocked && <Reason id={reasonId}>{blocked}</Reason>}
        {registering && scope.project && !blocked && (
          <RegisterApp projectId={scope.project.id} onDone={() => setRegistering(false)} />
        )}
        {!apps.data ? (
          <DrawerState error={apps.error} />
        ) : apps.data.length === 0 ? (
          <p className="m-0 text-[14px] leading-relaxed text-ink2">No apps monitored here yet.</p>
        ) : (
          <ul aria-label="Monitored apps" className="m-0 flex list-none flex-col gap-3 p-0">
            {apps.data.map((a) => (
              <AppRow
                key={a.id}
                app={a}
                blocked={writeBlocked(scope, a.projectId)}
                onOpenIncident={onOpenIncident}
              />
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  );
}

function AppRow({
  app: a,
  blocked,
  onOpenIncident,
}: {
  app: MonitoredApp;
  blocked: string | null;
  onOpenIncident: (id: string) => void;
}) {
  const now = useNow(30_000);
  const queryClient = useQueryClient();
  const reasonId = useId();
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.monitoring });
  const check = useMutation({ mutationFn: () => api.checkApp(a.id), onSettled: refresh });
  const pause = useMutation({
    mutationFn: () => api.updateMonitoredApp(a.id, { disabled: !a.disabled }),
    onSettled: refresh,
  });
  const error = check.error ?? pause.error;
  return (
    <li aria-label={a.name} className="flex flex-col gap-2 rounded-2xl border border-hair p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-[15px] font-medium">{a.name}</span>
        <Chip tone={HEALTH[a.health].tone}>{HEALTH[a.health].text}</Chip>
      </div>
      <span className="font-mono text-[11.5px] leading-normal text-ink2">
        {a.environment} · {host(a.healthUrl)} · every {Math.round(a.intervalSeconds / 60)} min ·{" "}
        {a.consecutiveFailures}/{a.failureThreshold} failures · {appMeta(a, now)}
      </span>
      {check.data && (
        <p role="status" className="m-0 text-[12.5px] text-ink2">
          Checked now: {checkText(check.data)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {a.openIncidentId && (
          <button type="button" onClick={() => onOpenIncident(a.openIncidentId!)} className={primaryBtn}>
            Open incident
          </button>
        )}
        <button
          type="button"
          disabled={!!blocked || check.isPending}
          aria-describedby={blocked ? reasonId : undefined}
          onClick={() => check.mutate()}
          className={ghostBtn}
        >
          {check.isPending ? "Checking…" : "Check now"}
        </button>
        <button
          type="button"
          disabled={!!blocked || pause.isPending}
          aria-describedby={blocked ? reasonId : undefined}
          onClick={() => pause.mutate()}
          className={ghostBtn}
        >
          {a.disabled ? "Resume checks" : "Pause checks"}
        </button>
      </div>
      {blocked && <Reason id={reasonId}>{blocked}</Reason>}
      {error && (
        <p role="alert" className="m-0 text-[13px] text-coral">
          {error.message}
        </p>
      )}
    </li>
  );
}

function RegisterApp({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: api.createMonitoredApp,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.monitoring });
      onDone();
    },
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const parsed = CreateMonitoredAppRequest.safeParse({
      projectId,
      name: data.get("name"),
      environment: data.get("environment"),
      healthUrl: String(data.get("healthUrl")).trim(),
      intervalSeconds: Number(data.get("intervalMinutes")) * 60,
      failureThreshold: Number(data.get("failureThreshold")),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return setProblem(`${String(issue.path.at(-1) ?? "Form")}: ${issue.message}`);
    }
    setProblem(null);
    create.mutate(parsed.data);
  };
  return (
    <form
      aria-label="Register an app"
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-2xl border border-hair p-4 text-[12.5px] text-ink2"
    >
      <label className="flex flex-col gap-1.5">
        Name
        <input name="name" required maxLength={80} className={field} />
      </label>
      <label className="flex flex-col gap-1.5">
        Health URL: https, a public host, no credentials
        <input
          name="healthUrl"
          type="url"
          required
          placeholder="https://api.example.com/health"
          className={field}
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1.5">
          Environment
          <select name="environment" defaultValue="PROD" className={field}>
            <option value="PROD">Production</option>
            <option value="STAGING">Staging</option>
            <option value="DEV">Development</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          Check every (minutes)
          <input
            name="intervalMinutes"
            type="number"
            min={1}
            max={60}
            defaultValue={5}
            required
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          Failures before an incident
          <input
            name="failureThreshold"
            type="number"
            min={1}
            max={10}
            defaultValue={3}
            required
            className={field}
          />
        </label>
      </div>
      {(problem ?? create.error) && (
        <p role="alert" className="m-0 text-[13px] text-coral">
          {problem ?? create.error?.message}
        </p>
      )}
      <button type="submit" disabled={create.isPending} className={`${primaryBtn} self-start`}>
        {create.isPending ? "Registering…" : "Register app"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- incident drawer

export function IncidentDrawer({
  id,
  banner,
  onClose,
}: {
  id: string;
  banner?: ReactNode;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: keys.incident(id),
    queryFn: () => api.incident(id),
    refetchInterval: INCIDENT_POLL_MS,
  });
  return (
    <Drawer banner={banner} onClose={onClose}>
      {q.data ? (
        <IncidentBody incident={q.data} />
      ) : (
        <>
          <DrawerHeader kicker="Incident" title="Incident" />
          <DrawerState error={q.error} />
        </>
      )}
    </Drawer>
  );
}

function IncidentBody({ incident: i }: { incident: Incident }) {
  const scope = useScope();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const triageReasonId = useId();
  const checkId = useId();
  const set = useMutation({
    mutationFn: (status: "ACKNOWLEDGED" | "RESOLVED") => api.setIncidentStatus(i.id, status),
    onSuccess: (updated) => queryClient.setQueryData(keys.incident(i.id), updated),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.monitoring }),
  });
  const triage = useMutation({ mutationFn: () => api.triageIncident(i.id) });
  // Triage is advice: a resolved incident can still be triaged afterwards; All and archived projects can't.
  const triageBlocked = writeBlocked(scope, i.projectId);
  const blocked =
    i.status === "RESOLVED" ? "Resolved is final: a new failure streak opens a new incident." : triageBlocked;
  const timeline: [string, string | null][] = [
    ["Opened", i.openedAt],
    ["Acknowledged", i.acknowledgedAt],
    ["Checks passing again", i.recoveredAt],
    ["Resolved", i.resolvedAt],
  ];
  return (
    <>
      <DrawerHeader kicker={`Incident · ${i.severity}`} title={i.title} />
      <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-6 overflow-auto px-6 pt-5 pb-6">
        <div className="flex flex-wrap items-center gap-4">
          <Chip tone={STATUS[i.status].tone}>{STATUS[i.status].text}</Chip>
          <span className="font-mono text-[11.5px] text-ink2">
            {i.evidenceCount} failed {i.evidenceCount === 1 ? "check" : "checks"} · observer: home host, same
            failure domain
          </span>
        </div>

        <section aria-labelledby="inc-timeline" className="flex flex-col gap-2">
          <h3 id="inc-timeline" className="kicker m-0">
            Timeline
          </h3>
          <ol aria-labelledby="inc-timeline" className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
            {timeline
              .filter(([, at]) => at)
              .map(([what, at]) => (
                <li key={what} className="flex gap-3">
                  <span className="w-[86px] flex-none font-mono text-[11.5px] text-ink3">{clock(at!)}</span>
                  {what}
                </li>
              ))}
          </ol>
        </section>

        <section aria-labelledby="inc-evidence" className="flex flex-col gap-2">
          <h3 id="inc-evidence" className="kicker m-0">
            Evidence · failed checks, newest first
          </h3>
          <ul aria-labelledby="inc-evidence" className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
            {i.evidence.map((c) => (
              <li key={c.id} id={`${checkId}-${c.id}`} tabIndex={-1} className="flex gap-3">
                <span className="w-[86px] flex-none font-mono text-[11.5px] text-ink3">
                  {clock(c.checkedAt)}
                </span>
                {checkText(c)}
              </li>
            ))}
          </ul>
          {i.evidenceCount > i.evidence.length && (
            <p className="m-0 text-[12px] text-ink3">
              Showing the newest {i.evidence.length} of {i.evidenceCount}.
            </p>
          )}
        </section>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {i.status === "OPEN" && (
              <button
                type="button"
                disabled={!!blocked || set.isPending}
                aria-describedby={blocked ? reasonId : undefined}
                onClick={() => set.mutate("ACKNOWLEDGED")}
                className={ghostBtn}
              >
                Acknowledge
              </button>
            )}
            {i.status !== "RESOLVED" && (
              <button
                type="button"
                disabled={!!blocked || set.isPending}
                aria-describedby={blocked ? reasonId : undefined}
                onClick={() => set.mutate("RESOLVED")}
                className={primaryBtn}
              >
                Resolve
              </button>
            )}
            {!triage.data && (
              <button
                type="button"
                disabled={!!triageBlocked || triage.isPending}
                aria-describedby={
                  triageBlocked ? (triageBlocked === blocked ? reasonId : triageReasonId) : undefined
                }
                onClick={() => triage.mutate()}
                className={ghostBtn}
              >
                {triage.isPending ? "Triaging…" : "Triage"}
              </button>
            )}
            <P1Button why="Creating a fix issue from an incident isn't available yet." className={ghostBtn}>
              Create fix issue
            </P1Button>
          </div>
          {blocked && <Reason id={reasonId}>{blocked}</Reason>}
          {triageBlocked && triageBlocked !== blocked && <Reason id={triageReasonId}>{triageBlocked}</Reason>}
          {set.error && (
            <p role="alert" className="m-0 text-[13px] text-coral">
              {set.error.message}
            </p>
          )}
          {triage.error && <AiError error={triage.error} />}
        </div>
        {triage.data && <Triage incident={i} triage={triage.data} checkId={checkId} />}
      </div>
    </>
  );
}

/** FR-MON-07: hypotheses labelled as unverified inference, each linking to the failed checks it cites. */
function Triage({
  incident,
  triage,
  checkId,
}: {
  incident: Incident;
  triage: IncidentTriage;
  checkId: string;
}) {
  const show = (id: string) => {
    const el = document.getElementById(`${checkId}-${id}`);
    el?.scrollIntoView?.({ block: "nearest" });
    el?.focus();
  };
  return (
    <section aria-labelledby="inc-triage" className="flex flex-col gap-2 rounded-xl bg-hair px-3 py-2.5">
      <h3 id="inc-triage" className="kicker m-0">
        Triage
      </h3>
      <AiLabel model={triage.model} />
      <ol aria-label="Hypotheses" className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
        {triage.hypotheses.map((h, n) => (
          <li key={n} className="flex flex-col gap-1">
            <span className="break-words text-ink">{h.text}</span>
            <span className="flex flex-wrap gap-x-2 font-mono text-[11.5px] text-ink2">
              {h.confidence.toLowerCase()} confidence · evidence:
              {h.evidenceCheckIds.map((id) => {
                const c = incident.evidence.find((e) => e.id === id);
                return c ? (
                  <button key={id} type="button" onClick={() => show(id)} className="text-teal underline">
                    check at {clock(c.checkedAt)}
                  </button>
                ) : (
                  <span key={id}>an older check</span>
                );
              })}
            </span>
          </li>
        ))}
      </ol>
      <p className="m-0 text-[13px] break-words text-ink2">
        <span className="font-medium text-ink">Suggested next step: </span>
        {triage.suggestedNextStep}
      </p>
    </section>
  );
}
