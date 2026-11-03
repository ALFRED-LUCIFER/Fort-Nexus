import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  JOB_DRAFT_TEXT_MAX,
  JobDraftBudget,
  type JobDraft,
  type JobDraftPreview,
  type JobDraftStatus,
  type Runner,
  type UpdateJobDraftRequest,
} from "@nexus/contracts";
import { ApiRequestError, api, keys } from "../lib/api.ts";
import {
  ago,
  preferredRunner,
  shortHash,
  until,
  useGithubStatus,
  useNow,
  useRepositories,
  useRunners,
} from "../lib/queries.ts";
import { AiError } from "./aiInference.tsx";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";
import { githubSetupHint } from "./github.tsx";
import { useScope, type Scope } from "./scope.tsx";

// Jobs wave D (FR-CMD-02/04/05, CMD-G01, FR-CXR-09): a job in plain words. The Developer agent only drafts; the
// server resolves the repository and builds the exact issue and run; the owner approves that exact preview hash.
// "Created" and "started" come only from the server's answer.

const route = getRouteApi("/");

const ghostBtn =
  "rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink disabled:opacity-45";
const primaryBtn = "rounded-xl bg-teal px-4 py-2.5 text-[12.5px] font-medium text-onacc disabled:opacity-60";
const field =
  "w-full min-w-0 rounded-xl border border-hair bg-card px-3 py-2 text-[13px] text-ink aria-[invalid=true]:border-coral";

// Colour is always paired with text (WCAG 1.4.1).
const STATUS: Record<JobDraftStatus, { text: string; tone: string }> = {
  READY: { text: "Ready · preview, then approve", tone: "var(--amber)" },
  NEEDS_REPO: { text: "Needs a repository", tone: "var(--amber)" },
  UNSUPPORTED: { text: "Not a job NEXUS can run", tone: "var(--ink3)" },
  STARTED: { text: "Started", tone: "var(--green)" },
  DISCARDED: { text: "Discarded", tone: "var(--ink3)" },
  FAILED: { text: "Failed", tone: "var(--coral)" },
};

// "Rewrite" hands the owner's words back to the New job form through the app's query cache (per app, not global).
const REWRITE = ["new-job", "rewrite"] as const;
const LISTS = [...keys.jobDrafts, "list"] as const;

/** Why a job can't be drafted here; null when the project can run coding jobs. */
export function newJobBlocked(scope: Scope): string | null {
  if (scope.blocked) return scope.blocked;
  if (scope.project && scope.project.repositoryIds.length === 0)
    return `No repositories are bound to ${scope.project.name}. Bind one in Settings → Workspaces, then describe the job.`;
  return null;
}

/** What's wrong with the typed words before anything is sent (CreateJobDraftRequest bounds). */
export function jobTextProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return "Describe the job first, for example “add a dark mode toggle in acme/web”.";
  if (t.length < 3) return "Say a little more: at least 3 characters.";
  if (t.length > JOB_DRAFT_TEXT_MAX) return `Keep it under ${JOB_DRAFT_TEXT_MAX} characters.`;
  return null;
}

type Ask = { text: string; projectId: string; repositoryId: string | undefined; key: string };

/**
 * Drafts a job in the current project and opens its drawer. A retry of the same words (and repository) reuses its
 * Idempotency-Key, so the model is called once. Shared by New job and the command bar's Execute.
 */
export function useCreateJobDraft(onCreated?: () => void) {
  const scope = useScope();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const [last, setLast] = useState<Ask | null>(null);
  const mutation = useMutation({
    mutationFn: (a: Ask) =>
      api.createJobDraft(
        { projectId: a.projectId, text: a.text, ...(a.repositoryId && { repositoryId: a.repositoryId }) },
        a.key,
      ),
    onSuccess: (d) => {
      setLast(null);
      queryClient.setQueryData(keys.jobDraft(d.id), d);
      void queryClient.invalidateQueries({ queryKey: LISTS });
      onCreated?.();
      void navigate({ search: { ...scope.keep, drawer: `jobdraft:${d.id}` } });
    },
  });
  const blocked = newJobBlocked(scope);
  const projectId = scope.project?.id;
  return {
    blocked,
    pending: mutation.isPending,
    error: mutation.error,
    create: (text: string, repositoryId?: string) => {
      const t = text.trim();
      if (blocked || !projectId || jobTextProblem(t) || mutation.isPending) return;
      const same =
        last?.text === t && last.projectId === projectId && last.repositoryId === repositoryId ? last : null;
      const a = same ?? { text: t, projectId, repositoryId, key: crypto.randomUUID() };
      setLast(a);
      mutation.mutate(a);
    },
  };
}

function StatusChip({ status }: { status: JobDraftStatus }) {
  const s = STATUS[status];
  return (
    <span className="kicker inline-flex items-center gap-1.5" style={{ color: s.tone }}>
      <span aria-hidden="true" className="size-1.5 flex-none rounded-full" style={{ background: s.tone }} />
      {s.text}
    </span>
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

function CreatedLink({ issue, repo }: { issue: NonNullable<JobDraft["createdIssue"]>; repo?: string }) {
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 self-start rounded-xl px-3 py-2.5 font-mono text-[12px] text-green underline"
      style={{ background: "color-mix(in oklch, var(--green) 12%, transparent)" }}
    >
      <span aria-hidden="true">✓</span> Created #{issue.number}
      {repo && ` on ${repo}`}
      <span className="sr-only"> (opens GitHub in a new tab)</span>
    </a>
  );
}

// ---------------------------------------------------------------- New job

/** `drawer=newjob`: describe the job in plain words; below, the scope's recent drafts. */
export function NewJobDrawer({ banner, onClose }: { banner?: ReactNode; onClose: () => void }) {
  return (
    <Drawer banner={banner} onClose={onClose}>
      <DrawerHeader kicker="New job · Developer agent" title="New job" />
      <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-6 py-5">
        <NewJobForm />
        <RecentDrafts />
      </div>
    </Drawer>
  );
}

function NewJobForm() {
  const scope = useScope();
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => queryClient.getQueryData<string>(REWRITE) ?? "");
  const [repoId, setRepoId] = useState("");
  const [tried, setTried] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const textId = useId();
  const hintId = useId();
  const reasonId = useId();
  const repoSelectId = useId();
  const drafting = useCreateJobDraft();
  const blocked = drafting.blocked;

  useEffect(() => {
    queryClient.removeQueries({ queryKey: REWRITE, exact: true });
    textRef.current?.focus();
  }, [queryClient]);

  const github = useGithubStatus();
  const installed = github.data?.configured === true && github.data.installations.length > 0;
  const repos = useRepositories(installed && !!scope.project && !blocked, scope.project?.id);
  const hint = githubSetupHint(github);
  const problem = jobTextProblem(text);
  const showProblem = tried && !!problem;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem) return textRef.current?.focus();
    drafting.create(text, repoId || undefined);
  };

  return (
    <form aria-label="Describe a new job" onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <p className="m-0 text-[13.5px] leading-relaxed text-ink2">
        The Developer agent drafts a GitHub issue from your words. You check the exact preview and approve
        once: then NEXUS creates the issue and starts the run. Nothing happens before that.
      </p>
      <label htmlFor={textId} className="kicker">
        Describe the job in plain words
      </label>
      <textarea
        id={textId}
        ref={textRef}
        rows={4}
        maxLength={JOB_DRAFT_TEXT_MAX}
        value={text}
        aria-invalid={showProblem}
        aria-describedby={hintId}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. implement CSV export of orders in acme/web"
        className={`${field} resize-y leading-normal`}
      />
      <span id={hintId} className={`text-[11.5px] ${showProblem ? "text-coral" : "text-ink3"}`}>
        {showProblem ? problem : "Name the repository if the project has several; NEXUS never guesses one."}
      </span>

      {scope.project && !blocked && (
        <div className="flex flex-col gap-1">
          {hint ? (
            <div className="text-[12.5px]">{hint}</div>
          ) : repos.error ? (
            <p className="m-0 text-[12.5px] leading-snug text-ink2">
              Can&apos;t list repositories: {repos.error.message} You can still draft it; NEXUS asks if the
              repository is unclear.
            </p>
          ) : !repos.data ? (
            <p role="status" className="m-0 text-[12.5px] text-ink3">
              Loading repositories…
            </p>
          ) : (
            repos.data.items.length > 0 && (
              <>
                <label htmlFor={repoSelectId} className="kicker">
                  Repository (optional)
                </label>
                <select
                  id={repoSelectId}
                  value={repoId}
                  onChange={(e) => setRepoId(e.target.value)}
                  className={field}
                >
                  <option value="">From my words (NEXUS asks if unclear)</option>
                  {repos.data.items.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.fullName}
                    </option>
                  ))}
                </select>
              </>
            )
          )}
        </div>
      )}

      {blocked && (
        <p id={reasonId} className="m-0 text-[12.5px] leading-snug text-ink2">
          {blocked}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!!blocked || drafting.pending}
          aria-describedby={blocked ? reasonId : undefined}
          className={primaryBtn}
        >
          {drafting.pending ? "Drafting…" : "Draft it"}
        </button>
        {drafting.pending && (
          <p role="status" className="m-0 text-[12.5px] text-ink2">
            The Developer agent is drafting the issue…
          </p>
        )}
      </div>
      {drafting.error && !drafting.pending && (
        <div className="flex flex-col gap-1">
          <AiError error={drafting.error} />
          <p className="m-0 text-[12px] text-ink3">Draft it again: the same words are drafted once.</p>
        </div>
      )}
    </form>
  );
}

function RecentDrafts() {
  const scope = useScope();
  const navigate = route.useNavigate();
  const now = useNow(30_000);
  const projectId = scope.project?.id;
  const list = useQuery({
    queryKey: keys.jobDraftsOf(projectId),
    queryFn: () => api.jobDrafts(projectId),
    enabled: scope.ready,
  });
  return (
    <section aria-labelledby="newjob-recent" className="flex flex-col gap-3">
      <h3 id="newjob-recent" className="kicker m-0">
        Recent drafts{projectId ? "" : " · all projects"}
      </h3>
      {!list.data ? (
        list.error ? (
          <ErrorText error={list.error} />
        ) : (
          <p role="status" className="m-0 text-[13px] text-ink3">
            Loading drafts…
          </p>
        )
      ) : (
        <>
          {list.error && (
            <p role="status" className="m-0 text-[12.5px] text-amber">
              Can&apos;t refresh: {list.error.message} Showing what NEXUS had.
            </p>
          )}
          {list.data.items.length === 0 ? (
            <p className="m-0 text-[13px] text-ink2">No drafts yet. Describe a job above to start one.</p>
          ) : (
            <ul aria-label="Recent drafts" className="m-0 flex list-none flex-col gap-2 p-0">
              {list.data.items.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => void navigate({ search: { ...scope.keep, drawer: `jobdraft:${d.id}` } })}
                    className="flex w-full flex-col gap-1.5 rounded-[14px] border border-hair bg-card px-3.5 py-3 text-left hover:bg-hair"
                  >
                    <span className="line-clamp-2 text-[13.5px] leading-snug text-ink">{d.text}</span>
                    <span className="flex flex-wrap items-center gap-3">
                      <StatusChip status={d.status} />
                      {d.repository && (
                        <span className="font-mono text-[11px] text-ink3">{d.repository.fullName}</span>
                      )}
                      <span className="font-mono text-[11px] text-ink3">{ago(d.createdAt, now)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list.data.nextCursor && (
            <p className="m-0 text-[12px] text-ink3">Showing the newest {list.data.items.length}.</p>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- one draft

const draftTitle = (d: JobDraft) =>
  d.issue?.title ??
  (d.issueNumber
    ? `Issue #${d.issueNumber}${d.repository ? ` on ${d.repository.fullName}` : ""}`
    : "Job draft");

/** `drawer=jobdraft:<uuid>`: one draft, by status. */
export function JobDraftDrawer({
  id,
  banner,
  onClose,
}: {
  id: string;
  banner?: ReactNode;
  onClose: () => void;
}) {
  const q = useQuery({ queryKey: keys.jobDraft(id), queryFn: () => api.jobDraft(id) });
  return (
    <Drawer banner={banner} onClose={onClose}>
      <DrawerHeader kicker="New job · draft" title={q.data ? draftTitle(q.data) : "Job draft"} />
      {q.data ? <DraftBody key={q.data.id} d={q.data} stale={q.error} /> : <DrawerState error={q.error} />}
    </Drawer>
  );
}

const draftBlocked = (scope: Scope, d: JobDraft): string | null =>
  scope.blocked ??
  (scope.project?.id === d.projectId ? null : "This draft belongs to another project: switch to it first.");

/** A preview counts only for the runner it was made for. */
type Held = { preview: JobDraftPreview; runnerId: string };

function DraftBody({ d, stale }: { d: JobDraft; stale: Error | null }) {
  const scope = useScope();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const now = useNow(5_000);
  const blocked = draftBlocked(scope, d);
  const blockedId = useId();
  const runners = useRunners();
  const [runnerChoice, setRunnerChoice] = useState<string | null>(null);
  const runnerId = runnerChoice ?? preferredRunner(runners.data)?.id ?? "";
  const [held, setHeld] = useState<Held | null>(null);
  const preview = held && held.runnerId === runnerId ? held.preview : null;
  const live = !!preview && Date.parse(preview.expiresAt) > now;

  const saved = (next: JobDraft) => {
    queryClient.setQueryData(keys.jobDraft(d.id), next);
    void queryClient.invalidateQueries({ queryKey: LISTS });
  };
  const makePreview = useMutation({
    mutationFn: async ({ edits, runner }: { edits: UpdateJobDraftRequest | null; runner: string }) => {
      // Edits are saved first, so the preview (and its hash) is of what the server stored.
      if (edits) saved(await api.updateJobDraft(d.id, edits));
      return {
        preview: await api.previewJobDraft(d.id, runner ? { runnerId: runner } : {}),
        runnerId: runner,
      };
    },
    onMutate: () => setHeld(null),
    onSuccess: setHeld,
  });
  const approve = useMutation({
    mutationFn: (p: JobDraftPreview) =>
      api.approveJobDraft(d.id, { actionHash: p.actionHash }, `jobdraft:${d.id}:${p.actionHash}`),
    onSuccess: (next) => {
      saved(next);
      void queryClient.invalidateQueries({ queryKey: keys.jobs });
    },
    // A failed approve may have moved the draft to FAILED (with the issue kept): show the server's state.
    onError: () => void queryClient.invalidateQueries({ queryKey: keys.jobDraft(d.id) }),
  });
  const discard = useMutation({
    mutationFn: () => api.discardJobDraft(d.id),
    onSuccess: (next) => {
      setHeld(null);
      saved(next);
    },
  });

  // When the draft moves to another state, its heading takes focus so the change is announced and Tab starts there.
  const statusRef = useRef<HTMLHeadingElement>(null);
  const shownStatus = useRef(d.status);
  useEffect(() => {
    if (shownStatus.current === d.status) return;
    shownStatus.current = d.status;
    statusRef.current?.focus();
  }, [d.status]);

  const canPreview = d.status === "READY" || d.status === "FAILED";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
      <div className="flex flex-col gap-2">
        <h3 ref={statusRef} tabIndex={-1} className="m-0 outline-none">
          <span className="sr-only">Status:</span> <StatusChip status={d.status} />
        </h3>
        {stale && (
          <p role="status" className="m-0 text-[12.5px] text-amber">
            Can&apos;t refresh: {stale.message} Showing what NEXUS had.
          </p>
        )}
      </div>

      <section aria-labelledby="draft-asked" className="flex flex-col gap-1.5">
        <h3 id="draft-asked" className="kicker m-0">
          You asked
        </h3>
        <p className="m-0 text-[14px] leading-relaxed break-words whitespace-pre-wrap text-ink">{d.text}</p>
      </section>

      {blocked && d.status !== "STARTED" && d.status !== "DISCARDED" && (
        <p id={blockedId} className="m-0 text-[12.5px] leading-snug text-ink2">
          {blocked}
        </p>
      )}

      {d.status === "NEEDS_REPO" && (
        <NeedsRepo d={d} blocked={blocked} blockedId={blockedId} onSaved={saved} />
      )}
      {d.status === "UNSUPPORTED" && <Unsupported d={d} />}
      {d.status === "READY" && (
        <Ready
          key={d.updatedAt}
          d={d}
          blocked={blocked}
          blockedId={blockedId}
          runners={runners.data}
          runnerId={runnerId}
          onRunner={setRunnerChoice}
          onEdit={() => setHeld(null)}
          previewing={makePreview.isPending}
          onPreview={(edits) => makePreview.mutate({ edits, runner: runnerId })}
        />
      )}
      {d.status === "STARTED" && <Started d={d} />}
      {d.status === "FAILED" && (
        <section aria-labelledby="draft-failed" className="flex flex-col gap-3">
          <h3 id="draft-failed" className="kicker m-0 text-coral">
            What went wrong
          </h3>
          <p className="m-0 text-[13.5px] leading-snug text-ink">
            {d.error ?? "The approved action didn't finish."}
          </p>
          {d.createdIssue && <CreatedLink issue={d.createdIssue} repo={d.repository?.fullName} />}
          <p className="m-0 text-[12.5px] leading-snug text-ink2">
            Trying again resumes where it stopped: it never creates a second issue or job.
          </p>
          <button
            type="button"
            disabled={!!blocked || approve.isPending || makePreview.isPending}
            aria-describedby={blocked ? blockedId : undefined}
            onClick={() =>
              live && preview
                ? approve.mutate(preview)
                : makePreview.mutate({ edits: null, runner: runnerId })
            }
            className={`${primaryBtn} self-start`}
          >
            {approve.isPending
              ? "Trying again…"
              : makePreview.isPending
                ? "Building the preview…"
                : "Try again"}
          </button>
        </section>
      )}
      {d.status === "DISCARDED" && (
        <section className="flex flex-col gap-3">
          <p className="m-0 text-[13.5px] text-ink2">Discarded. Nothing more happens with this draft.</p>
          {d.createdIssue && <CreatedLink issue={d.createdIssue} repo={d.repository?.fullName} />}
        </section>
      )}

      {canPreview && <ErrorText error={makePreview.error} />}
      {canPreview && preview && (
        <PreviewCard
          preview={preview}
          live={live}
          now={now}
          blocked={blocked}
          blockedId={blockedId}
          approving={approve.isPending}
          onApprove={() => approve.mutate(preview)}
        />
      )}
      {d.status === "READY" && !preview && (
        <p className="m-0 text-[12.5px] text-ink3">
          Preview first: approval binds to exactly what you saw, and nothing runs before it.
        </p>
      )}
      {canPreview && approve.isPending && (
        <p role="status" className="m-0 text-[12.5px] text-ink2">
          {preview?.riskTier === "R2"
            ? "Creating the issue on GitHub, then starting the run. Nothing shows as created until GitHub confirms."
            : "Starting the run. Nothing shows as started until NEXUS confirms."}
        </p>
      )}
      {canPreview && <ErrorText error={approve.error} />}
      {canPreview && approve.error instanceof ApiRequestError && approve.error.status === 0 && (
        <p className="m-0 text-[12.5px] text-ink2">
          If GitHub did create the issue, approving again finds it instead of making a second one.
        </p>
      )}

      {d.status !== "STARTED" && d.status !== "DISCARDED" && (
        <div className="flex flex-col gap-1.5 border-t border-hair pt-4">
          <button
            type="button"
            disabled={!!blocked || discard.isPending || approve.isPending}
            aria-describedby={blocked ? blockedId : undefined}
            onClick={() => discard.mutate()}
            className={`${ghostBtn} self-start`}
          >
            {discard.isPending ? "Discarding…" : "Discard draft"}
          </button>
          <ErrorText error={discard.error} />
        </div>
      )}
      {d.status === "STARTED" && d.jobId && (
        <button
          type="button"
          onClick={() => void navigate({ search: { ...scope.keep, drawer: `run:${d.jobId}` } })}
          className={`${primaryBtn} self-start`}
        >
          Open the run
        </button>
      )}
    </div>
  );
}

function NeedsRepo({
  d,
  blocked,
  blockedId,
  onSaved,
}: {
  d: JobDraft;
  blocked: string | null;
  blockedId: string;
  onSaved: (d: JobDraft) => void;
}) {
  const [choice, setChoice] = useState("");
  const chosen = choice || (d.candidates.length === 1 ? d.candidates[0]!.id : "");
  const patch = useMutation({
    mutationFn: (repositoryId: string) => api.updateJobDraft(d.id, { repositoryId }),
    onSuccess: onSaved,
  });
  if (d.candidates.length === 0)
    return (
      <p className="m-0 text-[13.5px] leading-snug text-ink2">
        No repositories are bound to this project. Bind one in Settings → Workspaces, then draft the job
        again.
      </p>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen && !blocked) patch.mutate(chosen);
      }}
      className="flex flex-col gap-3"
    >
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 font-serif text-[20px] leading-tight">Which repository?</legend>
        <p className="m-0 text-[12.5px] leading-snug text-ink2">
          NEXUS never guesses a repository. Pick the one this job is for; only this project&apos;s bound
          repositories are offered.
        </p>
        {d.candidates.map((r) => (
          <label
            key={r.id}
            className="flex items-center gap-2.5 rounded-xl border border-hair px-3 py-2.5 font-mono text-[12.5px] text-ink"
          >
            <input
              type="radio"
              name={`draft-repo-${d.id}`}
              value={r.id}
              checked={chosen === r.id}
              onChange={() => setChoice(r.id)}
            />
            {r.fullName}
          </label>
        ))}
      </fieldset>
      <button
        type="submit"
        disabled={!chosen || !!blocked || patch.isPending}
        aria-describedby={blocked ? blockedId : undefined}
        className={`${primaryBtn} self-start`}
      >
        {patch.isPending ? "Saving…" : "Use this repository"}
      </button>
      <ErrorText error={patch.error} />
    </form>
  );
}

function Unsupported({ d }: { d: JobDraft }) {
  const scope = useScope();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  return (
    <section aria-labelledby="draft-unsupported" className="flex flex-col gap-3">
      <h3 id="draft-unsupported" className="kicker m-0">
        Why NEXUS can&apos;t run this
      </h3>
      <p className="kicker m-0 text-ink2">AI-drafted · the Developer agent&apos;s reading of your words</p>
      <p className="m-0 text-[13.5px] leading-snug break-words text-ink">
        {d.unsupportedReason ?? "This isn't a code change in a repository."}
      </p>
      <p className="m-0 text-[12.5px] leading-snug text-ink2">
        A job changes code in one of this project&apos;s repositories through a GitHub issue. Shell commands,
        deploys and merges aren&apos;t jobs.
      </p>
      <button
        type="button"
        onClick={() => {
          queryClient.setQueryData(REWRITE, d.text);
          void navigate({ search: { ...scope.keep, drawer: "newjob" } });
        }}
        className={`${ghostBtn} self-start`}
      >
        Rewrite
      </button>
    </section>
  );
}

const cap = (k: keyof JobDraftBudget) => JobDraftBudget.shape[k];
const BUDGET_FIELDS = [
  {
    key: "maxWallClockMinutes",
    label: "Time limit (minutes)",
    step: 1,
    min: cap("maxWallClockMinutes").minValue ?? undefined,
    hint: `${cap("maxWallClockMinutes").minValue}–${cap("maxWallClockMinutes").maxValue}`,
    error: `Enter whole minutes from ${cap("maxWallClockMinutes").minValue} to ${cap("maxWallClockMinutes").maxValue}.`,
  },
  {
    key: "maxTurns",
    label: "Agent turns",
    step: 1,
    min: cap("maxTurns").minValue ?? undefined,
    hint: `${cap("maxTurns").minValue}–${cap("maxTurns").maxValue}`,
    error: `Enter whole turns from ${cap("maxTurns").minValue} to ${cap("maxTurns").maxValue}.`,
  },
  {
    key: "maxCostUsd",
    label: "Model cost cap (USD)",
    step: 0.5,
    min: 0,
    hint: `up to $${cap("maxCostUsd").maxValue}`,
    error: `Enter an amount above $0 and at most $${cap("maxCostUsd").maxValue}.`,
  },
] as const;

function Ready({
  d,
  blocked,
  blockedId,
  runners,
  runnerId,
  onRunner,
  onEdit,
  previewing,
  onPreview,
}: {
  d: JobDraft;
  blocked: string | null;
  blockedId: string;
  runners: readonly Runner[] | undefined;
  runnerId: string;
  onRunner: (id: string) => void;
  /** Any change drops the preview: it no longer shows what would happen. */
  onEdit: () => void;
  previewing: boolean;
  onPreview: (edits: UpdateJobDraftRequest | null) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const ids = { title: useId(), body: useId(), runner: useId() };
  const [title, setTitle] = useState(d.issue?.title ?? "");
  const [body, setBody] = useState(d.issue?.body ?? "");
  const [budget, setBudget] = useState<Record<keyof JobDraftBudget, string>>({
    maxWallClockMinutes: String(d.budget.maxWallClockMinutes),
    maxTurns: String(d.budget.maxTurns),
    maxCostUsd: String(d.budget.maxCostUsd),
  });
  const change = (apply: () => void) => {
    apply();
    onEdit();
  };

  const parsedBudget = JobDraftBudget.safeParse({
    maxWallClockMinutes: Number(budget.maxWallClockMinutes),
    maxTurns: Number(budget.maxTurns),
    maxCostUsd: Number(budget.maxCostUsd),
  });
  const badBudget = new Set(parsedBudget.error?.issues.map((i) => i.path.at(-1)));
  const titleBad = !!d.issue && title.trim().length < 3;
  const bodyBad = !!d.issue && body.trim().length === 0;

  const edits = (): UpdateJobDraftRequest | null => {
    const e: UpdateJobDraftRequest = {};
    if (d.issue && title.trim() !== d.issue.title) e.title = title.trim();
    if (d.issue && body.trim() !== d.issue.body) e.body = body.trim();
    if (
      parsedBudget.success &&
      (Object.keys(d.budget) as (keyof JobDraftBudget)[]).some((k) => parsedBudget.data[k] !== d.budget[k])
    )
      e.budget = parsedBudget.data;
    return Object.keys(e).length > 0 ? e : null;
  };

  const runner = runners?.find((r) => r.id === runnerId);
  const usable = runners?.filter((r) => r.status !== "REVOKED") ?? [];

  return (
    <form
      ref={formRef}
      aria-label="Review the job"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (titleBad || bodyBad || !parsedBudget.success)
          return formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        onPreview(edits());
      }}
      className="flex flex-col gap-5"
    >
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3.5">
        <div className="flex min-w-0 flex-col gap-1.5">
          <dt className="kicker">Repository</dt>
          <dd className="m-0 font-mono text-[12.5px] break-words">{d.repository?.fullName ?? "—"}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <dt className="kicker">Starts from</dt>
          <dd className="m-0 text-[13px]">
            {d.kind === "EXISTING_ISSUE" && d.issueNumber
              ? `Existing issue #${d.issueNumber}`
              : "A new issue, created on approval"}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <dt className="kicker">Then runs</dt>
          <dd className="m-0 text-[13px]">The Developer agent, in a sandbox at home</dd>
        </div>
      </dl>

      {d.issue && (
        <section aria-labelledby="draft-issue" className="flex flex-col gap-2.5">
          <h3 id="draft-issue" className="kicker m-0 text-violet">
            AI-drafted · review before approving
          </h3>
          <label htmlFor={ids.title} className="text-[12px] text-ink2">
            Issue title
          </label>
          <input
            id={ids.title}
            value={title}
            maxLength={256}
            aria-invalid={titleBad}
            onChange={(e) => change(() => setTitle(e.target.value))}
            className={field}
          />
          {titleBad && (
            <span className="text-[11.5px] text-coral">The title needs at least 3 characters.</span>
          )}
          <label htmlFor={ids.body} className="text-[12px] text-ink2">
            Issue body
          </label>
          <textarea
            id={ids.body}
            rows={10}
            value={body}
            maxLength={20_000}
            aria-invalid={bodyBad}
            onChange={(e) => change(() => setBody(e.target.value))}
            className={`${field} resize-y font-mono text-[12px] leading-[1.5]`}
          />
          {bodyBad && <span className="text-[11.5px] text-coral">The body can&apos;t be empty.</span>}
          <span className="text-[11.5px] text-ink3">
            NEXUS removes mentions and links and keeps its footer, so the issue can&apos;t ping anyone.
          </span>
        </section>
      )}

      <fieldset className="m-0 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3 border-0 p-0">
        <legend className="kicker mb-2.5 p-0">Runner and budget</legend>
        <div className="flex min-w-0 flex-col gap-1 text-[11.5px] text-ink3">
          <label htmlFor={ids.runner}>Runner</label>
          <select
            id={ids.runner}
            value={runnerId}
            onChange={(e) => change(() => onRunner(e.target.value))}
            className={field}
          >
            <option value="">The first free runner</option>
            {usable.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.status.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        {BUDGET_FIELDS.map((f) => (
          <div key={f.key} className="flex min-w-0 flex-col gap-1 text-[11.5px] text-ink3">
            <label htmlFor={`${ids.runner}-${f.key}`}>{f.label}</label>
            <input
              id={`${ids.runner}-${f.key}`}
              type="number"
              inputMode="decimal"
              step={f.step}
              min={f.min}
              max={cap(f.key).maxValue ?? undefined}
              value={budget[f.key]}
              aria-invalid={badBudget.has(f.key)}
              aria-describedby={`${ids.runner}-${f.key}-hint`}
              onChange={(e) => change(() => setBudget({ ...budget, [f.key]: e.target.value }))}
              className={`${field} font-mono`}
            />
            <span
              id={`${ids.runner}-${f.key}-hint`}
              className={`text-[11px] ${badBudget.has(f.key) ? "text-coral" : ""}`}
            >
              {badBudget.has(f.key) ? f.error : f.hint}
            </span>
          </div>
        ))}
      </fieldset>
      {runner && runner.status !== "ONLINE" && (
        <p
          className="m-0 rounded-xl px-3 py-2.5 text-[12.5px] leading-snug"
          style={{ background: "oklch(0.70 0.13 65 / .15)" }}
        >
          {runner.name} is {runner.status.toLowerCase()}. The run will be queued and held, not lost, until it
          reconnects.
        </p>
      )}

      <button
        type="submit"
        disabled={!!blocked || previewing}
        aria-describedby={blocked ? blockedId : undefined}
        className={`${ghostBtn} self-start`}
      >
        {previewing ? "Building the preview…" : "Preview"}
      </button>
    </form>
  );
}

function PreviewCard({
  preview,
  live,
  now,
  blocked,
  blockedId,
  approving,
  onApprove,
}: {
  preview: JobDraftPreview;
  live: boolean;
  now: number;
  blocked: string | null;
  blockedId: string;
  approving: boolean;
  onApprove: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const expiredId = useId();
  useEffect(() => headingRef.current?.focus(), [preview.actionHash]);
  const r2 = preview.riskTier === "R2";
  return (
    <section
      aria-labelledby="draft-preview"
      className="flex flex-col gap-3 rounded-[18px] border border-hair p-4"
    >
      <h3 id="draft-preview" ref={headingRef} tabIndex={-1} className="kicker m-0 text-violet outline-none">
        Exactly what will happen · {preview.riskTier} ·{" "}
        {r2 ? "creates a GitHub issue, then a run" : "starts a run on an existing issue"}
      </h3>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-[14px] bg-hair px-3.5 py-3 font-mono text-[11.5px] leading-[1.45]">
        {[
          ...preview.rows,
          { k: "Action hash", v: shortHash(preview.actionHash) },
          { k: "Expires", v: until(preview.expiresAt, now) },
        ].map((r) => (
          <div key={r.k} className="contents">
            <dt className="text-ink3">{r.k}</dt>
            <dd className="m-0 break-words text-ink">{r.v}</dd>
          </div>
        ))}
      </dl>
      {!live && (
        <p id={expiredId} className="m-0 text-[12.5px] text-amber">
          This preview expired. Preview again: approval binds to a live preview.
        </p>
      )}
      <button
        type="button"
        disabled={!live || !!blocked || approving}
        aria-describedby={blocked ? blockedId : !live ? expiredId : undefined}
        onClick={onApprove}
        className={`${primaryBtn} self-start`}
      >
        {approving
          ? "Approving…"
          : r2
            ? "Approve: create the issue and start the run"
            : "Approve: start the run"}
      </button>
    </section>
  );
}

function Started({ d }: { d: JobDraft }) {
  return (
    <section aria-labelledby="draft-started" className="flex flex-col gap-3">
      <h3 id="draft-started" className="kicker m-0">
        Approved
      </h3>
      {d.createdIssue ? (
        <CreatedLink issue={d.createdIssue} repo={d.repository?.fullName} />
      ) : (
        d.issueNumber && (
          <p className="m-0 text-[13.5px] text-ink">
            The run works on issue #{d.issueNumber}
            {d.repository && ` in ${d.repository.fullName}`}.
          </p>
        )
      )}
      <p className="m-0 text-[12.5px] leading-snug text-ink2">
        The Developer agent works in a sandbox at home. Pushing and opening a PR always ask you first.
      </p>
    </section>
  );
}
