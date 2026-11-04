import { z } from "zod";

// EPIC GH: the NEXUS GitHub App's installations, their repositories and issues (FR-GH-02/04/07/08).
// Repository ids are GitHub's numeric ids, as strings.

export const RepoId = z.string().regex(/^[1-9][0-9]{0,19}$/, "Invalid repository id");

export const GithubInstallation = z.object({
  id: z.int().positive(),
  account: z.object({ login: z.string(), type: z.string() }),
  repositorySelection: z.enum(["all", "selected"]),
  suspended: z.boolean(),
  // What the owner granted on this installation, e.g. { issues: "read", pull_requests: "write" } (FR-GH-02).
  permissions: z.record(z.string(), z.string()),
});
export type GithubInstallation = z.infer<typeof GithubInstallation>;

/** `GET /v1/github/status`. Not configured: show GITHUB_SETUP_COMMAND. No installations: show installUrl. */
export const GithubStatus = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    appSlug: z.string(),
    installUrl: z.url(),
    installations: z.array(GithubInstallation),
    syncedAt: z.iso.datetime(),
  }),
]);
export type GithubStatus = z.infer<typeof GithubStatus>;

export const Repository = z.object({
  id: RepoId,
  fullName: z.string(),
  owner: z.string(),
  name: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  htmlUrl: z.url(),
  pushedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  installationId: z.int().positive(),
});
export type Repository = z.infer<typeof Repository>;

export const RepositoryQuery = z.object({
  q: z.string().trim().max(100).optional(),
  // Only repositories bound to this project (FR-WKS-03); omitted = every installed repository (Settings / binding UI).
  projectId: z.uuid().optional(),
});
export type RepositoryQuery = z.infer<typeof RepositoryQuery>;

export const RepositoryList = z.object({ items: z.array(Repository), syncedAt: z.iso.datetime() });
export type RepositoryList = z.infer<typeof RepositoryList>;

// ---------------------------------------------------------------- FR-GH-05: repository health and details

// GitHub check runs on the head of the default branch (the app has checks:read). Commit statuses from older CI
// integrations need statuses:read, which the app doesn't ask for, so they are not counted.
// FAILING: a check failed, timed out, failed to start or needs action. PENDING: none failed, some still run.
// NONE: no checks on that commit, or the repository is empty.
export const CiState = z.enum(["PASSING", "FAILING", "PENDING", "NONE"]);
export type CiState = z.infer<typeof CiState>;

export const CiSummary = z.object({
  state: CiState,
  /** The commit the checks ran on; null when unknown (no checks, or an empty repository). */
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  total: z.int().nonnegative(),
  /** Names of the failing checks, at most 10. */
  failing: z.array(z.string().max(200)).max(10),
  /** When the latest finished check finished. */
  completedAt: z.iso.datetime().nullable(),
});
export type CiSummary = z.infer<typeof CiSummary>;

/** Lists of pull requests and branches stop at this many; `…More` says there are more. */
export const REPO_LIST_CAP = 100;

export const RepositoryHealth = z.object({
  repository: Repository,
  archived: z.boolean(),
  /** null when GitHub couldn't be asked for this repository: `error` says why, the other repositories still show. */
  openPullRequests: z.int().nonnegative().nullable(),
  draftPullRequests: z.int().nonnegative().nullable(),
  /** True when there are more than REPO_LIST_CAP open pull requests (the counts stop there). */
  pullRequestsMore: z.boolean(),
  /** Open issues without pull requests; null when unknown (GitHub counts both together). */
  openIssues: z.int().nonnegative().nullable(),
  ci: CiSummary.nullable(),
  error: z.string().nullable(),
  syncedAt: z.iso.datetime(),
});
export type RepositoryHealth = z.infer<typeof RepositoryHealth>;

// GET /v1/repositories/health?projectId= — the project's bound repositories, or every installed one without it.
export const RepositoryHealthList = z.object({ items: z.array(RepositoryHealth) });
export type RepositoryHealthList = z.infer<typeof RepositoryHealthList>;

export const PullRequestSummary = z.object({
  number: z.int().positive(),
  title: z.string(),
  draft: z.boolean(),
  author: z.string().nullable(),
  headBranch: z.string(),
  baseBranch: z.string(),
  /** Opened by a NEXUS run (its head is a NEXUS work branch). */
  nexus: z.boolean(),
  updatedAt: z.iso.datetime(),
  htmlUrl: z.url(),
});
export type PullRequestSummary = z.infer<typeof PullRequestSummary>;

export const BranchSummary = z.object({
  name: z.string(),
  protected: z.boolean(),
  default: z.boolean(),
  /** A NEXUS work branch. */
  nexus: z.boolean(),
});
export type BranchSummary = z.infer<typeof BranchSummary>;

export const CheckRunSummary = z.object({
  name: z.string(),
  status: z.string().max(40),
  conclusion: z.string().max(40).nullable(),
  htmlUrl: z.url().nullable(),
});
export type CheckRunSummary = z.infer<typeof CheckRunSummary>;

// GET /v1/repositories/:repoId/details — FR-GH-05: branches, pull requests and CI of one repository.
export const RepositoryDetails = z.object({
  repository: Repository,
  archived: z.boolean(),
  openIssues: z.int().nonnegative().nullable(),
  pullRequests: z.array(PullRequestSummary).max(REPO_LIST_CAP),
  pullRequestsMore: z.boolean(),
  branches: z.array(BranchSummary).max(REPO_LIST_CAP),
  branchesMore: z.boolean(),
  ci: CiSummary,
  checks: z.array(CheckRunSummary).max(REPO_LIST_CAP),
  syncedAt: z.iso.datetime(),
});
export type RepositoryDetails = z.infer<typeof RepositoryDetails>;

export const IssueLabel = z.object({ name: z.string(), color: z.string().regex(/^([0-9a-fA-F]{6})?$/) });
export type IssueLabel = z.infer<typeof IssueLabel>;

export const Issue = z.object({
  number: z.int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  labels: z.array(IssueLabel),
  assignees: z.array(z.string()),
  milestone: z.string().nullable(),
  author: z.string().nullable(),
  comments: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  htmlUrl: z.url(),
});
export type Issue = z.infer<typeof Issue>;

export const ISSUE_PAGE_SIZE = 25;
// GitHub search returns at most 1000 results; 40 pages of 25 cover that.
export const ISSUE_MAX_PAGE = 40;

const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);

export const IssueListQuery = z.object({
  state: z.enum(["open", "closed", "all"]).default("open"),
  // Comma-separated label names (all must match).
  labels: z.preprocess(
    blankToUndefined,
    z
      .string()
      .max(500)
      .regex(/^[^,"]+(,[^,"]+){0,19}$/, "Up to 20 comma-separated labels, no quotes")
      .optional(),
  ),
  assignee: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "Invalid GitHub login")
      .optional(),
  ),
  q: z.preprocess(blankToUndefined, z.string().trim().min(1).max(256).optional()),
  page: z.coerce.number().int().min(1).max(ISSUE_MAX_PAGE).default(1),
});
export type IssueListQuery = z.infer<typeof IssueListQuery>;

export const IssueList = z.object({
  items: z.array(Issue),
  page: z.int().positive(),
  nextPage: z.int().positive().nullable(),
  syncedAt: z.iso.datetime(),
});
export type IssueList = z.infer<typeof IssueList>;

export const IssueComment = z.object({
  author: z.string().nullable(),
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export type IssueComment = z.infer<typeof IssueComment>;

/** Body and comments are GitHub-flavoured Markdown source, shown as plain text (never rendered as HTML). */
export const IssueDetail = z.object({
  issue: Issue,
  body: z.string(),
  comments: z.array(IssueComment),
  acceptanceCriteria: z.array(z.string()),
  missingAcceptanceCriteria: z.boolean(),
  syncedAt: z.iso.datetime(),
});
export type IssueDetail = z.infer<typeof IssueDetail>;
