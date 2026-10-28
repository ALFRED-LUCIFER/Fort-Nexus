import { useId, useState, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentKey, Plan, PlanStatus, PlanStep, PlanStepAction, PlanStepStatus } from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { ago, clock, useNow } from "../lib/queries.ts";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";
import { useWatchlists } from "./research.tsx";
import { PICK_PROJECT, useScope, type Scope } from "./scope.tsx";
import { EmptyZone, Node } from "./zones.tsx";

// EPIC AGT FR-AGT-01/09: the Plans & queue zone and the plan:<uuid> drawer. The model only drafts; the owner approves
// the exact hash; each step succeeds only on its source record, which the drawer cites.

const route = getRouteApi("/");
const POLL_MS = 5_000;
const ZONE_PLANS = 4;

const ghostBtn =
  "rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink disabled:opacity-45";
const primaryBtn = "rounded-xl bg-teal px-4 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60";

const AGENT: Record<AgentKey, string> = {
  CHIEF_OF_STAFF: "Chief of Staff",
  DEVELOPER: "Developer",
  QA: "QA",
  DEVOPS: "DevOps",
  PRODUCT: "Product",
  AI_RESEARCHER: "AI researcher",
  FINANCIAL_ANALYST: "Financial analyst",
};

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
          <ul className="m-0 flex list-none flex-wrap content-start gap-[30px] p-0">
            {items.slice(0, ZONE_PLANS).map((p) => (
              <li key={p.id}>
                <Node
                  dot={PLAN[p.status].tone}
                  live={p.status === "RUNNING"}
                  kicker={`${PLAN[p.status].text} · ${p.steps.length} ${p.steps.length === 1 ? "step" : "steps"}`}
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
    (blockedSteps
      ? `${blockedSteps} blocked ${blockedSteps === 1 ? "step" : "steps"}: deny it and draft a new plan.`
      : null);
  const error = decide.error ?? cancel.error;
  const busy = decide.isPending || cancel.isPending;
  const openRun = (jobId: string) => void navigate({ search: { ...scope.keep, drawer: `run:${jobId}` } });

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
          <ol aria-labelledby="plan-steps" className="m-0 flex list-none flex-col gap-2.5 p-0">
            {p.steps.map((s) => (
              <StepRow key={s.index} s={s} action={actionText(s.action, watchlists)} onOpenRun={openRun} />
            ))}
          </ol>
        </section>

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

function StepRow({
  s,
  action,
  onOpenRun,
}: {
  s: PlanStep;
  action: string;
  onOpenRun: (jobId: string) => void;
}) {
  return (
    <li className="flex flex-col gap-1.5 rounded-2xl border border-hair px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-serif text-[20px] leading-none">{s.index + 1}</span>
        <Chip tone={STEP[s.status].tone}>{STEP[s.status].text}</Chip>
        <span className="font-mono text-[11px] text-ink3">
          {AGENT[s.agent]}
          {s.dependsOn.length ? ` · after ${s.dependsOn.map((d) => `step ${d + 1}`).join(", ")}` : ""}
        </span>
      </div>
      <span className="text-[14px] leading-[1.35] font-medium text-ink">{s.title}</span>
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
              {e.kind === "JOB" ? (
                <button
                  type="button"
                  onClick={() => onOpenRun(e.id)}
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
