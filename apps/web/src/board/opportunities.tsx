import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentKey,
  Claim,
  ClaimLabel,
  IssuePreview,
  Opportunity,
  OpportunityKind,
} from "@nexus/contracts";
import { ApiRequestError, api, keys } from "../lib/api.ts";
import { clock, shortHash, until, useNow } from "../lib/queries.ts";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";
import { PICK_PROJECT, useScope, type Scope } from "./scope.tsx";
import { EmptyZone } from "./zones.tsx";
import { AGENT_LABEL } from "./agentLabels.ts";

// FR-RES-10 / FR-CXR-09, PRD §D.3 `opp` and §D.4 "Your cofounder noticed": the researcher's ranked opportunities as
// Cofounder cards. Everything on a card comes from the server; impact is an estimate and confidence a label (never a
// percentage). The only write is a GitHub issue, created on the owner's click on the exact previewed hash.

const POLL_MS = 30_000;
// shortcut: the zone shows the 5 best-ranked cards; the rest wait until one is acted on or dismissed.
const ZONE_CARDS = 5;

const KIND: Record<OpportunityKind, { text: string; tone: string }> = {
  RISK: { text: "Risk", tone: "var(--coral)" },
  OPPORTUNITY: { text: "Opportunity", tone: "var(--green)" },
  OPTIMIZE: { text: "Optimize", tone: "var(--teal)" },
};
const CLAIM: Record<ClaimLabel, { text: string; tone: string }> = {
  PRIMARY: { text: "Primary source", tone: "var(--green)" },
  CORROBORATED: { text: "Corroborated", tone: "var(--teal)" },
  CONTESTED: { text: "Contested", tone: "var(--coral)" },
  UNVERIFIED: { text: "Unverified", tone: "var(--amber)" },
};

const ghostBtn =
  "flex-1 rounded-xl border border-hair px-3 py-2.5 text-[12.5px] font-medium whitespace-nowrap text-ink disabled:opacity-45";
const primaryBtn =
  "flex-1 rounded-xl bg-teal px-3 py-2.5 text-[12.5px] font-medium whitespace-nowrap text-onacc disabled:opacity-50";

/** The scope's opportunities (All = every project, read-only); dismissed ones are gone from the board. */
export function useOpportunities() {
  const scope = useScope();
  const projectId = scope.project?.id;
  return useQuery({
    queryKey: keys.opportunitiesOf(projectId),
    queryFn: () => api.opportunities({ projectId }),
    enabled: scope.ready,
    refetchInterval: POLL_MS,
    select: (items) => items.filter((o) => o.status !== "DISMISSED"),
  });
}

export function noticedSub(items: readonly Opportunity[] | undefined) {
  if (!items) return "";
  if (items.length === 0) return "nothing yet";
  const open = items.filter((o) => o.status === "OPEN").length;
  return `${open} open · ranked by confidence, then verified evidence · impact is est.`;
}

/** Why the issue actions are read-only here; null when they can run in this project. */
function issueBlocked(scope: Scope, o: Opportunity): string | null {
  if (!scope.project) return PICK_PROJECT;
  if (scope.project.id !== o.projectId) return "This belongs to another project: switch to it first.";
  if (scope.project.archivedAt) return scope.blocked;
  if (scope.project.mode !== "DEV")
    return "Issues go to GitHub repositories, which only Dev projects have. Explain still works here.";
  return null;
}

const verifiedQuote = (o: Opportunity) => {
  for (const c of o.evidence) {
    const e = c.evidence.find((x) => x.verified);
    if (e) return `“${e.quote}” — ${e.publisher}`;
  }
  return null;
};

function KindTag({ kind }: { kind: OpportunityKind }) {
  const k = KIND[kind];
  return (
    <span
      className="kicker inline-flex items-center gap-1.5 rounded-[7px] px-2 py-[5px]"
      style={{ color: k.tone, background: `color-mix(in oklch, ${k.tone} 14%, transparent)` }}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: k.tone }} />
      {k.text}
    </span>
  );
}

function AgentChips({ agents }: { agents: AgentKey[] }) {
  return (
    <ul aria-label="Agents" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {agents.map((a) => (
        <li
          key={a}
          className="rounded-full px-2.5 py-1.5 text-[11px] leading-none text-violet"
          style={{ background: "color-mix(in oklch, var(--violet) 12%, transparent)" }}
        >
          {AGENT_LABEL[a]}
        </li>
      ))}
    </ul>
  );
}

const confidenceText = (o: Opportunity) => `${o.confidence.toLowerCase()} confidence`;

/** The preview held for this opportunity (shared by card and drawer), while it is still fresh. */
function useHeldPreview(id: string) {
  const now = useNow(15_000);
  const held = useQuery<IssuePreview>({ queryKey: keys.issuePreview(id), queryFn: skipToken });
  return held.data && Date.parse(held.data.expiresAt) > now ? held.data : null;
}

/** Approve: posts the previewed hash; "Created #n" comes only from the API's (GitHub's) answer. */
function useCreateIssue(o: Opportunity) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (p: IssuePreview) =>
      api.createOpportunityIssue(
        o.id,
        { repositoryId: p.repositoryId, actionHash: p.actionHash },
        crypto.randomUUID(),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.opportunity(o.id), updated);
      queryClient.removeQueries({ queryKey: keys.issuePreview(o.id), exact: true });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.opportunities }),
  });
}

function CreatedLink({ issue }: { issue: NonNullable<Opportunity["issue"]> }) {
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-xl px-3 py-2.5 font-mono text-[12px] text-green underline"
      style={{ background: "color-mix(in oklch, var(--green) 12%, transparent)" }}
    >
      <span aria-hidden="true">✓</span> Created #{issue.number} on {issue.repositoryFullName}
      <span className="sr-only"> (opens GitHub in a new tab)</span>
    </a>
  );
}

function ErrorText({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="m-0 text-[12.5px] leading-snug text-coral">
      {error.message}
    </p>
  );
}

// ---------------------------------------------------------------- zone

export function NoticedZone({ onOpen }: { onOpen: (id: string, focus?: "preview") => void }) {
  const list = useOpportunities();
  // Like every zone: the reason in place of the cards (the board never raises alerts of its own).
  if (!list.data) return <EmptyZone>{list.error?.message ?? "Loading…"}</EmptyZone>;
  return (
    <div className="flex flex-col gap-3">
      {list.error && (
        <p role="status" className="m-0 text-[12.5px] leading-normal text-amber">
          Can&apos;t refresh: {list.error.message} Showing what NEXUS had at{" "}
          {clock(new Date(list.dataUpdatedAt).toISOString())}.
        </p>
      )}
      {list.data.length === 0 ? (
        <EmptyZone>
          Nothing noticed yet: run a deep dive. The AI researcher turns what it verifies into risks and
          opportunities here, each with its evidence.
        </EmptyZone>
      ) : (
        <ul aria-label="Noticed for you" className="m-0 flex list-none gap-5 p-0">
          {list.data.slice(0, ZONE_CARDS).map((o) => (
            <li key={o.id}>
              <Card o={o} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Card({ o, onOpen }: { o: Opportunity; onOpen: (id: string, focus?: "preview") => void }) {
  const titleId = useId();
  const whyId = useId();
  const scope = useScope();
  const blocked = issueBlocked(scope, o);
  const preview = useHeldPreview(o.id);
  const create = useCreateIssue(o);
  const issue = create.data?.issue ?? o.issue;
  const quote = verifiedQuote(o);
  const approveWhy =
    blocked ?? (preview ? null : "Preview the issue first: approval binds to exactly what you saw.");
  return (
    <article
      aria-labelledby={titleId}
      className="flex h-full w-[364px] flex-col gap-2.5 rounded-[20px] border border-line bg-card p-[18px] shadow-nx"
    >
      <div className="flex items-center justify-between gap-2">
        <KindTag kind={o.kind} />
        <span className="font-mono text-[11px] text-ink2">{confidenceText(o)}</span>
      </div>
      <h3 id={titleId} className="m-0 line-clamp-2 text-[16px] leading-[1.3] font-medium text-pretty">
        {o.title}
      </h3>
      <p className="m-0 truncate text-[17px] leading-tight text-teal">
        {o.impactEstimate} <span className="text-[13px] text-ink2">est.</span>
      </p>
      {quote && <p className="m-0 truncate text-[13px] leading-normal text-ink2">{quote}</p>}
      <AgentChips agents={o.agents} />
      <div className="mt-auto flex flex-col gap-1.5">
        {issue ? (
          <CreatedLink issue={issue} />
        ) : (
          <div className="flex gap-1.5">
            <button type="button" onClick={() => onOpen(o.id)} className={ghostBtn}>
              Explain<span className="sr-only">, {o.title}</span>
            </button>
            <button
              type="button"
              disabled={!!blocked}
              aria-describedby={blocked ? whyId : undefined}
              onClick={() => onOpen(o.id, "preview")}
              className={ghostBtn}
            >
              Preview<span className="sr-only">, {o.title}</span>
            </button>
            <button
              type="button"
              disabled={!!approveWhy || create.isPending}
              aria-describedby={approveWhy ? whyId : undefined}
              onClick={() => preview && create.mutate(preview)}
              className={primaryBtn}
            >
              {create.isPending ? "Creating…" : "Approve"}
              <span className="sr-only">, create the previewed issue for {o.title}</span>
            </button>
          </div>
        )}
        {!issue && approveWhy && (
          <p id={whyId} className="m-0 truncate text-[11.5px] leading-snug text-ink3" title={approveWhy}>
            {approveWhy}
          </p>
        )}
        <ErrorText error={create.error} />
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- drawer

/** `opp:<uuid>`: why the researcher noticed it (no model call), and the issue preview → approve. */
export function OpportunityDrawer({
  id,
  focus,
  banner,
  onClose,
}: {
  id: string;
  focus?: "preview";
  banner?: ReactNode;
  onClose: () => void;
}) {
  const o = useQuery({ queryKey: keys.opportunity(id), queryFn: () => api.opportunity(id) });
  return (
    <Drawer banner={banner} onClose={onClose}>
      <DrawerHeader
        kicker={o.data ? `Noticed · ${KIND[o.data.kind].text}` : "Noticed for you"}
        title={o.data?.title ?? "Opportunity"}
      />
      {o.data ? <Detail o={o.data} focus={focus} /> : <DrawerState error={o.error} />}
    </Drawer>
  );
}

function Detail({ o, focus }: { o: Opportunity; focus?: "preview" }) {
  const queryClient = useQueryClient();
  const scope = useScope();
  const blocked = issueBlocked(scope, o);
  const dismiss = useMutation({
    mutationFn: () => api.dismissOpportunity(o.id),
    onSuccess: (updated) => queryClient.setQueryData(keys.opportunity(o.id), updated),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.opportunities }),
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
      <section aria-label="Summary" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <KindTag kind={o.kind} />
          <span className="font-mono text-[11.5px] text-ink2">{confidenceText(o)}</span>
          <span className="text-[15px] text-teal">
            {o.impactEstimate} <span className="text-[12.5px] text-ink2">est.</span>
          </span>
        </div>
        <p className="kicker m-0 text-ink2">
          AI inference: unverified · {confidenceText(o)} · a triage label, not a probability
        </p>
        <p className="m-0 text-[14px] leading-relaxed text-ink">{o.problem}</p>
        <p className="m-0 text-[13px] leading-normal text-ink2">Who it affects: {o.targetUsers}</p>
        <AgentChips agents={o.agents} />
      </section>

      <Evidence claims={o.evidence} />

      {o.validationSteps.length > 0 && (
        <section aria-labelledby="opp-steps" className="flex flex-col gap-2">
          <h3 id="opp-steps" className="kicker m-0">
            How to validate it
          </h3>
          <ol className="m-0 flex flex-col gap-1.5 pl-5 text-[13px] leading-normal text-ink2">
            {o.validationSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </section>
      )}

      {o.issue ? (
        <CreatedLink issue={o.issue} />
      ) : o.status === "DISMISSED" ? (
        <p role="status" className="m-0 text-[13px] text-ink2">
          Dismissed. It no longer shows on the board.
        </p>
      ) : (
        <>
          <IssueSection o={o} blocked={blocked} focusPicker={focus === "preview"} />
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              disabled={!!blocked || dismiss.isPending}
              onClick={() => dismiss.mutate()}
              className="self-start rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink2 disabled:opacity-45"
            >
              {dismiss.isPending ? "Dismissing…" : "Dismiss"}
            </button>
            <ErrorText error={dismiss.error} />
          </div>
        </>
      )}
    </div>
  );
}

function Evidence({ claims }: { claims: Claim[] }) {
  return (
    <section aria-labelledby="opp-evidence" className="flex flex-col gap-3">
      <h3 id="opp-evidence" className="kicker m-0">
        Evidence · every quote checked by NEXUS against the page it read
      </h3>
      <ul aria-label="Evidence claims" className="m-0 flex list-none flex-col gap-3 p-0">
        {claims.map((c) => {
          const l = CLAIM[c.label];
          return (
            <li key={c.id} className="flex flex-col gap-2 rounded-[16px] border border-hair bg-card p-3.5">
              <span className="kicker inline-flex items-center gap-1.5" style={{ color: l.tone }}>
                <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: l.tone }} />
                {l.text}
                {c.basis === "INFERRED" && (
                  <span className="text-ink2"> · the researcher&apos;s inference</span>
                )}
              </span>
              <p className="m-0 text-[13.5px] leading-normal text-ink">{c.text}</p>
              {c.label === "CONTESTED" && (
                <p className="m-0 text-[12.5px] leading-snug text-coral">
                  A verified source contradicts this claim: weigh both before acting.
                </p>
              )}
              <ul aria-label="Sources" className="m-0 flex list-none flex-col gap-2 p-0">
                {c.evidence.map((e, i) => (
                  <li key={i} className="flex flex-col gap-1 border-l-2 border-hair pl-3">
                    <q className="text-[12.5px] leading-normal text-ink2">{e.quote}</q>
                    <span className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                      <span className={e.verified ? "text-green" : "text-amber"}>
                        {e.verified ? "✓ found on page" : "not found on page"}
                      </span>
                      {/* Only pages NEXUS itself read and matched are links; anything else stays text. */}
                      {e.verified && /^https:\/\//.test(e.url) ? (
                        <a
                          href={e.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-teal underline"
                        >
                          {e.publisher}
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      ) : (
                        <span className="break-all text-ink3">{e.url}</span>
                      )}
                      <span className="text-ink3">{e.tier.toLowerCase()}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function IssueSection({
  o,
  blocked,
  focusPicker,
}: {
  o: Opportunity;
  blocked: string | null;
  /** Opened from a card's Preview: the repository picker takes focus once it is there. */
  focusPicker: boolean;
}) {
  const queryClient = useQueryClient();
  const now = useNow(15_000);
  const pickId = useId();
  const repos = useQuery({
    queryKey: keys.repositoriesOf(o.projectId),
    queryFn: () => api.repositories(o.projectId),
    enabled: !blocked,
  });
  const [repoId, setRepoId] = useState<string>("");
  const held = useHeldPreview(o.id);
  const preview = useMutation({
    mutationFn: (r: string) => api.previewIssue(o.id, r),
    onSuccess: (p) => queryClient.setQueryData(keys.issuePreview(o.id), p),
  });
  const create = useCreateIssue(o);
  const items = repos.data?.items ?? [];
  const chosen = repoId || (items.length === 1 ? items[0]!.id : "");
  const pickRef = useRef<HTMLSelectElement>(null);
  const pickerShown = items.length > 0 && !blocked;
  useEffect(() => {
    if (focusPicker && pickerShown) pickRef.current?.focus();
  }, [focusPicker, pickerShown]);

  return (
    <section
      aria-labelledby="opp-issue"
      className="flex flex-col gap-3 rounded-[18px] border border-hair p-4"
    >
      <h3 id="opp-issue" className="kicker m-0">
        Create a GitHub issue · R2, needs your approval
      </h3>
      {blocked ? (
        <p className="m-0 text-[13px] leading-snug text-ink2">{blocked}</p>
      ) : !repos.data ? (
        repos.error ? (
          <ErrorText error={repos.error} />
        ) : (
          <p role="status" className="m-0 text-[13px] text-ink3">
            Loading repositories…
          </p>
        )
      ) : items.length === 0 ? (
        <p className="m-0 text-[13px] leading-snug text-ink2">
          No repositories are bound to this project. Bind one in Settings → Workspaces, then preview the
          issue.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label htmlFor={pickId} className="flex min-w-[220px] flex-1 flex-col gap-1 text-[12px] text-ink2">
            Repository (bound to this project)
            <select
              id={pickId}
              ref={pickRef}
              value={chosen}
              onChange={(e) => setRepoId(e.target.value)}
              className="rounded-xl border border-hair bg-card px-3 py-2 text-[13px] text-ink"
            >
              <option value="" disabled>
                Choose a repository
              </option>
              {items.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!chosen || preview.isPending}
            onClick={() => preview.mutate(chosen)}
            className="rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink disabled:opacity-45"
          >
            {preview.isPending ? "Building the preview…" : "Preview issue"}
          </button>
        </div>
      )}
      <ErrorText error={preview.error} />

      {held && !blocked && (
        <div className="flex flex-col gap-3">
          <h4 className="kicker m-0 text-violet">Exactly what will happen</h4>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-[14px] bg-hair px-3.5 py-3 font-mono text-[11.5px] leading-[1.45]">
            {[
              ...held.rows,
              { k: "title", v: held.title },
              { k: "action hash", v: shortHash(held.actionHash) },
              { k: "expires", v: until(held.expiresAt, now) },
            ].map((r) => (
              <div key={r.k} className="contents">
                <dt className="text-ink3">{r.k}</dt>
                <dd className="m-0 break-words text-ink">{r.v}</dd>
              </div>
            ))}
          </dl>
          <details className="text-[12px] text-ink2">
            <summary className="cursor-pointer font-medium text-ink">Exact issue text</summary>
            <p className="mt-2 mb-0 max-h-60 overflow-auto rounded-xl bg-hair p-3 font-mono text-[11.5px] leading-[1.5] break-words whitespace-pre-wrap">
              {held.body}
            </p>
          </details>
          <button
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate(held)}
            className="self-start rounded-xl bg-teal px-4 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60"
          >
            {create.isPending
              ? "Creating the issue on GitHub…"
              : `Approve: create issue on ${held.repositoryFullName}`}
          </button>
          {create.isPending && (
            <p role="status" className="m-0 text-[12.5px] text-ink2">
              Waiting for GitHub&apos;s answer. Nothing shows as created until it confirms.
            </p>
          )}
          <ErrorText error={create.error} />
          {create.error instanceof ApiRequestError && create.error.status === 0 && (
            <p className="m-0 text-[12.5px] text-ink2">
              If GitHub did create it, approving again finds that issue instead of making a second one.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
