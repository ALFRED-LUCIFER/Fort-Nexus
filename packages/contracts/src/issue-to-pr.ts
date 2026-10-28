import { z } from "zod";
import { RepoId } from "./github.ts";

// ENG-07 issue → draft PR. The runner only ever holds a short-lived READ token; the API alone pushes and opens the
// draft PR, and only after the owner approves the exact action hash (PRD §10.3 R2, FR-DEV-07/08, SEC-G04).

// Pinned at job creation so the runner works from exactly what the owner launched (FR-GH-09, GH-G03).
export const IssueSnapshot = z.object({
  repositoryId: RepoId,
  fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  issueNumber: z.int().positive(),
  title: z.string(),
  body: z.string().max(65_536),
  acceptanceCriteria: z.array(z.string()),
  htmlUrl: z.url(),
  issueUpdatedAt: z.iso.datetime(),
  baseBranch: z.string().min(1).max(255),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
});
export type IssueSnapshot = z.infer<typeof IssueSnapshot>;

export const WORK_BRANCH_PREFIX = "nexus/";

// Sent with the lease of a DEV_ISSUE_TO_PR job only.
export const IssueToPrTask = z.object({
  kind: z.literal("issue_to_pr"),
  snapshot: IssueSnapshot,
  workBranch: z.string().startsWith(WORK_BRANCH_PREFIX).max(255),
  git: z.object({
    cloneUrl: z.url(),
    // Installation token restricted to this one repository with contents:read only. Host-side fetch only — never
    // passed into the sandbox, never logged.
    token: z.string().min(1),
    expiresAt: z.iso.datetime(),
  }),
});
export type IssueToPrTask = z.infer<typeof IssueToPrTask>;

export const CHANGESET_MAX_FILES = 300;
// Sum of decoded (raw) file bytes. Base64 adds ~4/3, so the upload route's body limit must allow ≈14 MB + JSON.
export const CHANGESET_MAX_BYTES = 10 * 1024 * 1024;

const SafePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.includes("\0") &&
      p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..") &&
      p.split("/")[0] !== ".git",
    "Unsafe path",
  );

export const ChangesetFile = z.discriminatedUnion("change", [
  z.strictObject({
    change: z.enum(["added", "modified"]),
    path: SafePath,
    mode: z.enum(["100644", "100755", "120000"]),
    contentBase64: z.base64(),
  }),
  z.strictObject({ change: z.literal("deleted"), path: SafePath }),
]);
export type ChangesetFile = z.infer<typeof ChangesetFile>;

// POST /v1/runner/jobs/:id/changeset — job must be RUNNING/VERIFYING under the caller's lease (fencing token).
export const UploadChangesetRequest = z.strictObject({
  fencingToken: z.int().positive(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  files: z.array(ChangesetFile).min(1).max(CHANGESET_MAX_FILES),
  stats: z.strictObject({
    added: z.int().nonnegative(),
    removed: z.int().nonnegative(),
  }),
  // The agent's own final summary — untrusted text, shown labelled as such, never used as authority.
  agentSummary: z.string().max(4000),
});
export type UploadChangesetRequest = z.infer<typeof UploadChangesetRequest>;

// Retry-safe: re-uploading the identical changeset for the same lease returns the existing approval (200).
export const UploadChangesetResponse = z.object({
  approvalId: z.uuid(),
  actionHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type UploadChangesetResponse = z.infer<typeof UploadChangesetResponse>;

export const ApprovalStatus = z.enum(["PENDING", "APPROVED", "DENIED", "EXPIRED", "EXECUTED", "FAILED"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

// Everything the owner approves; actionHash = sha256 of its canonical JSON, computed by the server only.
export const PushDraftPrAction = z.object({
  type: z.literal("github.push_draft_pr"),
  repositoryId: RepoId,
  repositoryFullName: z.string(),
  issueNumber: z.int().positive(),
  baseBranch: z.string(),
  baseSha: z.string(),
  headBranch: z.string().startsWith(WORK_BRANCH_PREFIX),
  title: z.string(),
  body: z.string(),
  changesetSha256: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(z.object({ path: z.string(), change: z.enum(["added", "modified", "deleted"]) })),
  stats: z.object({ added: z.int(), removed: z.int() }),
});
export type PushDraftPrAction = z.infer<typeof PushDraftPrAction>;

export const Approval = z.object({
  id: z.uuid(),
  jobId: z.uuid(),
  riskTier: z.literal("R2"),
  status: ApprovalStatus,
  action: PushDraftPrAction,
  actionHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  // Set only from the GitHub API response (truth hierarchy) — never from agent output.
  result: z
    .object({ pullRequestNumber: z.int().positive(), pullRequestUrl: z.url(), headSha: z.string() })
    .nullable(),
  error: z.string().nullable(),
});
export type Approval = z.infer<typeof Approval>;

export const ApprovalList = z.object({ items: z.array(Approval) });
export type ApprovalList = z.infer<typeof ApprovalList>;

export const ListApprovalsQuery = z.object({
  status: ApprovalStatus.optional(),
  jobId: z.uuid().optional(),
});
export type ListApprovalsQuery = z.infer<typeof ListApprovalsQuery>;

export const ApprovalDecisionRequest = z.strictObject({
  decision: z.enum(["approve", "deny"]),
  // Must equal the current actionHash; a changed action needs a fresh decision (SEC-G04).
  actionHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
