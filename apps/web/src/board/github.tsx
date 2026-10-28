import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  GITHUB_SETUP_COMMAND,
  type GithubInstallation,
  type GithubStatus,
  type IssueLabel,
  type Repository,
} from "@nexus/contracts";
import { api, keys, type IssueFilters } from "../lib/api.ts";
import {
  ago,
  preferredRunner,
  useGithubStatus,
  useNow,
  useRepositories,
  useRunners,
} from "../lib/queries.ts";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";
import { P1Button } from "./P1Button.tsx";
import { useScope } from "./scope.tsx";
import { StartRunPreview } from "./StartRun.tsx";

const route = getRouteApi("/");

const field =
  "min-w-0 rounded-xl border border-hair bg-card px-3 py-2 text-[13px] text-ink placeholder:text-ink3";
const ghostBtn =
  "rounded-xl border border-hair px-3.5 py-2.5 text-[12.5px] font-medium text-ink disabled:opacity-45";

/** What the owner must do before NEXUS can see repositories; null once at least one installation exists. */
export function githubSetupHint(status: UseQueryResult<GithubStatus>): ReactNode {
  const s = status.data;
  if (!s) return <Hint>{status.error ? status.error.message : "Loading GitHub…"}</Hint>;
  if (!s.configured)
    return (
      <Hint>
        GitHub isn&apos;t set up. On the home machine run{" "}
        <code className="rounded-lg bg-term px-2 py-1 font-mono text-[12px] break-all text-[#eeeae2] select-all">
          {GITHUB_SETUP_COMMAND}
        </code>
        , then restart the API.
      </Hint>
    );
  if (s.installations.length === 0)
    return (
      <Hint>
        The NEXUS GitHub App isn&apos;t installed on any account yet.{" "}
        <InstallLink href={s.installUrl}>Install it on GitHub</InstallLink> and pick the repositories NEXUS
        may work on.
      </Hint>
    );
  return null;
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="m-0 max-w-[560px] text-[14px] leading-relaxed text-ink2">{children}</p>;
}

function InstallLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-teal underline">
      {children}
      <span className="sr-only"> (opens GitHub in a new tab)</span>
    </a>
  );
}

const accessLabel = (i: GithubInstallation | undefined) =>
  i?.permissions.pull_requests === "write" ? "PR write" : "read only";

const repoMeta = (r: Repository, now: number) =>
  `${r.private ? "private" : "public"} · ${r.defaultBranch} · updated ${ago(r.pushedAt ?? r.updatedAt, now)}`;

function Labels({ labels }: { labels: readonly IssueLabel[] }) {
  if (!labels.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {labels.map((l) => (
        <span
          key={l.name}
          className="inline-flex items-center gap-1 rounded-full bg-hair px-2 py-[3px] font-mono text-[10.5px] text-ink2"
        >
          {l.color && (
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full"
              style={{ background: `#${l.color}` }}
            />
          )}
          {l.name}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- repo drawer

export function RepoDrawer({
  repoId,
  banner,
  onClose,
}: {
  repoId: string;
  banner?: ReactNode;
  onClose: () => void;
}) {
  return (
    <Drawer banner={banner} onClose={onClose}>
      <RepoBody key={repoId} repoId={repoId} />
    </Drawer>
  );
}

function RepoBody({ repoId }: { repoId: string }) {
  const { keep, project, ready } = useScope();
  const navigate = route.useNavigate();
  const status = useGithubStatus();
  const installed = status.data?.configured === true && status.data.installations.length > 0;
  // In a project: only its bound repositories (FR-WKS-03).
  const repos = useRepositories(installed && ready, project?.id);
  const now = useNow(30_000);
  const repo = repos.data?.items.find((r) => r.id === repoId);
  const installations = status.data?.configured ? status.data.installations : [];

  const hint = githubSetupHint(status);
  if (hint || !repos.data)
    return (
      <>
        <DrawerHeader kicker="Repositories · GitHub App" title="Repositories" />
        {hint ? <div className="px-6 py-5">{hint}</div> : <DrawerState error={repos.error} />}
      </>
    );

  return (
    <>
      <DrawerHeader
        kicker={`Repositories · GitHub App · synced ${ago(repos.data.syncedAt, now)}`}
        title={repo?.fullName ?? "Repository not available"}
      />
      <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 pt-5 pb-6">
        <ul
          aria-label="GitHub accounts"
          className="m-0 flex w-max max-w-full list-none flex-wrap gap-1 rounded-[14px] bg-hair p-1"
        >
          {installations.map((i) => (
            <li
              key={i.id}
              className={`rounded-[10px] px-3 py-2 text-[12px] font-medium ${i.account.login === repo?.owner ? "bg-glass2 text-ink" : "text-ink3"}`}
            >
              {i.account.login}{" "}
              <span className="font-mono text-[10.5px] font-normal text-ink3">
                {i.account.type.toLowerCase()} ·{" "}
                {i.repositorySelection === "all" ? "all repos" : "selected repos"} · installation {i.id}
                {i.suspended ? " · suspended" : ""}
              </span>
            </li>
          ))}
          <li className="px-3 py-2 text-[12px]">
            {status.data?.configured && <InstallLink href={status.data.installUrl}>+ account</InstallLink>}
          </li>
        </ul>

        {!repo && (
          <p role="alert" className="m-0 text-[14px] text-coral">
            {project
              ? `This repository isn't bound to ${project.name}. Bind it in Settings → Workspaces.`
              : "This repository isn't in the NEXUS app's installations, or the app lost access to it."}
          </p>
        )}

        <ul aria-label="Repositories" className="m-0 flex list-none flex-col gap-2 p-0">
          {repos.data.items.length === 0 && (
            <li className="text-[14px] text-ink2">
              {project
                ? `No repositories are bound to ${project.name} yet. Bind some in Settings → Workspaces.`
                : "The app's installations have no repositories yet. Add some in the installation settings on GitHub."}
            </li>
          )}
          {repos.data.items.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                aria-current={r.id === repoId ? "true" : undefined}
                onClick={() => void navigate({ search: { ...keep, drawer: `repo:${r.id}` } })}
                className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border px-4 py-3.5 text-left ${r.id === repoId ? "border-teal" : "border-hair"}`}
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="truncate text-[14px] font-medium text-ink">{r.fullName}</span>
                  <span className="font-mono text-[11px] text-ink3">{repoMeta(r, now)}</span>
                </span>
                <span className="font-mono text-[11px] text-ink2">
                  {accessLabel(installations.find((i) => i.id === r.installationId))}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {repo && <Issues repo={repo} />}
      </div>
    </>
  );
}

function Issues({ repo }: { repo: Repository }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const now = useNow(30_000);
  const filters: IssueFilters = {
    state: search.state,
    labels: search.labels,
    assignee: search.assignee,
    q: search.q,
    page: search.page,
  };
  const issues = useQuery({
    queryKey: keys.issues(repo.id, filters),
    queryFn: () => api.issues(repo.id, filters),
  });
  const [form, setForm] = useState({
    state: filters.state ?? "open",
    labels: filters.labels ?? "",
    assignee: filters.assignee ?? "",
    q: filters.q ?? "",
  });

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const blank = (v: string) => v.trim() || undefined;
    void navigate({
      search: (s) => ({
        ...s,
        state: form.state === "open" ? undefined : form.state,
        labels: blank(form.labels),
        assignee: blank(form.assignee),
        q: blank(form.q),
        page: undefined,
      }),
    });
  };
  const toPage = (page: number) =>
    void navigate({ search: (s) => ({ ...s, page: page === 1 ? undefined : page }) });
  const page = issues.data?.page ?? filters.page ?? 1;

  return (
    <section
      aria-labelledby="issues-title"
      className="flex flex-col gap-3 rounded-[18px] border border-hair p-4"
    >
      <h3 id="issues-title" className="kicker m-0">
        Issues · {repo.fullName}
      </h3>
      <form
        role="search"
        aria-label="Filter issues"
        onSubmit={apply}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex flex-col gap-1 text-[11.5px] text-ink3">
          State
          <select
            value={form.state}
            onChange={(e) => setForm({ ...form, state: e.target.value as typeof form.state })}
            className={field}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-ink3">
          Labels
          <input
            value={form.labels}
            placeholder="bug,ui"
            onChange={(e) => setForm({ ...form, labels: e.target.value })}
            className={`${field} w-28`}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-ink3">
          Assignee
          <input
            value={form.assignee}
            placeholder="login"
            onChange={(e) => setForm({ ...form, assignee: e.target.value })}
            className={`${field} w-28`}
          />
        </label>
        <label className="flex min-w-[140px] flex-1 flex-col gap-1 text-[11.5px] text-ink3">
          Search text
          <input
            type="search"
            value={form.q}
            onChange={(e) => setForm({ ...form, q: e.target.value })}
            className={field}
          />
        </label>
        <button type="submit" className="rounded-xl bg-teal px-4 py-2.5 text-[12.5px] font-medium text-onacc">
          Apply
        </button>
      </form>

      {!issues.data ? (
        <DrawerState error={issues.error} />
      ) : (
        <>
          {issues.data.items.length === 0 ? (
            <p className="m-0 text-[13.5px] text-ink2">No issues match these filters.</p>
          ) : (
            <ul aria-label="Issues" className="m-0 flex list-none flex-col gap-1.5 p-0">
              {issues.data.items.map((i) => (
                <li key={i.number}>
                  <button
                    type="button"
                    onClick={() =>
                      void navigate({ search: (s) => ({ ...s, drawer: `issue:${repo.id}:${i.number}` }) })
                    }
                    className="flex w-full flex-col gap-1.5 rounded-[14px] px-3 py-2.5 text-left hover:bg-hair"
                  >
                    <span className="text-[13.5px] leading-snug font-medium text-ink">
                      <span className="font-mono text-ink3">#{i.number}</span> {i.title}
                      {i.state === "closed" && (
                        <span className="ml-1.5 text-[11.5px] text-ink3">(closed)</span>
                      )}
                    </span>
                    <span className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink3">
                      <Labels labels={i.labels} />
                      updated {ago(i.updatedAt, now)} · {i.comments} comments
                      {i.assignees.length > 0 && ` · @${i.assignees.join(" @")}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <nav aria-label="Issue pages" className="flex items-center justify-between gap-2">
            <button type="button" disabled={page <= 1} onClick={() => toPage(page - 1)} className={ghostBtn}>
              Previous
            </button>
            <span className="font-mono text-[11px] text-ink3">
              page {page} · synced {ago(issues.data.syncedAt, now)}
            </span>
            <button
              type="button"
              disabled={!issues.data.nextPage}
              onClick={() => issues.data.nextPage && toPage(issues.data.nextPage)}
              className={ghostBtn}
            >
              Next
            </button>
          </nav>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- issue drawer

export function IssueDrawer({
  repoId,
  number,
  banner,
  onClose,
}: {
  repoId: string;
  number: number;
  banner?: ReactNode;
  onClose: () => void;
}) {
  return (
    <Drawer banner={banner} onClose={onClose}>
      <IssueBody key={`${repoId}:${number}`} repoId={repoId} number={number} />
    </Drawer>
  );
}

function IssueBody({ repoId, number }: { repoId: string; number: number }) {
  const navigate = route.useNavigate();
  const { project, blocked } = useScope();
  const now = useNow(30_000);
  const detail = useQuery({ queryKey: keys.issue(repoId, number), queryFn: () => api.issue(repoId, number) });
  const status = useGithubStatus();
  const repos = useRepositories(status.data?.configured === true);
  const runner = preferredRunner(useRunners().data);
  const repo = repos.data?.items.find((r) => r.id === repoId);
  const [previewing, setPreviewing] = useState(false);
  const startRef = useRef<HTMLButtonElement>(null);
  const back = (
    <button
      type="button"
      onClick={() => void navigate({ search: (s) => ({ ...s, drawer: `repo:${repoId}` }) })}
      className="self-start text-[12.5px] font-medium text-teal"
    >
      ← {repo ? `${repo.fullName} issues` : "Repository issues"}
    </button>
  );

  if (!detail.data)
    return (
      <>
        <DrawerHeader kicker="Issue" title={detail.error ? "Can't open this issue" : `Loading #${number}…`} />
        <div className="flex flex-col gap-3 px-6 py-5">
          {back}
          <DrawerState error={detail.error} />
        </div>
      </>
    );

  const d = detail.data;
  const i = d.issue;
  // No implicit fallback: a run starts only in the selected project, on a repository bound to it.
  const startBlocked =
    blocked ??
    (project!.repositoryIds.includes(repoId)
      ? null
      : `${repo?.fullName ?? "This repository"} isn't bound to ${project!.name}. Bind it in Settings → Workspaces.`);
  const facts: [string, string][] = [
    ["repo", repo?.fullName ?? repoId],
    ["base", repo?.defaultBranch ?? "default branch"],
    ["state", i.state],
    ["labels", i.labels.map((l) => l.name).join(", ") || "none"],
    ["assignees", i.assignees.join(", ") || "none"],
    ["synced", ago(d.syncedAt, now)],
  ];

  return (
    <>
      <DrawerHeader
        kicker={`Issue · ${d.missingAcceptanceCriteria ? "needs info" : "ready"}${repo ? ` · ${repo.fullName}` : ""}`}
        title={`#${i.number} ${i.title}`}
      />
      <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-6 pt-5 pb-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {back}
          <a
            href={i.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12.5px] text-ink2 underline"
          >
            Open on GitHub<span className="sr-only"> (new tab)</span> ↗
          </a>
        </div>
        {/* Markdown source as plain text: React escapes it, nothing is rendered as HTML. */}
        <p className="m-0 flex-none text-[15px] leading-[1.6] break-words whitespace-pre-wrap text-ink2">
          {d.body || "No description."}
        </p>

        {d.missingAcceptanceCriteria ? (
          <div
            role="note"
            className="flex flex-none flex-col gap-1.5 rounded-[18px] px-4 py-3.5"
            style={{ background: "oklch(0.70 0.13 65 / .14)" }}
          >
            <span className="kicker" style={{ color: "var(--amber)" }}>
              Missing acceptance criteria
            </span>
            <span className="text-[13.5px] leading-[1.5] text-ink">
              NEXUS found no acceptance criteria in this issue. Add an “Acceptance criteria” section, a
              checklist or Given/When/Then lines on GitHub before running it.
            </span>
          </div>
        ) : (
          <section
            aria-labelledby="ac-title"
            className="flex flex-none flex-col gap-2 rounded-[18px] border border-hair p-4"
          >
            <h3 id="ac-title" className="kicker m-0">
              Acceptance criteria · extracted
            </h3>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {d.acceptanceCriteria.map((a, n) => (
                <li key={n} className="flex gap-2.5 text-[13.5px] leading-[1.45] text-ink">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 flex-none rounded-[5px] border-[1.5px] border-teal"
                  />
                  <span className="break-words">{a}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <dl className="m-0 grid flex-none grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5">
          {facts.map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1.5 rounded-[14px] bg-hair px-3.5 py-3">
              <dt className="font-mono text-[10.5px] text-ink3 uppercase">{k}</dt>
              <dd className="m-0 text-[13px] font-medium break-words text-ink">{v}</dd>
            </div>
          ))}
        </dl>

        {d.comments.length > 0 && (
          <section aria-labelledby="comments-title" className="flex flex-none flex-col gap-2.5">
            <h3 id="comments-title" className="kicker m-0">
              Comments · {i.comments}
            </h3>
            {d.comments.map((c, n) => (
              <div key={n} className="flex flex-col gap-1 rounded-[14px] border border-hair px-3.5 py-3">
                <span className="font-mono text-[11px] text-ink3">
                  {c.author ?? "ghost"} · {ago(c.createdAt, now)}
                </span>
                <p className="m-0 text-[13px] leading-[1.5] break-words whitespace-pre-wrap text-ink2">
                  {c.body}
                </p>
              </div>
            ))}
          </section>
        )}

        <div className="flex flex-none flex-wrap items-center justify-between gap-2">
          <span className="text-[12px] text-ink3">
            Runs at home in a sandbox. Push and PR always ask you first.
          </span>
          <div className="flex gap-2">
            <P1Button
              why="Plan only arrives with the plan step."
              className="rounded-[14px] border border-hair px-4 py-3 text-[13px] font-medium text-ink"
            >
              Plan only
            </P1Button>
            <button
              ref={startRef}
              type="button"
              disabled={!!startBlocked}
              aria-describedby={startBlocked ? "start-blocked" : undefined}
              aria-expanded={previewing}
              aria-controls={previewing ? "run-preview" : undefined}
              onClick={() => setPreviewing(true)}
              className="rounded-[14px] bg-teal px-[18px] py-3 text-[13px] font-medium text-onacc disabled:opacity-45"
            >
              Start run on {runner?.name ?? "home runner"}
            </button>
          </div>
        </div>
        {startBlocked && (
          <p id="start-blocked" className="m-0 flex-none text-[12.5px] leading-snug text-ink2">
            {startBlocked}
          </p>
        )}
        {previewing && !startBlocked && (
          <StartRunPreview
            projectId={project!.id}
            repoId={repoId}
            repo={repo}
            detail={d}
            runner={runner}
            onCancel={() => {
              setPreviewing(false);
              startRef.current?.focus();
            }}
          />
        )}
      </div>
    </>
  );
}
