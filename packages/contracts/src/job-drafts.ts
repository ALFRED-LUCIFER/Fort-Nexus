import { z } from "zod";
import { RepoId } from "./github.ts";

// Jobs wave: "implement X in repo Y" in plain words (FR-CMD-02/04/05, FR-CXR-09, CMD-G01). The model only drafts:
// the server resolves the repository among the project's bound repos (never guesses), builds the exact issue and
// run, and the owner approves that exact hash. A new issue is an external write (R2); a run on an existing issue is R1.

// The run settings the draft will start with; the same bounds as CreateJobRequest DEV_ISSUE_TO_PR budget.
export const JobDraftBudget = z.strictObject({
  maxWallClockMinutes: z.int().min(5).max(120),
  maxTurns: z.int().min(1).max(200),
  maxCostUsd: z.number().positive().max(50),
});
export type JobDraftBudget = z.infer<typeof JobDraftBudget>;

export const JobDraftStatus = z.enum([
  // Ready to preview and approve.
  "READY",
  // The repository is missing or ambiguous: the owner picks one of `candidates` (CMD-G01). Nothing can start.
  "NEEDS_REPO",
  // The text isn't a coding job NEXUS can run (e.g. a shell command); `unsupportedReason` says why.
  "UNSUPPORTED",
  // Approved: the issue exists (when NEW_ISSUE) and the job was created; `jobId` is set.
  "STARTED",
  "DISCARDED",
  // The approved action failed; `error` is owner-safe. A retry with the same preview hash resumes it.
  "FAILED",
]);
export type JobDraftStatus = z.infer<typeof JobDraftStatus>;

export const JobDraftKind = z.enum(["NEW_ISSUE", "EXISTING_ISSUE"]);
export type JobDraftKind = z.infer<typeof JobDraftKind>;

const Repo = z.object({ id: RepoId, fullName: z.string() });

export const JobDraft = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  status: JobDraftStatus,
  // The owner's words, as typed.
  text: z.string(),
  // Null only when UNSUPPORTED.
  kind: JobDraftKind.nullable(),
  repository: Repo.nullable(),
  // NEEDS_REPO: the project's bound repositories the owner can choose from (all of them when none was named).
  candidates: z.array(Repo),
  // NEW_ISSUE: the issue as it will be created (server-neutralised: no mentions, no links). Labelled AI-drafted.
  issue: z.object({ title: z.string().max(256), body: z.string().max(20_000) }).nullable(),
  // EXISTING_ISSUE: the issue the run starts from.
  issueNumber: z.int().positive().nullable(),
  budget: JobDraftBudget,
  unsupportedReason: z.string().nullable(),
  // Set only from GitHub's response.
  createdIssue: z.object({ number: z.int().positive(), url: z.url() }).nullable(),
  jobId: z.uuid().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type JobDraft = z.infer<typeof JobDraft>;

export const JobDraftList = z.object({ items: z.array(JobDraft), nextCursor: z.uuid().nullable() });
export type JobDraftList = z.infer<typeof JobDraftList>;

export const JOB_DRAFT_TEXT_MAX = 4000;

// POST /v1/job-drafts — Idempotency-Key required. One model call drafts it; 409 when ai.json is missing.
export const CreateJobDraftRequest = z.strictObject({
  projectId: z.uuid(),
  text: z.string().trim().min(3).max(JOB_DRAFT_TEXT_MAX),
  // Pre-selected by the owner (e.g. opened from a repository); must be bound to the project.
  repositoryId: RepoId.optional(),
});
export type CreateJobDraftRequest = z.infer<typeof CreateJobDraftRequest>;

// PATCH /v1/job-drafts/:id — only while READY or NEEDS_REPO. Any change invalidates an earlier preview.
export const UpdateJobDraftRequest = z
  .strictObject({
    repositoryId: RepoId.optional(),
    title: z.string().trim().min(3).max(256).optional(),
    body: z.string().trim().min(1).max(20_000).optional(),
    issueNumber: z.int().positive().optional(),
    budget: JobDraftBudget.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export type UpdateJobDraftRequest = z.infer<typeof UpdateJobDraftRequest>;

// POST /v1/job-drafts/:id/preview — READY only.
export const JobDraftPreviewRequest = z.strictObject({ runnerId: z.uuid().optional() });
export type JobDraftPreviewRequest = z.infer<typeof JobDraftPreviewRequest>;

export const JobDraftPreview = z.object({
  draftId: z.uuid(),
  // R2 when it creates an issue, R1 when it only starts a run on an existing one.
  riskTier: z.enum(["R1", "R2"]),
  // "Exactly what will happen": creates issue · in repo · then runs · on runner · budget · won't do.
  rows: z.array(z.object({ k: z.string(), v: z.string() })),
  // sha256 of the canonical {draftId, kind, repositoryId, title, body, issueNumber, budget, runnerId}.
  actionHash: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type JobDraftPreview = z.infer<typeof JobDraftPreview>;

// POST /v1/job-drafts/:id/approve — Idempotency-Key required; binds to the latest unexpired preview's hash.
export const ApproveJobDraftRequest = z.strictObject({
  actionHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ApproveJobDraftRequest = z.infer<typeof ApproveJobDraftRequest>;

export const ListJobDraftsQuery = z.object({
  projectId: z.uuid().optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListJobDraftsQuery = z.infer<typeof ListJobDraftsQuery>;
