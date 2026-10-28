import { App } from "@octokit/app";
import type { FastifyBaseLogger } from "fastify";
import {
  ISSUE_MAX_PAGE,
  ISSUE_PAGE_SIZE,
  WORK_BRANCH_PREFIX,
  type Approval,
  type ChangesetFile,
  type GithubInstallation,
  type GithubStatus,
  type Issue,
  type IssueDetail,
  type IssueList,
  type IssueListQuery,
  type IssueSnapshot,
  type IssueToPrTask,
  type PushDraftPrAction,
  type Repository,
  type RepositoryList,
} from "@nexus/contracts";
import { HttpError, notFound } from "../errors.ts";
import { extractAcceptanceCriteria, stripHtmlComments } from "./acceptance-criteria.ts";
import type { GithubAppConfig } from "./app-config.ts";

// shortcut: in-memory 60 s cache per API process (syncedAt shows its age); DB sync + webhooks replace it with FR-GH-10.
const TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;
// shortcut: first 100 installations, 1000 repos per installation and 100 comments per issue; paginate further when needed.
const MAX_REPO_PAGES = 10;

type GithubError = Error & {
  status: number;
  request?: { url?: string };
  response?: { headers?: Record<string, string | number | undefined> };
};
const isGithubError = (e: unknown): e is GithubError =>
  e instanceof Error && typeof (e as { status?: unknown }).status === "number";

// Structural slices of GitHub's REST shapes; Octokit's typed responses satisfy them.
type GhLabel = string | { name?: string; color?: string | null };
type GhIssue = {
  number: number;
  title: string;
  state: string;
  labels: GhLabel[];
  assignees?: { login: string }[] | null;
  milestone: { title: string } | null;
  user: { login: string } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  html_url: string;
  body?: string | null;
  pull_request?: unknown;
  repository_url: string;
};

const toIssue = (i: GhIssue): Issue => ({
  number: i.number,
  title: i.title,
  state: i.state === "closed" ? "closed" : "open",
  labels: i.labels.flatMap((l) => {
    const label = typeof l === "string" ? { name: l } : l;
    if (!label.name) return [];
    const color = label.color ?? "";
    return [{ name: label.name, color: /^[0-9a-fA-F]{6}$/.test(color) ? color : "" }];
  }),
  assignees: (i.assignees ?? []).map((a) => a.login),
  milestone: i.milestone?.title ?? null,
  author: i.user?.login ?? null,
  comments: i.comments,
  createdAt: new Date(i.created_at).toISOString(),
  updatedAt: new Date(i.updated_at).toISOString(),
  htmlUrl: i.html_url,
});

const iso = (s: string | null | undefined) => (s ? new Date(s).toISOString() : null);

// Permissions the app's installation must grant before NEXUS accepts an issue → draft PR job (FR-DEV-01).
const ISSUE_TO_PR_PERMISSIONS = ["contents", "pull_requests"] as const;
const COMMIT_AUTHOR = { name: "NEXUS", email: "nexus@noreply.invalid" }; // .invalid: never a real account

type ChangesetMode = Extract<ChangesetFile, { mode: string }>["mode"];
export type PushResult = NonNullable<Approval["result"]> & { adopted: boolean };

/**
 * What the NEXUS GitHub App can reach: its installations, their repositories and issues, plus the two
 * scoped operations of ENG-07 (a read token for the runner, and the approved push + draft PR).
 * Every repository call uses a short-lived token of the installation that owns the repository; installation
 * tokens stay inside Octokit (cached until shortly before expiry) and never reach responses or logs.
 */
export function createGithubCatalog(config: GithubAppConfig, log: FastifyBaseLogger) {
  const app = new App({ appId: config.appId, privateKey: config.privateKey });
  const installUrl = `${config.htmlUrl}/installations/new`;
  const cache = new Map<string, { at: number; value: unknown }>();
  let blockedUntil = 0;

  async function cached<T>(key: string, load: () => Promise<T>): Promise<{ value: T; syncedAt: string }> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS)
      return { value: hit.value as T, syncedAt: new Date(hit.at).toISOString() };
    const value = await load();
    const at = Date.now();
    cache.delete(key);
    cache.set(key, { at, value });
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    return { value, syncedAt: new Date(at).toISOString() };
  }

  const rateLimited = (until: number) =>
    new HttpError(
      429,
      "RATE_LIMITED",
      `GitHub's rate limit is reached. NEXUS waits until ${new Date(until).toISOString()} before asking again.`,
      { resetAt: new Date(until).toISOString() },
    );

  function rateLimitReset(e: GithubError): number | undefined {
    if (e.status !== 403 && e.status !== 429) return undefined;
    const h = e.response?.headers ?? {};
    const retryAfter = Number(h["retry-after"]);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Date.now() + retryAfter * 1000;
    const reset = Number(h["x-ratelimit-reset"]);
    if (String(h["x-ratelimit-remaining"]) === "0" && Number.isFinite(reset)) return reset * 1000;
    if (e.status === 429 || /secondary rate limit/i.test(e.message)) return Date.now() + 60_000;
    return undefined;
  }

  /**
   * Runs one GitHub call and maps its failure to an ApiError. `denied` explains lost access for the resource;
   * there is no retry with other credentials (GH-G04).
   */
  async function github<T>(call: () => Promise<T>, denied: string, missing?: string): Promise<T> {
    if (Date.now() < blockedUntil) throw rateLimited(blockedUntil);
    try {
      return await call();
    } catch (e) {
      if (!isGithubError(e)) throw e;
      log.warn(
        { githubStatus: e.status, githubRequestId: e.response?.headers?.["x-github-request-id"] },
        "github request failed",
      );
      const reset = rateLimitReset(e);
      if (reset !== undefined) {
        blockedUntil = Math.max(blockedUntil, reset);
        throw rateLimited(blockedUntil);
      }
      // A repository's installation was removed or suspended: its token can't be issued.
      if (e.request?.url?.includes("/access_tokens") && e.status >= 400 && e.status < 500) {
        cache.clear();
        throw new HttpError(403, "FORBIDDEN", `${denied} The app's installation is gone or suspended.`, {
          installUrl,
        });
      }
      if (e.status === 401)
        throw new HttpError(
          403,
          "FORBIDDEN",
          "GitHub rejected the NEXUS app's credentials. If the app was deleted or its key revoked, re-run the GitHub setup with --force.",
        );
      if (e.status === 410)
        throw new HttpError(404, "NOT_FOUND", missing ?? "Issues are turned off or deleted on GitHub.");
      if (e.status === 404 && missing) throw new HttpError(404, "NOT_FOUND", missing);
      // 404 on something NEXUS just listed means the app lost access to it.
      if (e.status === 403 || e.status === 404) {
        cache.clear();
        throw new HttpError(403, "FORBIDDEN", denied, { installUrl });
      }
      if (e.status === 422) throw new HttpError(400, "VALIDATION_FAILED", "GitHub rejected the query.");
      throw new HttpError(
        502,
        "INTERNAL",
        `GitHub is unavailable right now (HTTP ${e.status || "error"}). Try again shortly.`,
      );
    }
  }

  const installations = () =>
    cached("installations", () =>
      github(async () => {
        const { data } = await app.octokit.request("GET /app/installations", { per_page: 100 });
        return data.map((i): GithubInstallation => ({
          id: i.id,
          // Enterprise installations have an account without login/type.
          account: {
            login: i.account && "login" in i.account ? i.account.login : "enterprise",
            type: i.account && "type" in i.account ? i.account.type : "Enterprise",
          },
          repositorySelection: i.repository_selection,
          suspended: i.suspended_at != null,
          permissions: Object.fromEntries(
            Object.entries(i.permissions).filter((p) => typeof p[1] === "string"),
          ) as Record<string, string>,
        }));
      }, "GitHub refused to list the NEXUS app's installations."),
    );

  const repositories = () =>
    cached("repositories", async () => {
      const repos: Repository[] = [];
      for (const inst of (await installations()).value.filter((i) => !i.suspended)) {
        const octokit = await app.getInstallationOctokit(inst.id);
        for (let page = 1; page <= MAX_REPO_PAGES; page++) {
          const { data } = await github(
            () => octokit.request("GET /installation/repositories", { per_page: 100, page }),
            `NEXUS can't list the repositories of the ${inst.account.login} installation.`,
          );
          for (const r of data.repositories)
            repos.push({
              id: String(r.id),
              fullName: r.full_name,
              owner: r.owner.login,
              name: r.name,
              private: r.private,
              defaultBranch: r.default_branch,
              htmlUrl: r.html_url,
              pushedAt: iso(r.pushed_at),
              updatedAt: iso(r.updated_at),
              installationId: inst.id,
            });
          if (page * 100 >= data.total_count) break;
        }
      }
      return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
    });

  /** Only repositories of this app's installations exist for NEXUS (GH-G01): anything else is a 404. */
  async function repository(repoId: string) {
    const repo = (await repositories()).value.find((r) => r.id === repoId);
    if (!repo) throw notFound("Repository");
    return { repo, octokit: await app.getInstallationOctokit(repo.installationId) };
  }
  const lostAccess = (r: Repository) =>
    `NEXUS can't access ${r.fullName} anymore. Check that the NEXUS app is still installed on it.`;

  /** A fresh installation token for one repository with exactly `permissions`, and an Octokit using it. */
  async function scopedToken(repo: Repository, permissions: Record<string, "read" | "write">) {
    const { token, expiresAt } = (await github(
      () =>
        app.octokit.auth({
          type: "installation",
          installationId: repo.installationId,
          repositoryIds: [Number(repo.id)],
          permissions,
          refresh: true, // never a cached token: the runner gets the full lifetime, and scopes can't mix
        }),
      lostAccess(repo),
    )) as { token: string; expiresAt: string };
    // The app's own Octokit class with plain token auth (no app-level auth hook).
    const Octokit = app.octokit.constructor as new (o: { auth: string }) => typeof app.octokit;
    return { token, expiresAt, octokit: new Octokit({ auth: token }) };
  }

  // github() maps GitHub's 422 (Unprocessable) to a 400.
  const rejected = (e: unknown) => e instanceof HttpError && e.statusCode === 400;
  const validation = (field: string, message: string) =>
    new HttpError(400, "VALIDATION_FAILED", message, { field });

  return {
    async status(): Promise<GithubStatus> {
      const { value, syncedAt } = await installations();
      return { configured: true, appSlug: config.slug, installUrl, installations: value, syncedAt };
    },

    async repositories(q?: string): Promise<RepositoryList> {
      const { value, syncedAt } = await repositories();
      const needle = q?.toLowerCase();
      return {
        items: needle ? value.filter((r) => r.fullName.toLowerCase().includes(needle)) : value,
        syncedAt,
      };
    },

    async issues(repoId: string, q: IssueListQuery): Promise<IssueList> {
      const { repo, octokit } = await repository(repoId);
      const { value, syncedAt } = await cached(`issues:${repo.id}:${JSON.stringify(q)}`, () =>
        github(async () => {
          const labels = q.labels?.split(",").map((l) => l.trim()) ?? [];
          if (!q.q) {
            const res = await octokit.request("GET /repos/{owner}/{repo}/issues", {
              owner: repo.owner,
              repo: repo.name,
              state: q.state,
              ...(labels.length ? { labels: labels.join(",") } : {}),
              ...(q.assignee ? { assignee: q.assignee } : {}),
              sort: "updated",
              direction: "desc",
              per_page: ISSUE_PAGE_SIZE,
              page: q.page,
            });
            return {
              // The issues endpoint also returns pull requests (GH-G02).
              items: res.data.filter((i) => !i.pull_request).map(toIssue),
              more: /\brel="next"/.test(res.headers.link ?? ""),
            };
          }
          // Full text goes through search. User words are quoted so they can't add qualifiers (e.g. repo:other/x).
          const words = q.q.replaceAll('"', " ").split(/\s+/).filter(Boolean);
          const res = await octokit.request("GET /search/issues", {
            q: [
              `repo:${repo.fullName}`,
              "is:issue",
              ...(q.state === "all" ? [] : [`state:${q.state}`]),
              ...labels.map((l) => `label:"${l}"`),
              ...(q.assignee ? [`assignee:${q.assignee}`] : []),
              ...words.map((w) => `"${w}"`),
            ].join(" "),
            sort: "updated",
            order: "desc",
            per_page: ISSUE_PAGE_SIZE,
            page: q.page,
          });
          const ownRepo = `/repos/${repo.fullName}`.toLowerCase();
          return {
            items: res.data.items
              .filter((i) => !i.pull_request && i.repository_url.toLowerCase().endsWith(ownRepo))
              .map(toIssue),
            more: q.page * ISSUE_PAGE_SIZE < Math.min(res.data.total_count, ISSUE_MAX_PAGE * ISSUE_PAGE_SIZE),
          };
        }, lostAccess(repo)),
      );
      return {
        items: value.items,
        page: q.page,
        nextPage: value.more && q.page < ISSUE_MAX_PAGE ? q.page + 1 : null,
        syncedAt,
      };
    },

    async issue(repoId: string, number: number): Promise<IssueDetail> {
      const { repo, octokit } = await repository(repoId);
      const params = { owner: repo.owner, repo: repo.name, issue_number: number };
      const missing = `Issue #${number} not found in ${repo.fullName}.`;
      const { value, syncedAt } = await cached(`issue:${repo.id}:${number}`, async () => {
        const issue = await github(
          () => octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", params),
          lostAccess(repo),
          missing,
        ).catch(async (e: unknown) => {
          // GitHub answers 404 both for a missing issue and for a repository the app lost: tell them apart.
          if (e instanceof HttpError && e.statusCode === 404)
            await github(
              () => octokit.request("GET /repos/{owner}/{repo}", { owner: repo.owner, repo: repo.name }),
              lostAccess(repo),
            );
          throw e;
        });
        if (issue.data.pull_request) throw new HttpError(404, "NOT_FOUND", `#${number} is a pull request.`);
        const comments = await github(
          () =>
            octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
              ...params,
              per_page: 100,
            }),
          lostAccess(repo),
          missing,
        );
        const body = stripHtmlComments(issue.data.body ?? "").trim();
        const acceptanceCriteria = extractAcceptanceCriteria(body);
        return {
          issue: toIssue(issue.data),
          body,
          comments: comments.data.map((c) => ({
            author: c.user?.login ?? null,
            body: stripHtmlComments(c.body ?? "").trim(),
            createdAt: new Date(c.created_at).toISOString(),
          })),
          acceptanceCriteria,
          missingAcceptanceCriteria: acceptanceCriteria.length === 0,
        };
      });
      return { ...value, syncedAt };
    },

    /**
     * FR-DEV-01 qualification: the repository is in an installation that grants contents + pull_requests write,
     * the issue exists and is not a PR, and the base branch exists. Returns the snapshot to pin on the job.
     * shortcut: issue and installation data may be up to 60 s old (catalog cache); webhooks refresh it with FR-GH-10.
     */
    async issueSnapshot(repoId: string, number: number, baseBranch?: string): Promise<IssueSnapshot> {
      const repo = (await repositories()).value.find((r) => r.id === repoId);
      if (!repo) throw validation("repositoryId", "This repository isn't in any NEXUS app installation.");
      const inst = (await installations()).value.find((i) => i.id === repo.installationId);
      const missing = ISSUE_TO_PR_PERMISSIONS.filter((p) => inst?.permissions[p] !== "write");
      if (!inst || inst.suspended || missing.length > 0)
        throw new HttpError(
          403,
          "FORBIDDEN",
          `The NEXUS app needs ${missing.map((p) => `${p}: write`).join(" and ") || "an active installation"} on ${repo.fullName} to open draft PRs.`,
          { missingPermissions: missing, installUrl },
        );
      const branch = baseBranch ?? repo.defaultBranch;
      if (branch.startsWith(WORK_BRANCH_PREFIX))
        throw validation(
          "baseBranch",
          `The base branch can't be a NEXUS work branch (${WORK_BRANCH_PREFIX}…).`,
        );

      const detail = await this.issue(repoId, number).catch((e: unknown) => {
        if (e instanceof HttpError && e.statusCode === 404) throw validation("issueNumber", e.message);
        throw e;
      });
      const { octokit } = await repository(repoId);
      const head = await github(
        () =>
          octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
            owner: repo.owner,
            repo: repo.name,
            branch,
          }),
        lostAccess(repo),
        `Branch ${branch} not found in ${repo.fullName}.`,
      ).catch((e: unknown) => {
        if (e instanceof HttpError && e.statusCode === 404) throw validation("baseBranch", e.message);
        throw e;
      });
      return {
        repositoryId: repo.id,
        fullName: repo.fullName,
        issueNumber: number,
        title: detail.issue.title,
        body: detail.body.slice(0, 65_536),
        acceptanceCriteria: detail.acceptanceCriteria,
        htmlUrl: detail.issue.htmlUrl,
        issueUpdatedAt: detail.issue.updatedAt,
        baseBranch: branch,
        baseSha: head.data.commit.sha,
      };
    },

    /** The runner's git credentials: one repository, contents:read only, never cached (FR-SEC-06). */
    async readToken(repoId: string): Promise<IssueToPrTask["git"]> {
      const { repo } = await repository(repoId);
      const { token, expiresAt } = await scopedToken(repo, { contents: "read" });
      return { cloneUrl: `${repo.htmlUrl}.git`, token, expiresAt: new Date(expiresAt).toISOString() };
    },

    /**
     * Executes an approved PushDraftPrAction: blobs → tree on the base commit's tree → commit (parent baseSha)
     * → new ref → draft PR. Duplicate-safe (DEV-G08): an existing head ref is adopted only when it points at
     * the commit this action recorded (`knownCommit`), an existing PR for the head branch is adopted, and a ref
     * NEXUS didn't create is never moved. `recordCommit` must persist the commit before the ref is created.
     */
    async pushDraftPr(
      action: PushDraftPrAction,
      files: ChangesetFile[],
      knownCommit: string | null,
      recordCommit: (sha: string) => Promise<void>,
    ): Promise<PushResult> {
      const { repo } = await repository(action.repositoryId);
      const { octokit } = await scopedToken(repo, { contents: "write", pull_requests: "write" });
      const at = { owner: repo.owner, repo: repo.name };
      const call = <T>(fn: () => Promise<T>, missing?: string) => github(fn, lostAccess(repo), missing);
      const headRef = `heads/${action.headBranch}`;
      const refSha = async () =>
        call(
          () => octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { ...at, ref: headRef }),
          "no ref",
        ).then(
          (r) => r.data.object.sha,
          (e: unknown) => {
            if (e instanceof HttpError && e.statusCode === 404) return null;
            throw e;
          },
        );
      const notOurs = () =>
        new HttpError(
          409,
          "CONFLICT",
          `Branch ${action.headBranch} already exists on ${repo.fullName} and wasn't created by this run; NEXUS never moves a branch it didn't create.`,
        );

      let commit = knownCommit;
      const existing = await refSha();
      let adopted = existing !== null;
      if (existing !== null && existing !== commit) throw notOurs();
      if (existing === null) {
        if (!commit) {
          const base = await call(() =>
            octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
              ...at,
              commit_sha: action.baseSha,
            }),
          );
          const tree: { path: string; mode: ChangesetMode; type: "blob"; sha: string | null }[] = [];
          for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
            if (f.change === "deleted") {
              tree.push({ path: f.path, mode: "100644", type: "blob", sha: null });
              continue;
            }
            const blob = await call(() =>
              octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
                ...at,
                content: f.contentBase64,
                encoding: "base64",
              }),
            );
            tree.push({ path: f.path, mode: f.mode, type: "blob", sha: blob.data.sha });
          }
          const newTree = await call(() =>
            octokit.request("POST /repos/{owner}/{repo}/git/trees", {
              ...at,
              base_tree: base.data.tree.sha,
              tree,
            }),
          );
          const created = await call(() =>
            octokit.request("POST /repos/{owner}/{repo}/git/commits", {
              ...at,
              message: `${action.title}\n\nRefs #${action.issueNumber}`,
              tree: newTree.data.sha,
              parents: [action.baseSha],
              author: COMMIT_AUTHOR,
              committer: COMMIT_AUTHOR,
            }),
          );
          commit = created.data.sha;
          await recordCommit(commit);
        }
        const sha = commit;
        await call(() =>
          octokit.request("POST /repos/{owner}/{repo}/git/refs", { ...at, ref: `refs/${headRef}`, sha }),
        ).catch(async (e: unknown) => {
          // 422 "Reference already exists": lost a race. Adopt it only if it is our commit.
          if (!rejected(e)) throw e;
          const now = await refSha();
          if (now === null) throw e;
          if (now !== sha) throw notOurs();
          adopted = true;
        });
      }

      type Pr = { number: number; html_url: string; head: { sha: string } };
      const findPr = async (): Promise<Pr | undefined> =>
        (
          await call(() =>
            octokit.request("GET /repos/{owner}/{repo}/pulls", {
              ...at,
              head: `${repo.owner}:${action.headBranch}`,
              base: action.baseBranch,
              state: "all",
              per_page: 1,
            }),
          )
        ).data[0];
      let pr = await findPr();
      if (pr) adopted = true;
      else
        pr = await call<{ data: Pr }>(() =>
          octokit.request("POST /repos/{owner}/{repo}/pulls", {
            ...at,
            title: action.title,
            body: action.body,
            head: action.headBranch,
            base: action.baseBranch,
            draft: true,
          }),
        ).then(
          (r) => r.data,
          async (e: unknown): Promise<Pr> => {
            // 422 "A pull request already exists": adopt it.
            const raced = rejected(e) ? await findPr() : undefined;
            if (!raced) throw e;
            adopted = true;
            return raced;
          },
        );
      return { pullRequestNumber: pr.number, pullRequestUrl: pr.html_url, headSha: pr.head.sha, adopted };
    },
  };
}

export type GithubCatalog = ReturnType<typeof createGithubCatalog>;
