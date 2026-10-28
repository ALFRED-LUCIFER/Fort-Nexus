import { App } from "@octokit/app";
import type { FastifyBaseLogger } from "fastify";
import {
  ISSUE_MAX_PAGE,
  ISSUE_PAGE_SIZE,
  type GithubInstallation,
  type GithubStatus,
  type Issue,
  type IssueDetail,
  type IssueList,
  type IssueListQuery,
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

/**
 * Read-only view of what the NEXUS GitHub App can reach: its installations, their repositories and issues.
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
  };
}

export type GithubCatalog = ReturnType<typeof createGithubCatalog>;
