import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AutomationAction,
  CreateAutomationClientRequest,
  JobType,
  type AutomationClient,
  type AutomationClientSecret,
  type UpdateAutomationClientRequest,
} from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { ago, useNow, useWorkspaces } from "../lib/queries.ts";
import { DrawerState } from "./Drawer.tsx";
import { PICK_PROJECT, useScope } from "./scope.tsx";

const rowBtn =
  "rounded-[11px] border border-hair px-[11px] py-2 text-[12px] font-medium whitespace-nowrap text-ink disabled:opacity-60";
const field =
  "min-w-0 rounded-xl border border-line bg-card px-3 py-2 text-[13px] text-ink aria-[invalid=true]:border-coral";
const submitBtn =
  "self-start rounded-xl bg-teal px-4 py-2 text-[12.5px] font-medium text-onacc disabled:opacity-60";
const list = "m-0 list-none overflow-hidden rounded-[18px] border border-hair p-0";
const item = "flex flex-col gap-2 border-b border-hair px-4 py-[13px] last:border-b-0";
// Color always paired with text.
const chip = (disabled: boolean) => (
  <span
    className="rounded-full px-2 py-[5px] font-mono text-[10px] leading-none whitespace-nowrap"
    style={{ color: disabled ? "var(--coral)" : "var(--green)", background: "var(--hair)" }}
  >
    {disabled ? "disabled" : "active"}
  </span>
);

/** Settings → Automations (EPIC AUTO): n8n service identities for this project and what they triggered. */
export function AutomationsSettings() {
  const scope = useScope();
  const projectId = scope.project?.id;
  const now = useNow(30_000);
  const workspaces = useWorkspaces();
  const clients = useQuery({
    queryKey: keys.automationClients(projectId),
    queryFn: () => api.automationClients(projectId),
    enabled: scope.ready,
  });
  const runs = useQuery({
    queryKey: keys.automationRuns(projectId),
    queryFn: () => api.automationRuns(projectId),
    enabled: scope.ready,
  });
  const [secret, setSecret] = useState<AutomationClientSecret | null>(null);
  const projectName = (id: string) =>
    workspaces.data?.items.flatMap((w) => w.projects).find((p) => p.id === id)?.name ?? "unknown project";
  const blocked = !scope.project
    ? PICK_PROJECT
    : scope.project.archivedAt
      ? `${scope.project.name} is archived: its automations are read-only.`
      : null;

  return (
    <>
      <p className="m-0 flex-none text-[14px] leading-[1.55] text-ink2">
        n8n can only send signed, typed triggers for the actions a client allows, inside its own project. It
        can never run a shell command. Emergency stop and the daily budget still apply, and every trigger is
        audited. Set-up: docs/runbooks/n8n.md.
      </p>
      {secret && <SecretPanel secret={secret} onDone={() => setSecret(null)} />}
      <section aria-label="Automation clients" className="flex flex-none flex-col gap-2">
        <h3 className="kicker m-0">
          Clients{scope.project ? ` · ${scope.project.name}` : " · all projects"}
        </h3>
        {clients.data ? (
          <ul className={list}>
            {clients.data.length === 0 && (
              <li className="px-4 py-[13px] text-[13px] text-ink2">No automation clients yet.</li>
            )}
            {clients.data.map((c) => (
              <ClientRow
                key={c.id}
                client={c}
                meta={`${projectName(c.projectId)} · ${[...c.allowedActions, ...c.allowedJobTypes].join(", ")} · ${c.rateLimitPerMinute}/min · last used ${c.lastUsedAt ? ago(c.lastUsedAt, now) : "never"}`}
                onSecret={setSecret}
              />
            ))}
          </ul>
        ) : (
          <DrawerState error={clients.error} />
        )}
      </section>
      <NewClient projectId={projectId} blocked={blocked} onSecret={setSecret} />
      <section aria-label="Recent triggers" className="flex flex-none flex-col gap-2">
        <h3 className="kicker m-0">Recent triggers</h3>
        {runs.data ? (
          <ul className={list}>
            {runs.data.length === 0 && (
              <li className="px-4 py-[13px] text-[13px] text-ink2">No triggers yet.</li>
            )}
            {runs.data.map((r) => (
              <li key={r.id} className={item}>
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate text-[13.5px] font-medium">
                    {r.action ?? "invalid request"} ·{" "}
                    {clients.data?.find((c) => c.id === r.clientId)?.name ?? "client"}
                  </span>
                  <span
                    className={`font-mono text-[10.5px] ${r.status === "ACCEPTED" ? "text-green" : "text-coral"}`}
                  >
                    {r.status.toLowerCase()}
                  </span>
                </span>
                <span className="font-mono text-[11.5px] leading-[1.4] break-words text-ink3">
                  {ago(r.receivedAt, now)} ·{" "}
                  {r.reason ??
                    (r.result
                      ? `${r.result.kind === "job" ? "job" : "research run"} ${r.result.id.slice(0, 8)}`
                      : "")}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <DrawerState error={runs.error} />
        )}
      </section>
    </>
  );
}

function ClientRow({
  client: c,
  meta,
  onSecret,
}: {
  client: AutomationClient;
  meta: string;
  onSecret: (s: AutomationClientSecret) => void;
}) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.automations });
  const update = useMutation({
    mutationFn: (body: UpdateAutomationClientRequest) => api.updateAutomationClient(c.id, body),
    onSettled: refresh,
  });
  const rotate = useMutation({
    mutationFn: () => api.rotateAutomationClient(c.id),
    onSuccess: (s) => {
      setConfirm(false);
      onSecret(s);
    },
    onSettled: refresh,
  });
  const error = update.error ?? rotate.error;
  return (
    <li className={item}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-[13.5px] leading-[1.3] font-medium">{c.name}</span>
          <span className="truncate font-mono text-[11.5px] leading-[1.4] text-ink3" title={meta}>
            {meta}
          </span>
        </span>
        {chip(c.disabled)}
        <span className="flex gap-1.5">
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => update.mutate({ disabled: !c.disabled })}
            aria-label={`${c.disabled ? "Enable" : "Disable"} ${c.name}`}
            className={rowBtn}
          >
            {c.disabled ? "Enable" : "Disable"}
          </button>
          {confirm ? (
            <>
              <button type="button" onClick={() => setConfirm(false)} className={rowBtn}>
                Keep key
              </button>
              <button
                type="button"
                disabled={rotate.isPending}
                onClick={() => rotate.mutate()}
                aria-label={`Confirm rotate ${c.name}`}
                className={`${rowBtn} text-coral`}
              >
                Confirm rotate
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirm(true)}
              aria-label={`Rotate key of ${c.name}`}
              className={rowBtn}
            >
              Rotate
            </button>
          )}
        </span>
      </div>
      {confirm && (
        <span className="text-[12px] text-ink3">
          The current key stops working at once; n8n needs the new one.
        </span>
      )}
      {error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {error.message}
        </p>
      )}
    </li>
  );
}

function NewClient({
  projectId,
  blocked,
  onSecret,
}: {
  projectId: string | undefined;
  blocked: string | null;
  onSecret: (s: AutomationClientSecret) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [actions, setActions] = useState<AutomationAction[]>(["research.run"]);
  const [jobTypes, setJobTypes] = useState<JobType[]>([]);
  const [rate, setRate] = useState("10");
  const [touched, setTouched] = useState(false);
  const parsed = CreateAutomationClientRequest.safeParse({
    projectId,
    name,
    allowedActions: actions,
    allowedJobTypes: actions.includes("jobs.create") ? jobTypes : [],
    rateLimitPerMinute: Number(rate),
  });
  const bad = new Set(touched ? parsed.error?.issues.map((i) => i.path[0]) : []);
  const create = useMutation({
    mutationFn: (b: CreateAutomationClientRequest) => api.createAutomationClient(b),
    onSuccess: (s) => {
      setName("");
      setTouched(false);
      onSecret(s);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.automations }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!blocked && parsed.success) create.mutate(parsed.data);
  };
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="New automation client"
      className="flex flex-none flex-col gap-2.5 rounded-[18px] border border-hair p-4"
    >
      <h3 className="kicker m-0">New client</h3>
      <label htmlFor={`${id}-name`} className="text-[12px] text-ink3">
        Name
      </label>
      <input
        id={`${id}-name`}
        value={name}
        maxLength={80}
        disabled={!!blocked}
        aria-invalid={bad.has("name")}
        onChange={(e) => setName(e.target.value)}
        className={field}
      />
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0" disabled={!!blocked}>
        <legend className="mb-1 p-0 text-[12px] text-ink3">Allowed actions</legend>
        {AutomationAction.options.map((a) => (
          <label key={a} className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={actions.includes(a)}
              onChange={() => setActions(toggle(actions, a))}
              className="size-4 accent-teal"
            />
            <span className="font-mono text-[12px]">{a}</span>
          </label>
        ))}
        {bad.has("allowedActions") && (
          <span className="text-[11.5px] text-coral">Allow at least one action.</span>
        )}
      </fieldset>
      {actions.includes("jobs.create") && (
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0" disabled={!!blocked}>
          <legend className="mb-1 p-0 text-[12px] text-ink3">Job types it may create</legend>
          {JobType.options.map((j) => (
            <label key={j} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={jobTypes.includes(j)}
                onChange={() => setJobTypes(toggle(jobTypes, j))}
                className="size-4 accent-teal"
              />
              <span className="font-mono text-[12px]">{j}</span>
            </label>
          ))}
        </fieldset>
      )}
      <label htmlFor={`${id}-rate`} className="text-[12px] text-ink3">
        Triggers per minute (1 to 60)
      </label>
      <input
        id={`${id}-rate`}
        type="number"
        min="1"
        max="60"
        step="1"
        value={rate}
        disabled={!!blocked}
        aria-invalid={bad.has("rateLimitPerMinute")}
        onChange={(e) => setRate(e.target.value)}
        className={`${field} w-28 font-mono`}
      />
      {touched && bad.size > 0 && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          Give it a name (1 to 80 characters), at least one action and 1 to 60 triggers a minute.
        </p>
      )}
      <button type="submit" disabled={create.isPending || !!blocked} className={submitBtn}>
        {create.isPending ? "Creating…" : "Create client"}
      </button>
      {blocked && <span className="text-[12px] text-ink3">{blocked}</span>}
      {create.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {create.error.message}
        </p>
      )}
    </form>
  );
}

/** The key is derived server-side and returned only here; it is never shown again. */
function SecretPanel({ secret: s, onDone }: { secret: AutomationClientSecret; onDone: () => void }) {
  const id = useId();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, text: string) =>
    navigator.clipboard.writeText(text).then(
      () => setCopied(`${label} copied.`),
      () => setCopied("Copy failed: select the text and copy it by hand."),
    );
  const line = (label: string, value: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-${label}`} className="text-[12px] text-ink3">
        {label}
      </label>
      <div className="flex gap-2">
        <input id={`${id}-${label}`} readOnly value={value} className={`${field} flex-1 font-mono`} />
        <button type="button" onClick={() => void copy(label, value)} className={rowBtn}>
          Copy {label.toLowerCase()}
        </button>
      </div>
    </div>
  );
  return (
    <section
      aria-label="New signing key"
      className="flex flex-none flex-col gap-2.5 rounded-[18px] border border-amber p-4"
    >
      <p className="m-0 text-[13.5px] font-medium">
        Signing key for {s.client.name} (version {s.client.keyVersion}). Copy it into n8n now: it won&apos;t
        be shown again.
      </p>
      {line("Client ID", s.client.id)}
      {line("Signing key", s.signingKey)}
      <span role="status" className="text-[12px] text-ink3">
        {copied}
      </span>
      <button type="button" onClick={onDone} className={rowBtn + " self-start"}>
        I&apos;ve stored it
      </button>
    </section>
  );
}
