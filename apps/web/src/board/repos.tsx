import { useId, useState, type ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { CiSummary, Repository, RepositoryHealth } from "@nexus/contracts";
import { api, keys } from "../lib/api.ts";
import { ago, useGithubStatus, useNow, useRepositoryHealth } from "../lib/queries.ts";
import { Drawer, DrawerHeader, DrawerState } from "./Drawer.tsx";
import { githubSetupHint } from "./github.tsx";
import { useOpenSettings } from "./Settings.tsx";
import { useScope } from "./scope.tsx";

// FR-GH-05: every repository at a glance (CI of the default branch, open pull requests and issues), ordered by what
// needs the owner first, and one repository's branches, pull requests and checks. Everything is GitHub's own answer,
// cached by the API for up to 3 minutes; the "synced" age says how old it is.

const route = getRouteApi("/");

const CI_TEXT: Record<CiSummary["state"], { text: string; tone: string }> = {
  FAILING: { text: "CI failing", tone: "var(--coral)" },
  PENDING: { text: "CI running", tone: "var(--amber)" },
  PASSING: { text: "CI passing", tone: "var(--green)" },
  NONE: { text: "no CI checks", tone: "var(--ink3)" },
};

const ghostBtn =
  "rounded-xl border border-hair px-3.5 py-2 text-[12.5px] font-medium text-ink disabled:opacity-45";
const seg = (on: boolean) =>
  `rounded-[10px] px-3 py-[9px] text-[12px] font-medium leading-none whitespace-nowrap ${on ? "bg-glass2 text-ink shadow-[0_1px_3px_rgba(0,0,0,.12)]" : "text-ink3"}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Why a repository needs the owner, most urgent first; empty = quiet. Archived repositories never need attention. */
export function attentionReasons(h: RepositoryHealth): string[] {
  if (h.archived) return [];
  if (h.error) return ["GitHub couldn't be read for it"];
  const reasons: string[] = [];
  if (h.ci?.state === "FAILING")
    reasons.push(h.ci.failing.length ? `CI failing: ${h.ci.failing.join(", ")}` : "CI failing");
  const ready = (h.openPullRequests ?? 0) - (h.draftPullRequests ?? 0);
  if (ready > 0)
    reasons.push(`${plural(ready, "pull request")} to review${h.pullRequestsMore ? " (100+)" : ""}`);
  if (h.ci?.state === "PENDING") reasons.push("CI running");
  return reasons;
}

const score = (h: RepositoryHealth) =>
  h.archived
    ? -1
    : (h.ci?.state === "FAILING" ? 8 : 0) +
      (h.error ? 4 : 0) +
      ((h.openPullRequests ?? 0) - (h.draftPullRequests ?? 0) > 0 ? 2 : 0) +
      (h.ci?.state === "PENDING" ? 1 : 0);

const pushedAt = (r: Repository) => Date.parse(r.pushedAt ?? r.updatedAt ?? "") || 0;

/** Needs-attention first (failing CI, unreadable, PRs to review, CI running), then most recently pushed. */
export const byAttention = (items: readonly RepositoryHealth[]) =>
  [...items].sort((a, b) => score(b) - score(a) || pushedAt(b.repository) - pushedAt(a.repository));

/** "1 failing · 3 open PRs · 12 open issues" across the list. */
export function healthSummary(items: readonly RepositoryHealth[]): string {
  const live = items.filter((h) => !h.archived);
  const failing = live.filter((h) => h.ci?.state === "FAILING").length;
  const prs = live.reduce((n, h) => n + (h.openPullRequests ?? 0), 0);
  const issues = live.reduce((n, h) => n + (h.openIssues ?? 0), 0);
  return [
    plural(items.length, "repository", "repositories"),
    `${failing} CI failing`,
    plural(prs, "open PR"),
    plural(issues, "open issue"),
  ].join(" · ");
}

/** One repository's line: name, last push, then CI, PRs and issues as text (never colour alone). */
export function RepoHealthRow({ h, now, onOpen }: { h: RepositoryHealth; now: number; onOpen: () => void }) {
  const r = h.repository;
  const ci = h.ci ? CI_TEXT[h.ci.state] : null;
  const reasons = attentionReasons(h);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-2xl border border-hair bg-card px-4 py-3 text-left hover:shadow-[0_0_0_2px_var(--teal)]"
    >
      <span className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-[14px] font-medium text-ink">
          {r.fullName}
          {h.archived && <span className="ml-2 font-mono text-[10.5px] text-ink3">archived</span>}
        </span>
        <span className="truncate font-mono text-[11px] text-ink3">
          {r.defaultBranch} · pushed {ago(r.pushedAt ?? r.updatedAt, now)} ·{" "}
          {r.private ? "private" : "public"}
        </span>
        {reasons.length > 0 && (
          <span className="text-[12px] leading-snug text-ink2">{reasons.join(" · ")}</span>
        )}
        {h.error && <span className="text-[12px] leading-snug text-coral">{h.error}</span>}
      </span>
      <span className="flex flex-col items-end gap-1 font-mono text-[11px] whitespace-nowrap text-ink2">
        {ci ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2 rounded-full" style={{ background: ci.tone }} />
            {ci.text}
          </span>
        ) : (
          <span className="text-ink3">CI unknown</span>
        )}
        {h.openPullRequests !== null && (
          <span>
            {plural(h.openPullRequests, "PR")}
            {h.pullRequestsMore ? "+" : ""}
            {h.draftPullRequests ? ` (${h.draftPullRequests} draft)` : ""}
          </span>
        )}
        {h.openIssues !== null && <span>{plural(h.openIssues, "issue")}</span>}
      </span>
    </button>
  );
}

/** Why the list is empty, with the way out. */
function NoRepos({ projectName }: { projectName?: string }) {
  const openSettings = useOpenSettings();
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="m-0 max-w-[560px] text-[14px] leading-relaxed text-ink2">
        {projectName
          ? `No repositories are bound to ${projectName} yet. Bind the ones you work on, and their CI, pull requests and issues show here.`
          : "The NEXUS app's installations have no repositories yet. Add some in the installation settings on GitHub."}
      </p>
      {projectName && (
        <button type="button" onClick={() => openSettings("ws")} className={ghostBtn}>
          Bind repositories
        </button>
      )}
    </div>
  );
}

/** Health of the scope's repositories once GitHub is installed: the project's bound ones, or all in the All view. */
export function useScopeRepositoryHealth() {
  const scope = useScope();
  const github = useGithubStatus();
  const installed = github.data?.configured === true && github.data.installations.length > 0;
  return {
    github,
    hint: githubSetupHint(github),
    health: useRepositoryHealth(installed && scope.ready, scope.project?.id),
    projectName: scope.project?.name,
  };
}

/** Home: the repositories that need the owner now (at most 5), or a line saying they're quiet. */
export function RepoAttention({ onOpenAll }: { onOpenAll: () => void }) {
  const { keep } = useScope();
  const navigate = route.useNavigate();
  const now = useNow(30_000);
  const { hint, health, projectName } = useScopeRepositoryHealth();
  if (hint) return <div className="text-[14px] text-ink2">{hint}</div>;
  if (!health.data) return <DrawerState error={health.error} />;
  const items = health.data.items;
  if (items.length === 0) return <NoRepos projectName={projectName} />;
  const needing = byAttention(items).filter((h) => attentionReasons(h).length > 0);
  return (
    <div className="flex flex-col gap-2.5">
      {needing.length === 0 ? (
        <p className="m-0 text-[14px] leading-relaxed text-ink2">
          All {plural(items.length, "repository", "repositories")} are quiet: no failing CI and no pull
          request waiting for review.
        </p>
      ) : (
        <ul aria-label="Repositories needing attention" className="m-0 flex list-none flex-col gap-2 p-0">
          {needing.slice(0, 5).map((h) => (
            <li key={h.repository.id}>
              <RepoHealthRow
                h={h}
                now={now}
                onOpen={() => void navigate({ search: { ...keep, drawer: `repo:${h.repository.id}` } })}
              />
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={onOpenAll} className={`${ghostBtn} self-start`}>
        All {plural(items.length, "repository", "repositories")}
        {needing.length > 5 ? ` · ${needing.length - 5} more need you` : ""}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- `drawer=repos`

export function RepositoriesDrawer({ banner, onClose }: { banner?: ReactNode; onClose: () => void }) {
  return (
    <Drawer banner={banner} onClose={onClose}>
      <RepositoriesBody />
    </Drawer>
  );
}

function RepositoriesBody() {
  const { keep } = useScope();
  const navigate = route.useNavigate();
  const now = useNow(30_000);
  const searchId = useId();
  const { hint, health, projectName } = useScopeRepositoryHealth();
  const [only, setOnly] = useState<"attention" | "all">("all");
  const [q, setQ] = useState("");
  const where = projectName ?? "all installed repositories";
  const header = <DrawerHeader kicker={`Repositories · ${where} · GitHub`} title="Repositories" />;
  if (hint)
    return (
      <>
        {header}
        <div className="px-6 py-5">{hint}</div>
      </>
    );
  if (!health.data)
    return (
      <>
        {header}
        {health.error ? (
          <DrawerState error={health.error} />
        ) : (
          <p role="status" className="m-0 px-6 py-5 text-[14px] text-ink2">
            Asking GitHub about each repository… the first load takes a few seconds.
          </p>
        )}
      </>
    );

  const items = health.data.items;
  const needing = items.filter((h) => attentionReasons(h).length > 0);
  const needle = q.trim().toLowerCase();
  const shown = byAttention(only === "attention" ? needing : items).filter((h) =>
    h.repository.fullName.toLowerCase().includes(needle),
  );
  const oldest = items.reduce((t, h) => Math.min(t, Date.parse(h.syncedAt)), now);

  return (
    <>
      {header}
      <div className="nx-stagger flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 pt-5 pb-6">
        {items.length === 0 ? (
          <NoRepos projectName={projectName} />
        ) : (
          <>
            <p className="m-0 font-mono text-[12px] text-ink2">
              {healthSummary(items)} · synced {ago(new Date(oldest).toISOString(), now)}
              {health.isFetching ? " · refreshing…" : ""}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div role="group" aria-label="Show" className="flex rounded-[14px] bg-hair p-1">
                <button
                  type="button"
                  aria-pressed={only === "attention"}
                  onClick={() => setOnly("attention")}
                  className={seg(only === "attention")}
                >
                  Needs you ({needing.length})
                </button>
                <button
                  type="button"
                  aria-pressed={only === "all"}
                  onClick={() => setOnly("all")}
                  className={seg(only === "all")}
                >
                  All ({items.length})
                </button>
              </div>
              <label
                htmlFor={searchId}
                className="flex min-w-[180px] flex-1 flex-col gap-1 text-[11.5px] text-ink3"
              >
                Find a repository
                <input
                  id={searchId}
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="min-w-0 rounded-xl border border-hair bg-card px-3 py-2 text-[13px] text-ink"
                />
              </label>
            </div>
            {shown.length === 0 ? (
              <p className="m-0 text-[14px] text-ink2">
                {only === "attention" && !needle
                  ? "Nothing needs you: no failing CI and no pull request waiting for review."
                  : "No repository matches."}
              </p>
            ) : (
              <ul aria-label="Repositories" className="m-0 flex list-none flex-col gap-2 p-0">
                {shown.map((h) => (
                  <li key={h.repository.id}>
                    <RepoHealthRow
                      h={h}
                      now={now}
                      onOpen={() => void navigate({ search: { ...keep, drawer: `repo:${h.repository.id}` } })}
                    />
                  </li>
                ))}
              </ul>
            )}
            <p className="m-0 text-[12px] leading-[1.5] text-ink3">
              CI is GitHub checks on the default branch; commit statuses from older CI services aren&apos;t
              counted. Open a repository for its branches, pull requests, checks and issues.
            </p>
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- repo drawer: FR-GH-05 details

const LIST_START = 8;

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-teal underline">
      {children}
      <span className="sr-only"> (opens GitHub in a new tab)</span>
    </a>
  );
}

function MoreToggle({ open, total, onToggle }: { open: boolean; total: number; onToggle: () => void }) {
  if (total <= LIST_START) return null;
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className={`${ghostBtn} self-start`}>
      {open ? "Show fewer" : `Show all ${total}`}
    </button>
  );
}

/** CI, open pull requests and branches of one repository (FR-GH-05), above its issues in the repo drawer. */
export function RepoDetails({ repo }: { repo: Repository }) {
  const now = useNow(30_000);
  const details = useQuery({
    queryKey: keys.repositoryDetails(repo.id),
    queryFn: () => api.repositoryDetails(repo.id),
    refetchInterval: 60_000,
  });
  const [allPrs, setAllPrs] = useState(false);
  const [allBranches, setAllBranches] = useState(false);
  const [allChecks, setAllChecks] = useState(false);
  const d = details.data;
  const box = "flex flex-col gap-2.5 rounded-[18px] border border-hair p-4";

  if (!d)
    return (
      <section aria-label={`Details of ${repo.fullName}`} className={box}>
        <DrawerState error={details.error} />
      </section>
    );

  const ci = CI_TEXT[d.ci.state];
  const prs = allPrs ? d.pullRequests : d.pullRequests.slice(0, LIST_START);
  const branches = allBranches ? d.branches : d.branches.slice(0, LIST_START);
  const checks = allChecks ? d.checks : d.checks.slice(0, LIST_START);
  return (
    <>
      <section aria-labelledby="repo-ci" className={box}>
        <h3 id="repo-ci" className="kicker m-0">
          CI · {repo.defaultBranch}
          {d.archived ? " · archived" : ""}
        </h3>
        <p className="m-0 flex flex-wrap items-center gap-2 text-[13.5px] text-ink">
          <span aria-hidden="true" className="size-2 rounded-full" style={{ background: ci.tone }} />
          <span className="font-medium">{ci.text}</span>
          <span className="font-mono text-[11px] text-ink3">
            {plural(d.ci.total, "check")}
            {d.ci.sha ? ` · ${d.ci.sha.slice(0, 7)}` : ""}
            {d.ci.completedAt ? ` · last finished ${ago(d.ci.completedAt, now)}` : ""} · synced{" "}
            {ago(d.syncedAt, now)}
          </span>
        </p>
        {d.checks.length > 0 && (
          <ul aria-label="Checks" className="m-0 flex list-none flex-col gap-1 p-0">
            {checks.map((c, i) => (
              <li key={`${c.name}-${i}`} className="flex flex-wrap gap-2 font-mono text-[12px] text-ink2">
                <span className="text-ink">{c.name}</span>
                <span>
                  {c.status === "completed" ? (c.conclusion ?? "completed") : c.status.replaceAll("_", " ")}
                </span>
                {c.htmlUrl && <External href={c.htmlUrl}>log</External>}
              </li>
            ))}
          </ul>
        )}
        <MoreToggle open={allChecks} total={d.checks.length} onToggle={() => setAllChecks(!allChecks)} />
      </section>

      <section aria-labelledby="repo-prs" className={box}>
        <h3 id="repo-prs" className="kicker m-0">
          Open pull requests · {d.pullRequests.length}
          {d.pullRequestsMore ? "+" : ""}
          {d.openIssues !== null ? ` · ${plural(d.openIssues, "open issue")}` : ""}
        </h3>
        {d.pullRequests.length === 0 ? (
          <p className="m-0 text-[13.5px] text-ink2">No open pull requests.</p>
        ) : (
          <ul aria-label="Open pull requests" className="m-0 flex list-none flex-col gap-1.5 p-0">
            {prs.map((p) => (
              <li key={p.number} className="flex flex-col gap-0.5">
                <span className="text-[13.5px] leading-snug text-ink">
                  <External href={p.htmlUrl}>#{p.number}</External> {p.title}
                </span>
                <span className="font-mono text-[11px] text-ink3">
                  {p.draft ? "draft · " : ""}
                  {p.nexus ? "opened by a NEXUS run · " : ""}
                  {p.headBranch} → {p.baseBranch} · {p.author ? `@${p.author} · ` : ""}updated{" "}
                  {ago(p.updatedAt, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <MoreToggle open={allPrs} total={d.pullRequests.length} onToggle={() => setAllPrs(!allPrs)} />
      </section>

      <section aria-labelledby="repo-branches" className={box}>
        <h3 id="repo-branches" className="kicker m-0">
          Branches · {d.branches.length}
          {d.branchesMore ? "+" : ""}
        </h3>
        {d.branches.length === 0 ? (
          <p className="m-0 text-[13.5px] text-ink2">No branches: the repository is empty.</p>
        ) : (
          <ul aria-label="Branches" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {branches.map((b) => (
              <li
                key={b.name}
                className="rounded-full bg-hair px-2.5 py-[5px] font-mono text-[11.5px] text-ink2"
              >
                {b.name}
                {[b.default && "default", b.protected && "protected", b.nexus && "NEXUS"]
                  .filter(Boolean)
                  .map((t) => ` · ${t}`)}
              </li>
            ))}
          </ul>
        )}
        <MoreToggle
          open={allBranches}
          total={d.branches.length}
          onToggle={() => setAllBranches(!allBranches)}
        />
      </section>
    </>
  );
}
