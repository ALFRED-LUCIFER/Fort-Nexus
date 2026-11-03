import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PutResearchDomainRequest, SourceTier, type ResearchDomain } from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { DrawerState } from "./Drawer.tsx";

// Research → Sources (PRD §9 RES source allowlist): the workspace's domain rules and the web-search provider status.
// Rules are owner policy: a blocked domain is never fetched and its search results never reach the model.

const TIER_TEXT: Record<SourceTier, string> = {
  PRIMARY: "Primary: the vendor's own docs and release notes",
  SECONDARY: "Secondary: established press",
  COMMUNITY: "Community: forums and blogs (the default)",
};

const rowBtn =
  "rounded-[11px] border border-hair px-[11px] py-2 text-[12px] font-medium whitespace-nowrap text-ink disabled:opacity-60";
const field =
  "min-w-0 rounded-xl border border-line bg-card px-3 py-2 text-[13px] text-ink aria-[invalid=true]:border-coral";
const submitBtn = "rounded-xl bg-teal px-4 py-2 text-[12.5px] font-medium text-onacc disabled:opacity-60";
const list = "m-0 list-none overflow-hidden rounded-[18px] border border-hair p-0";
const item = "flex flex-col gap-2 border-b border-hair px-4 py-[13px] last:border-b-0";
// Color always paired with text.
const chip = (text: string, color: string) => (
  <span
    className="rounded-full px-2 py-[5px] font-mono text-[10px] leading-none whitespace-nowrap"
    style={{ color, background: "var(--hair)" }}
  >
    {text}
  </span>
);

/** Paused by TanStack Query while the browser is offline: say so instead of spinning. */
const OFFLINE = "You're offline. NEXUS will load this when the connection is back.";

/** The Sources tab of the Research drawer, for one workspace. */
export function ResearchSources({ workspaceId }: { workspaceId: string }) {
  const domains = useQuery({
    queryKey: keys.researchDomains(workspaceId),
    queryFn: () => api.domains(workspaceId),
  });
  const [editing, setEditing] = useState<ResearchDomain | null>(null);
  const rulesId = useId();

  return (
    <section aria-label="Sources" className="flex flex-col gap-4">
      <SearchProviderLine />
      <p className="m-0 text-[13.5px] leading-[1.55] text-ink2">
        How much each web domain counts when the AI researcher checks a claim. A rule covers the domain and
        its subdomains, and the most specific rule wins. Domains without a rule count as Community. A blocked
        domain is never read, and its search results never reach the model.
      </p>
      <section aria-labelledby={rulesId} className="flex flex-col gap-2">
        <h3 id={rulesId} className="kicker m-0">
          Domain rules
        </h3>
        {domains.data ? (
          <>
            {domains.error && (
              <p role="alert" className="m-0 text-[12.5px] text-coral">
                Showing the rules as last loaded. {domains.error.message}
              </p>
            )}
            <ul className={list}>
              {domains.data.length === 0 && (
                <li className="px-4 py-[13px] text-[13px] text-ink2">
                  No domain rules yet. Every domain counts as Community until you add one.
                </li>
              )}
              {domains.data.map((d) => (
                <DomainRow
                  key={d.id}
                  rule={d}
                  editing={editing?.id === d.id}
                  onEdit={() => setEditing(d)}
                  onRemoved={() => {
                    if (editing?.id === d.id) setEditing(null);
                  }}
                />
              ))}
            </ul>
          </>
        ) : domains.fetchStatus === "paused" ? (
          <p role="status" className="m-0 px-6 py-5 text-[13px] text-ink3">
            {OFFLINE}
          </p>
        ) : (
          <DrawerState error={domains.error} />
        )}
      </section>
      <RuleForm
        key={editing?.id ?? "new"}
        workspaceId={workspaceId}
        editing={editing}
        onDone={() => setEditing(null)}
      />
    </section>
  );
}

function SearchProviderLine() {
  const status = useQuery({ queryKey: keys.searchProvider, queryFn: api.searchProvider });
  const s = status.data;
  return (
    <section
      aria-label="Web search provider"
      className="flex flex-col gap-1.5 rounded-[18px] border border-hair px-4 py-[13px]"
    >
      {s ? (
        <>
          <span className="flex items-center gap-2 text-[13.5px] font-medium">
            Brave Search
            {s.configured ? chip("configured", "var(--green)") : chip("not configured", "var(--amber)")}
          </span>
          {s.configured ? (
            <span className="text-[12.5px] text-ink3">
              Deep dives can search the web. NEXUS makes and audits every search itself.
            </span>
          ) : (
            <>
              <span className="text-[12.5px] leading-[1.45] break-words text-ink2">{s.reason}</span>
              <span className="text-[12px] text-ink3">
                Set-up: <span className="font-mono">{s.runbook}</span>. Until then, deep dives can only read
                the sources of findings you pick.
              </span>
            </>
          )}
        </>
      ) : status.fetchStatus === "paused" ? (
        <p role="status" className="m-0 text-[13px] text-ink3">
          {OFFLINE}
        </p>
      ) : status.error ? (
        <p role="alert" className="m-0 text-[13px] text-coral">
          Couldn&apos;t check web search: {status.error.message}
        </p>
      ) : (
        <p role="status" className="m-0 text-[13px] text-ink3">
          Checking web search…
        </p>
      )}
    </section>
  );
}

function DomainRow({
  rule: d,
  editing,
  onEdit,
  onRemoved,
}: {
  rule: ResearchDomain;
  editing: boolean;
  onEdit: () => void;
  onRemoved: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteDomain(d.id),
    onSuccess: onRemoved,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.researchDomains(d.workspaceId) }),
  });
  return (
    <li className={item}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-[13px] font-medium">{d.domain}</span>
            {chip(d.tier.toLowerCase(), "var(--ink2)")}
            {d.blocked && chip("blocked", "var(--coral)")}
          </span>
          {d.note && <span className="truncate text-[12px] text-ink3">{d.note}</span>}
        </span>
        <span className="flex gap-1.5">
          {confirm ? (
            <>
              <button type="button" onClick={() => setConfirm(false)} className={rowBtn}>
                Keep
              </button>
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                aria-label={`Confirm remove ${d.domain}`}
                className={`${rowBtn} text-coral`}
              >
                {remove.isPending ? (remove.isPaused ? "Waiting for connection…" : "Removing…") : "Remove"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onEdit}
                aria-label={`Edit rule for ${d.domain}`}
                aria-pressed={editing}
                className={rowBtn}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setConfirm(true)}
                aria-label={`Remove rule for ${d.domain}`}
                className={rowBtn}
              >
                Remove
              </button>
            </>
          )}
        </span>
      </div>
      {confirm && (
        <span className="text-[12px] text-ink3">
          {d.domain} goes back to Community and can be read again.
        </span>
      )}
      {remove.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {remove.error.message}
        </p>
      )}
    </li>
  );
}

function RuleForm({
  workspaceId,
  editing,
  onDone,
}: {
  workspaceId: string;
  editing: ResearchDomain | null;
  onDone: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState(editing?.domain ?? "");
  const [tier, setTier] = useState<SourceTier>(editing?.tier ?? "SECONDARY");
  const [blocked, setBlocked] = useState(editing?.blocked ?? false);
  const [note, setNote] = useState(editing?.note ?? "");
  const [touched, setTouched] = useState(false);
  const parsed = PutResearchDomainRequest.safeParse({
    workspaceId,
    domain,
    tier,
    blocked,
    ...(note.trim() ? { note } : {}),
  });
  const bad = new Set(touched ? parsed.error?.issues.map((i) => i.path[0]) : []);
  const save = useMutation({
    mutationFn: (b: PutResearchDomainRequest) => api.putDomain(b),
    onSuccess: () => {
      setDomain("");
      setNote("");
      setBlocked(false);
      setTouched(false);
      onDone();
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.researchDomains(workspaceId) }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (parsed.success) save.mutate(parsed.data);
  };
  const title = editing ? `Edit ${editing.domain}` : "Add a rule";

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={title}
      className="flex flex-col gap-2.5 rounded-[18px] border border-hair p-4"
    >
      <h3 className="kicker m-0">{title}</h3>
      <label htmlFor={`${id}-domain`} className="text-[12px] text-ink3">
        Domain (covers its subdomains)
      </label>
      <input
        id={`${id}-domain`}
        value={domain}
        placeholder="example.com"
        maxLength={253}
        autoCapitalize="none"
        spellCheck={false}
        readOnly={!!editing}
        aria-invalid={bad.has("domain")}
        aria-describedby={bad.has("domain") ? `${id}-domain-error` : undefined}
        onChange={(e) => setDomain(e.target.value)}
        className={`${field} font-mono`}
      />
      {bad.has("domain") && (
        <span id={`${id}-domain-error`} className="text-[11.5px] text-coral">
          A domain name like example.com: no https://, path or port.
        </span>
      )}
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1 p-0 text-[12px] text-ink3">Tier</legend>
        {SourceTier.options.map((t) => (
          <label key={t} className="flex items-center gap-2 text-[13px]">
            <input
              type="radio"
              name={`${id}-tier`}
              value={t}
              checked={tier === t}
              onChange={() => setTier(t)}
              className="size-4 accent-teal"
            />
            {TIER_TEXT[t]}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={blocked}
          onChange={(e) => setBlocked(e.target.checked)}
          className="size-4 accent-teal"
        />
        Block this domain: never read it, and drop its search results
      </label>
      <label htmlFor={`${id}-note`} className="text-[12px] text-ink3">
        Note (optional, up to 200 characters)
      </label>
      <input
        id={`${id}-note`}
        value={note}
        maxLength={200}
        aria-invalid={bad.has("note")}
        onChange={(e) => setNote(e.target.value)}
        className={field}
      />
      <span className="flex gap-2">
        <button type="submit" disabled={save.isPending} className={submitBtn}>
          {save.isPending ? (save.isPaused ? "Waiting for connection…" : "Saving…") : "Save rule"}
        </button>
        {editing && (
          <button type="button" onClick={onDone} className={rowBtn}>
            Cancel edit
          </button>
        )}
      </span>
      {save.error && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {save.error.message}
        </p>
      )}
    </form>
  );
}
