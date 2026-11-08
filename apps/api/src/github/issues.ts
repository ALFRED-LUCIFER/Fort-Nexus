import type { FastifyBaseLogger } from "fastify";
import type { Repository } from "@nexus/contracts";
import { HttpError, notFound } from "../errors.ts";
import type { GithubAppConfig } from "./app-config.ts";
import type { GithubCatalog } from "./catalog.ts";
import { GITHUB_TIMEOUT_MS, createGithubApp, isAbort } from "./timeout.ts";

// FR-CXR-09: the one GitHub write the AI researcher can lead to, an issue the owner approved by its exact hash.
// Tokens are minted per repository with `issues: write` only and never leave this module.

export const ISSUES_RUNBOOK = "docs/runbooks/github-setup.md";
const PERMISSION = "Issues: read & write";
// shortcut: the marker search reads the newest 500 issues updated since the claim; enough for one owner's repos.
const FIND_PAGES = 5;

export type IssueDraft = { title: string; body: string; labels: string[] };
export type CreatedIssue = { repositoryFullName: string; number: number; url: string };

type GithubError = Error & {
  status: number;
  request?: { url?: string };
  response?: { headers?: Record<string, string | number | undefined> };
};
const isGithubError = (e: unknown): e is GithubError =>
  e instanceof Error && typeof (e as { status?: unknown }).status === "number";

type GhIssue = {
  number: number;
  html_url: string;
  body?: string | null;
  user: { login: string; type?: string } | null;
  pull_request?: unknown;
};

export const missingIssuesPermission = (fullName: string) =>
  new HttpError(
    409,
    "CONFLICT",
    `The NEXUS GitHub App needs the "${PERMISSION}" permission on ${fullName} to create issues. Change it in the app's settings on GitHub and accept it on the installation (${ISSUES_RUNBOOK}).`,
    { missingPermission: PERMISSION, runbook: ISSUES_RUNBOOK },
  );

/**
 * Creates and finds NEXUS's own issues. `target` answers from the catalog's cached installation list (GH-G01:
 * only repositories of the app's installations exist); `find` and `create` call GitHub with a fresh scoped token.
 */
export function createIssueWriter(config: GithubAppConfig, catalog: GithubCatalog, log: FastifyBaseLogger) {
  const app = createGithubApp(config);
  const bot = `${config.slug}[bot]`;
  const Octokit = app.octokit.constructor as new (o: { auth: string }) => typeof app.octokit;
  const lost = (r: Repository) =>
    `NEXUS can't access ${r.fullName} anymore. Check that the NEXUS app is still installed on it.`;

  /** Maps a GitHub failure to an owner-safe ApiError; never retries with other credentials (GH-G04). */
  function mapped(e: unknown, repo: Repository): unknown {
    if (isAbort(e)) return new HttpError(502, "INTERNAL", "GitHub didn't answer in time. Try again shortly.");
    if (!isGithubError(e)) return e;
    const h = e.response?.headers ?? {};
    log.warn(
      { githubStatus: e.status, githubRequestId: h["x-github-request-id"], repositoryId: repo.id },
      "github issue request failed",
    );
    if (
      e.status === 429 ||
      (e.status === 403 && (String(h["x-ratelimit-remaining"]) === "0" || /rate limit/i.test(e.message)))
    )
      return new HttpError(
        429,
        "RATE_LIMITED",
        "GitHub's rate limit is reached. Try again in a few minutes.",
      );
    if (e.request?.url?.includes("/access_tokens"))
      // 422: the installation doesn't grant the requested `issues: write`.
      return e.status === 422
        ? missingIssuesPermission(repo.fullName)
        : new HttpError(403, "FORBIDDEN", `${lost(repo)} The app's installation is gone or suspended.`);
    if (e.status === 401)
      return new HttpError(
        403,
        "FORBIDDEN",
        "GitHub rejected the NEXUS app's credentials. If the app was deleted or its key revoked, re-run the GitHub setup with --force.",
      );
    // "Resource not accessible by integration": the token lacks the permission.
    if (e.status === 403) return missingIssuesPermission(repo.fullName);
    if (e.status === 404) return new HttpError(403, "FORBIDDEN", lost(repo));
    if (e.status === 410)
      return new HttpError(
        409,
        "CONFLICT",
        `Issues are turned off on ${repo.fullName}. Turn them on in the repository settings, or pick another repository.`,
      );
    return new HttpError(
      502,
      "INTERNAL",
      `GitHub is unavailable right now (HTTP ${e.status || "error"}). Try again shortly.`,
    );
  }

  async function call<T>(repo: Repository, fn: (o: InstanceType<typeof Octokit>) => Promise<T>): Promise<T> {
    try {
      const { token } = (await app.octokit.auth({
        type: "installation",
        installationId: repo.installationId,
        repositoryIds: [Number(repo.id)],
        permissions: { issues: "write" },
      })) as { token: string };
      return await fn(new Octokit({ auth: token }));
    } catch (e) {
      throw mapped(e, repo);
    }
  }

  const at = (r: Repository) => ({
    owner: r.owner,
    repo: r.name,
    request: { signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) },
  });
  const toCreated = (r: Repository, i: GhIssue): CreatedIssue => ({
    repositoryFullName: r.fullName,
    number: i.number,
    url: i.html_url,
  });

  return {
    /** The repository, when its installation is active and grants issues: write; 409 naming the permission otherwise. */
    async target(repoId: string): Promise<Repository> {
      const repo = (await catalog.repositories()).items.find((r) => r.id === repoId);
      if (!repo) throw notFound("Repository");
      const status = await catalog.status();
      const inst = status.configured
        ? status.installations.find((i) => i.id === repo.installationId)
        : undefined;
      if (!inst || inst.suspended)
        throw new HttpError(403, "FORBIDDEN", `${lost(repo)} The app's installation is gone or suspended.`);
      if (inst.permissions.issues !== "write") throw missingIssuesPermission(repo.fullName);
      return repo;
    },

    /**
     * An issue this app created (open or closed) whose body carries `marker`, updated since `since`; null if none.
     * Reads the list endpoint, not search: search lags behind a just-created issue.
     */
    async find(repo: Repository, marker: string, since: Date): Promise<CreatedIssue | null> {
      for (let page = 1; page <= FIND_PAGES; page++) {
        const { data } = await call(repo, (o) =>
          o.request("GET /repos/{owner}/{repo}/issues", {
            ...at(repo),
            state: "all",
            since: since.toISOString(),
            sort: "created",
            direction: "desc",
            per_page: 100,
            page,
          }),
        );
        const hit = (data as GhIssue[]).find(
          (i) => !i.pull_request && i.user?.login === bot && (i.body ?? "").includes(marker),
        );
        if (hit) return toCreated(repo, hit);
        if (data.length < 100) return null;
      }
      return null;
    },

    async create(repo: Repository, draft: IssueDraft): Promise<CreatedIssue> {
      const { data } = await call(repo, (o) =>
        o.request("POST /repos/{owner}/{repo}/issues", {
          ...at(repo),
          title: draft.title,
          body: draft.body,
          ...(draft.labels.length ? { labels: draft.labels } : {}),
        }),
      );
      return toCreated(repo, data as GhIssue);
    },
  };
}

export type IssueWriter = ReturnType<typeof createIssueWriter>;
