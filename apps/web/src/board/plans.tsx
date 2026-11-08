import { useId, useState, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Plan, PlanStatus, PlanStep, PlanStepAction, PlanStepStatus } from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { ago, clock, useNow } from "../lib/queries.ts";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";
import { newJobBlocked } from "./newJob.tsx";
import { useWatchlists } from "./research.tsx";
import { PICK_PROJECT, useScope, type Scope } from "./scope.tsx";
import { EmptyZone, Node, nodeGrid } from "./zones.tsx";
import { AGENT_LABEL } from "./agentLabels.ts";
import { SOURCE_DRAWER } from "./Talk.tsx";

// EPIC AGT FR-AGT-01/09: the Plans area and the plan:<uuid> drawer. The model only drafts; the owner approves
// the exact hash; each step succeeds only on its source record, which the drawer cites.

const route = getRouteApi("/");
const POLL_MS = 5_000;

const ghostBtn =
  "rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink disabled:opacity-45";
const primaryBtn = "rounded-xl bg-teal px-4 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60";

// Colour is always paired with text (WCAG 1.4.1).
const PLAN: Record<PlanStatus, { text: string; tone: string }> = {
  DRAFT: { text: "Draft · needs your decision", tone: "var(--amber)" },
  APPROVED: { text: "Approved · starting", tone: "var(--teal)" },
  RUNNING: { text: "Running", tone: "var(--teal)" },
  COMPLETED: { text: "Completed", tone: "var(--green)" },
  FAILED: { text: "Failed", tone: "var(--coral)" },
  DENIED: { text: "Denied", tone: "var(--ink3)" },
  CANCELLED: { text: "Cancelled", tone: "var(--ink3)" },
};
const STEP: Record<PlanStepStatus, { text: string; tone: string }> = {
  PENDING: { text: "Pending", tone: "var(--ink3)" },
  RUNNING: { text: "Running", tone: "var(--teal)" },
  SUCCEEDED: { text: "Succeeded · verified", tone: "var(--green)" },
  FAILED: { text: "Failed", tone: "var(--coral)" },
  SKIPPED: { text: "Skipped", tone: "var(--ink3)" },
  CANCELLED: { text: "Cancelled", tone: "var(--ink3)" },
};
const ACTIVE: PlanStatus[] = ["DRAFT", "APPROVED", "RUNNING"];

/** Plans start only in an active project of either mode; All and archived projects are read-only. */
export const planBlocked = (scope: Scope): string | null =>
  !scope.project
    ? PICK_PROJECT
    : scope.project.archivedAt
      ? `${scope.project.name} is archived: its plans are read-only.`
      : null;

const writeBlocked = (scope: Scope, p: Plan) =>
  planBlocked(scope) ??
  (scope.project?.id === p.projectId ? null : "This plan belongs to another project: switch to it first.");

export function usePlans() {
  const scope = useScope();
  const projectId = scope.project?.id;
  return useQuery({
    queryKey: keys.plansOf(projectId),
    queryFn: () => api.plans(projectId),
    enabled: scope.ready,
    refetchInterval: POLL_MS,
  });
}

export function plansSub(plans: readonly Plan[] | undefined) {
  if (!plans) return "";
  if (plans.length === 0) return "no plans";
  const active = plans.filter((p) => ACTIVE.includes(p.status)).length;
  return `${plans.length} ${plans.length === 1 ? "plan" : "plans"}${active ? ` · ${active} active` : ""}`;
}

type Draft = { goal: string; projectId: string; key: string };

/**
 * Drafts a plan in the current project and opens its drawer. A retry of the same goal reuses its Idempotency-Key,
 * so the model is called once.
 */
export function useCreatePlan(onCreated?: () => void) {
  const scope = useScope();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const [last, setLast] = useState<Draft | null>(null);
  const mutation = useMutation({
    mutationFn: (d: Draft) => api.createPlan({ projectId: d.projectId, goal: d.goal }, d.key),
    onSuccess: (p) => {
      setLast(null);
      void queryClient.invalidateQueries({ queryKey: keys.plans });
      void queryClient.invalidateQueries({ queryKey: keys.homeAll });
      onCreated?.();
      void navigate({ search: { ...scope.keep, drawer: `plan:${p.id}` } });
    },
  });
  const blocked = planBlocked(scope);
  const projectId = scope.project?.id;
  return {
    blocked,
    pending: mutation.isPending,
    error: mutation.error,
    create: (goal: string) => {
      if (blocked || !projectId || !goal || mutation.isPending) return;
      const same = last?.goal === goal && last.projectId === projectId;
      const d = same ? last : { goal, projectId, key: crypto.randomUUID() };
      setLast(d);
      mutation.mutate(d);
    },
  };
}

function Chip({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className="kicker inline-flex items-center gap-1.5" style={{ color: tone }}>
      <span aria-hidden="true" className="size-1.5 flex-none rounded-full" style={{ background: tone }} />
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- zone

export function PlansZone({ onOpen }: { onOpen: (id: string) => void }) {
  const now = useNow(30_000);
  const scope = useScope();
  const plans = usePlans();
  const [goal, setGoal] = useState("");
  const planning = useCreatePlan(() => setGoal(""));
  const reasonId = useId();
  const items = plans.data ?? [];
  return (
    <div className="flex flex-col gap-5">
      {!scope.project ? (
        <EmptyZone>All is a read-only view across projects: choose a project to draft a plan.</EmptyZone>
      ) : (
        <form
          data-nopan
          aria-label="Draft a plan"
          className="flex max-w-[640px] flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            planning.create(goal.trim());
          }}
        >
          <label htmlFor="plan-goal" className="kicker">
            Goal for the Chief of Staff
          </label>
          <textarea
            id="plan-goal"
            rows={2}
            maxLength={2000}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Check the runner, then work on issue #42"
            className="min-w-0 rounded-xl border border-hair bg-card px-3 py-2 text-[13px] text-ink placeholder:text-ink3"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={!!planning.blocked || planning.pending || !goal.trim()}
              aria-describedby={planning.blocked ? reasonId : undefined}
              className={primaryBtn}
            >
              {planning.pending ? "Drafting…" : "Draft a plan"}
            </button>
            {planning.blocked && (
              <span id={reasonId} className="text-[12.5px] leading-snug text-ink2">
                {planning.blocked}
              </span>
            )}
          </div>
          {planning.error && (
            <p role="alert" className="m-0 text-[13px] text-coral">
              {planning.error.message}
            </p>
          )}
        </form>
      )}

      <section aria-labelledby="plans-list" className="flex flex-col gap-3">
        <h3 id="plans-list" className="kicker m-0">
          Newest plans · each step runs only after you approve the exact plan
        </h3>
        {!plans.data ? (
          <EmptyZone>{plans.error?.message ?? "Loading…"}</EmptyZone>
        ) : items.length === 0 ? (
          <EmptyZone>
            No plans{scope.project ? ` in ${scope.project.name}` : ""} yet. Give the Chief of Staff a goal; it
            drafts typed steps for you to approve.
          </EmptyZone>
        ) : (
          <ul className={nodeGrid}>
            {items.map((p) => (
              <li key={p.id}>
                <Node
                  dot={PLAN[p.status].tone}
                  live={p.status === "RUNNING"}
                  kicker={`${PLAN[p.status].text} · ${p.steps.length} ${p.steps.length === 1 ? "step" : "steps"}${p.gaps.length ? ` · ${p.gaps.length} not covered` : ""}`}
                  title={p.goal}
                  meta={`${p.steps.filter((s) => s.status === "SUCCEEDED").length}/${p.steps.length} verified · drafted ${ago(p.createdAt, now)}`}
                  onClick={() => onOpen(p.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- drawer

export function PlanDrawer({ id, banner, onClose }: { id: string; banner?: ReactNode; onClose: () => void }) {
  const q = useQuery({
    queryKey: keys.plan(id),
    queryFn: () => api.plan(id),
    refetchInterval: (query) => (ACTIVE.includes(query.state.data?.status ?? "DRAFT") ? POLL_MS : false),
  });
  return (
    <Drawer banner={banner} onClose={onClose}>
      {q.data ? (
        <PlanBody plan={q.data} />
      ) : (
        <>
          <DrawerHeader kicker="Plan" title="Plan" />
          <DrawerState error={q.error} />
        </>
      )}
    </Drawer>
  );
}

function actionText(a: PlanStepAction, watchlists: Map<string, string>): string {
  if (a.type === "research.run")
    return `Research brief · ${watchlists.get(a.watchlistId) ?? `watchlist ${a.watchlistId.slice(0, 8)}`}`;
  if (a.type === "business.sales_summary")
    return `Sales summary · ${a.day} · connector ${a.connectorId.slice(0, 8)}`;
  if (a.type === "research.deep_dive")
    return `Deep dive · ${a.request.depth.toLowerCase()} · up to $${a.request.maxCostUsd} · reads the public web, writes nothing outside NEXUS · “${a.request.question}”`;
  const r = a.request;
  return r.jobType === "RUNNER_DIAGNOSTIC"
    ? `Runner diagnostic · ${r.preset} · read-only`
    : `Issue run · repository ${r.repositoryId} #${r.issueNumber} · up to $${r.budget.maxCostUsd} · the push needs its own approval`;
}

function PlanBody({ plan: p }: { plan: Plan }) {
  const scope = useScope();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const watchlists = new Map((useWatchlists().data ?? []).map((w) => [w.id, w.name]));
  const onDone = (updated: Plan) => {
    queryClient.setQueryData(keys.plan(p.id), updated);
    void queryClient.invalidateQueries({ queryKey: keys.plans });
    void queryClient.invalidateQueries({ queryKey: keys.homeAll });
  };
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") => api.decidePlan(p.id, { decision, planHash: p.planHash }),
    onSuccess: onDone,
  });
  const cancel = useMutation({ mutationFn: () => api.cancelPlan(p.id), onSuccess: onDone });
  const blockedSteps = p.steps.filter((s) => s.blockedReason).length;
  const blocked = writeBlocked(scope, p);
  const approveBlocked =
    blocked ??
    (p.steps.length === 0
      ? "No step can run: start the uncovered work as a new job, or deny the plan."
      : blockedSteps
        ? `${blockedSteps} blocked ${blockedSteps === 1 ? "step" : "steps"}: deny it and draft a new plan.`
        : null);
  const error = decide.error ?? cancel.error;
  const busy = decide.isPending || cancel.isPending;
  const open = (drawer: string) => void navigate({ search: { ...scope.keep, drawer } });

  return (
    <>
      <DrawerHeader kicker="Plan · Chief of Staff" title={p.goal} />
      <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-6 overflow-auto px-6 pt-5 pb-6">
        <div className="flex flex-wrap items-center gap-4">
          <Chip tone={PLAN[p.status].tone}>{PLAN[p.status].text}</Chip>
          <span className="font-mono text-[11.5px] text-ink2">
            drafted {clock(p.createdAt)}
            {p.decidedAt ? ` · decided ${clock(p.decidedAt)}` : ""}
            {p.finishedAt ? ` · ended ${clock(p.finishedAt)}` : ""} · profile{" "}
            {p.profileVersionId ? p.profileVersionId.slice(0, 8) : "default"}
          </span>
        </div>
        <p
          className="m-0 rounded-xl px-3 py-2.5 text-[12.5px] leading-snug"
          style={{ background: "oklch(0.70 0.13 65 / .15)" }}
        >
          AI inference: unverified. The Chief of Staff drafted these steps from your goal. Nothing runs until
          you approve this exact plan, and a step counts as done only when its source record says so.
        </p>

        <section aria-labelledby="plan-steps" className="flex flex-col gap-2">
          <h3 id="plan-steps" className="kicker m-0">
            Steps · one at a time
          </h3>
          {p.steps.length === 0 ? (
            <p className="m-0 text-[13px] leading-snug text-ink2">
              No step: nothing NEXUS can run today fits this goal.
            </p>
          ) : (
            <ol aria-labelledby="plan-steps" className="m-0 flex list-none flex-col gap-2.5 p-0">
              {p.steps.map((s) => (
                <StepRow key={s.index} s={s} action={actionText(s.action, watchlists)} onOpen={open} />
              ))}
            </ol>
          )}
        </section>

        {p.gaps.length > 0 && <Gaps plan={p} />}

        {p.dropped.length > 0 && (
          <section aria-labelledby="plan-dropped" className="flex flex-col gap-2">
            <h3 id="plan-dropped" className="kicker m-0">
              Removed by NEXUS · drafted, then taken out before you saw the plan
            </h3>
            <ul aria-labelledby="plan-dropped" className="m-0 flex list-none flex-col gap-1.5 p-0">
              {p.dropped.map((d, i) => (
                <li key={i} className="text-[12.5px] leading-snug break-words text-ink2">
                  <span className="text-ink">{d.title}</span> · {d.reason}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {p.status === "DRAFT" && (
              <>
                <button
                  type="button"
                  disabled={!!approveBlocked || busy}
                  aria-describedby={approveBlocked ? reasonId : undefined}
                  onClick={() => decide.mutate("approve")}
                  className={primaryBtn}
                >
                  Approve plan{" "}
                  <span className="font-mono text-[11px] opacity-80">{p.planHash.slice(0, 12)}</span>
                </button>
                <button
                  type="button"
                  disabled={!!blocked || busy}
                  aria-describedby={blocked ? reasonId : undefined}
                  onClick={() => decide.mutate("deny")}
                  className={ghostBtn}
                >
                  Deny
                </button>
              </>
            )}
            {ACTIVE.includes(p.status) && (
              <button
                type="button"
                disabled={!!blocked || busy}
                aria-describedby={blocked ? reasonId : undefined}
                onClick={() => cancel.mutate()}
                className={ghostBtn}
              >
                Cancel plan
              </button>
            )}
          </div>
          {ACTIVE.includes(p.status) && (approveBlocked ?? blocked) && (
            <p id={reasonId} className="m-0 text-[12.5px] leading-snug text-ink2">
              {p.status === "DRAFT" ? approveBlocked : blocked}
            </p>
          )}
          {error && (
            <p role="alert" className="m-0 text-[13px] text-coral">
              {error.message}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

// The New job form takes its starting words from this query-cache entry (newJob.tsx's REWRITE).
const NEW_JOB_WORDS = ["new-job", "rewrite"] as const;

/**
 * Parts of the goal no step covers. Each can start a New job with its words prefilled: the owner edits and sends
 * them there, the Developer drafts the issue, and nothing is created before the owner approves that preview.
 */
function Gaps({ plan: p }: { plan: Plan }) {
  const scope = useScope();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const baseId = useId();
  const blocked = writeBlocked(scope, p) ?? newJobBlocked(scope);
  return (
    <section aria-labelledby="plan-gaps" className="flex flex-col gap-2">
      <h3 id="plan-gaps" className="kicker m-0">
        Not covered · no open issue or step does this yet
      </h3>
      <p className="m-0 text-[12.5px] leading-snug text-ink2">
        Start each as a new job: the Developer drafts the issue and you approve it before anything is created.
      </p>
      <ul aria-labelledby="plan-gaps" className="m-0 flex list-none flex-col gap-2.5 p-0">
        {p.gaps.map((g, i) => (
          <li key={i} className="flex flex-col gap-2 rounded-2xl border border-dashed border-hair px-4 py-3">
            <p id={`${baseId}-${i}`} className="m-0 text-[13.5px] leading-snug break-words text-ink">
              {g.work}
            </p>
            <button
              type="button"
              disabled={!!blocked}
              aria-describedby={blocked ? `${baseId}-${i} ${reasonId}` : `${baseId}-${i}`}
              onClick={() => {
                queryClient.setQueryData(NEW_JOB_WORDS, g.work);
                void navigate({ search: { ...scope.keep, drawer: "newjob" } });
              }}
              className={`${ghostBtn} self-start`}
            >
              Start as a new job
            </button>
          </li>
        ))}
      </ul>
      {blocked && (
        <p id={reasonId} className="m-0 text-[12.5px] leading-snug text-ink2">
          {blocked}
        </p>
      )}
    </section>
  );
}

// Evidence that opens its own drawer: a run, or a deep dive in the Research drawer.
const OPENS = SOURCE_DRAWER;

function StepRow({ s, action, onOpen }: { s: PlanStep; action: string; onOpen: (drawer: string) => void }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-2xl border border-hair px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-serif text-[20px] leading-none">{s.index + 1}</span>
        <Chip tone={STEP[s.status].tone}>{STEP[s.status].text}</Chip>
        <span className="font-mono text-[11px] text-ink3">
          {AGENT_LABEL[s.agent]}
          {s.dependsOn.length ? ` · after ${s.dependsOn.map((d) => `step ${d + 1}`).join(", ")}` : ""}
        </span>
      </div>
      <span className="text-[14px] leading-[1.35] font-medium text-ink">{s.title}</span>
      {s.why && (
        <p className="m-0 text-[12.5px] leading-snug break-words text-ink2">
          <span className="kicker">Why · </span>
          {s.why}
        </p>
      )}
      <span className="font-mono text-[11.5px] leading-snug text-ink2">{action}</span>
      {s.blockedReason && (
        <p className="m-0 text-[12.5px] leading-snug text-coral">Blocked: {s.blockedReason}</p>
      )}
      {s.error && <p className="m-0 text-[12.5px] leading-snug text-coral">{s.error}</p>}
      {s.artifact && (
        <ul
          aria-label={`Evidence for step ${s.index + 1}`}
          className="m-0 flex list-none flex-wrap gap-1.5 p-0"
        >
          {s.artifact.evidence.map((e) => (
            <li key={`${e.kind}:${e.id}`}>
              {OPENS[e.kind] ? (
                <button
                  type="button"
                  onClick={() => onOpen(`${OPENS[e.kind]}:${e.id}`)}
                  className="rounded-full border border-hair px-2.5 py-1 font-mono text-[11px] text-teal underline"
                >
                  {e.label}
                </button>
              ) : (
                <span className="inline-block rounded-full border border-hair px-2.5 py-1 font-mono text-[11px] text-ink2">
                  {e.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
