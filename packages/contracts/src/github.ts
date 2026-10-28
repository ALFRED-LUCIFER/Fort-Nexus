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

export const RepositoryQuery = z.object({ q: z.string().trim().max(100).optional() });
export type RepositoryQuery = z.infer<typeof RepositoryQuery>;

export const RepositoryList = z.object({ items: z.array(Repository), syncedAt: z.iso.datetime() });
export type RepositoryList = z.infer<typeof RepositoryList>;

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
