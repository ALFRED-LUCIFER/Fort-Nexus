import { useEffect, useRef, useState, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CreateJobRequest,
  WORK_BRANCH_PREFIX,
  type IssueDetail,
  type Repository,
  type Runner,
} from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { useScope } from "./scope.tsx";

const route = getRouteApi("/");

// Defaults and caps come from the contract itself, so the form can't drift from what the API accepts.
const IssueJob = CreateJobRequest.options[1];
const Budget = IssueJob.shape.budget.unwrap();
const DEFAULTS = Budget.parse({});
const cap = (k: keyof typeof DEFAULTS) => Budget.shape[k].unwrap();

const FIELDS = [
  {
    key: "maxWallClockMinutes",
    label: "Time limit (minutes)",
    step: 1,
    hint: `${cap("maxWallClockMinutes").minValue}–${cap("maxWallClockMinutes").maxValue}`,
    error: `Enter whole minutes from ${cap("maxWallClockMinutes").minValue} to ${cap("maxWallClockMinutes").maxValue}.`,
  },
  {
    key: "maxTurns",
    label: "Agent turns",
    step: 1,
    hint: `${cap("maxTurns").minValue}–${cap("maxTurns").maxValue}`,
    error: `Enter whole turns from ${cap("maxTurns").minValue} to ${cap("maxTurns").maxValue}.`,
  },
  {
    key: "maxCostUsd",
    label: "Model cost cap (USD)",
    step: 0.5,
    hint: `up to $${cap("maxCostUsd").maxValue}`,
    error: `Enter an amount above $0 and at most $${cap("maxCostUsd").maxValue}.`,
  },
] as const;
type BudgetKey = (typeof FIELDS)[number]["key"];

const input =
  "w-full min-w-0 rounded-lg border border-hair bg-card px-2.5 py-1.5 font-mono text-[12.5px] text-ink aria-[invalid=true]:border-coral";

/**
 * "Here's exactly what will happen" for an issue → draft PR run. One Idempotency-Key per previewed body:
 * a retry of the same preview reuses it, so the API answers with the original job instead of a second one.
 */
export function StartRunPreview({
  projectId,
  repoId,
  repo,
  detail,
  runner,
  onCancel,
}: {
  /** The project the run belongs to; the API checks the repository is bound to it. */
  projectId: string;
  repoId: string;
  repo: Repository | undefined;
  detail: IssueDetail;
  runner: Runner | undefined;
  onCancel: () => void;
}) {
  const navigate = route.useNavigate();
  const { keep } = useScope();
  const queryClient = useQueryClient();
  const [base, setBase] = useState(repo?.defaultBranch ?? "");
  const [budget, setBudget] = useState<Record<BudgetKey, string>>({
    maxWallClockMinutes: String(DEFAULTS.maxWallClockMinutes),
    maxTurns: String(DEFAULTS.maxTurns),
    maxCostUsd: String(DEFAULTS.maxCostUsd),
  });
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const sectionRef = useRef<HTMLElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => firstRef.current?.focus(), []);

  const n = detail.issue.number;
  const body = {
    jobType: "DEV_ISSUE_TO_PR" as const,
    projectId,
    repositoryId: repoId,
    issueNumber: n,
    ...(base.trim() && { baseBranch: base.trim() }),
    budget: {
      maxWallClockMinutes: Number(budget.maxWallClockMinutes),
      maxTurns: Number(budget.maxTurns),
      maxCostUsd: Number(budget.maxCostUsd),
    },
  };
  const parsed = IssueJob.safeParse(body);
  // Blank number fields become 0 and fail the schema, as do fractions where whole numbers are required.
  const bad = new Set(parsed.error?.issues.map((i) => i.path.at(-1)));
  const invalid = (k: BudgetKey | "baseBranch") => bad.has(k);

  const create = useMutation({
    mutationFn: () => api.createJob(IssueJob.parse(body), idemKey),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: keys.jobs });
      void navigate({ search: { ...keep, drawer: `run:${res.jobId}` } });
    },
  });
  const change = (apply: () => void) => {
    apply();
    setIdemKey(crypto.randomUUID()); // different body ⇒ different request
  };
  const submit = () => {
    if (!parsed.success)
      return sectionRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
    create.mutate();
  };

  const online = runner?.status === "ONLINE";
  const rows: [string, ReactNode][] = [
    ["Repository", repo?.fullName ?? `repository ${repoId}`],
    ["Issue", `#${n} ${detail.issue.title}`],
    [
      "Work branch",
      <code key="b" className="font-mono text-[12px] break-all">
        {WORK_BRANCH_PREFIX}issue-{n}-…
      </code>,
    ],
    [
      "Runs on",
      runner
        ? `${runner.name} · ${runner.status.toLowerCase()} · sandbox, no GitHub access`
        : "No runner paired yet",
    ],
    ["Risk", "R1 run · R2 push gate"],
    ["Push + draft PR", "Only after you approve the exact change"],
  ];

  return (
    <section
      ref={sectionRef}
      aria-labelledby="run-preview-title"
      id="run-preview"
      className="flex flex-none flex-col gap-4 rounded-[22px] border border-hair bg-card px-5 py-5"
    >
      <h3 id="run-preview-title" className="m-0 font-serif text-[22px] leading-tight font-normal italic">
        Here’s exactly what will happen.
      </h3>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex min-w-0 flex-col gap-1.5">
            <dt className="kicker">{k}</dt>
            <dd className="m-0 text-[13px] leading-snug break-words">{v}</dd>
          </div>
        ))}
      </dl>

      <fieldset className="m-0 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3 border-0 p-0">
        <legend className="kicker mb-2.5 p-0">Base branch and budget</legend>
        <div className="flex min-w-0 flex-col gap-1 text-[11.5px] text-ink3">
          <label htmlFor="run-base">Base branch</label>
          <input
            id="run-base"
            ref={firstRef}
            value={base}
            placeholder="repository default"
            aria-invalid={invalid("baseBranch")}
            aria-describedby="base-hint"
            onChange={(e) => change(() => setBase(e.target.value))}
            className={input}
          />
          <span id="base-hint" className="text-[11px]">
            {repo && base.trim() === repo.defaultBranch
              ? "repository default"
              : "branched from here, never pushed to"}
          </span>
        </div>
        {FIELDS.map((f) => (
          <div key={f.key} className="flex min-w-0 flex-col gap-1 text-[11.5px] text-ink3">
            <label htmlFor={`run-${f.key}`}>{f.label}</label>
            <input
              id={`run-${f.key}`}
              type="number"
              inputMode="decimal"
              step={f.step}
              min={f.key === "maxCostUsd" ? 0 : (cap(f.key).minValue ?? undefined)}
              max={cap(f.key).maxValue ?? undefined}
              value={budget[f.key]}
              aria-invalid={invalid(f.key)}
              aria-describedby={`${f.key}-hint`}
              onChange={(e) => change(() => setBudget({ ...budget, [f.key]: e.target.value }))}
              className={input}
            />
            <span id={`${f.key}-hint`} className={`text-[11px] ${invalid(f.key) ? "text-coral" : ""}`}>
              {invalid(f.key) ? f.error : f.hint}
            </span>
          </div>
        ))}
      </fieldset>

      {detail.missingAcceptanceCriteria && (
        <p className="m-0 text-[12.5px] leading-snug text-ink2">
          No acceptance criteria found. The run is allowed; the agent works from the issue text alone.
        </p>
      )}
      {!online && (
        <p
          className="m-0 rounded-xl px-3 py-2.5 text-[12.5px] leading-snug"
          style={{ background: "oklch(0.70 0.13 65 / .15)" }}
        >
          {runner
            ? `${runner.name} is ${runner.status.toLowerCase()}. The run will be queued and held, not lost, until it reconnects.`
            : "No runner is paired. The run will be queued and held, not lost, until you pair one in Systems."}
        </p>
      )}
      {create.error && (
        <p role="alert" className="m-0 text-[13px] text-coral">
          {create.error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-ink3">
          Runs at home in a sandbox. Push and PR always ask you first.
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink2"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={create.isPending}
            onClick={submit}
            className="rounded-xl bg-teal px-3.5 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60"
          >
            {create.isPending ? "Starting…" : "Confirm and start"}
          </button>
        </div>
      </div>
    </section>
  );
}
