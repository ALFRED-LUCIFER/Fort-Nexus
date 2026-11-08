import { z } from "zod";
import { RepoId } from "./github.ts";

// Hand one GitHub issue to a Claude Code routine that runs in Anthropic's cloud (docs/specs/cloud-handoff.md).
// The owner approves the exact text by its hash; NEXUS fires the routine once; the session is claude.ai's and the PR is
// GitHub's. NEXUS never claims more than those two sources say.

export const CLOUD_HANDOFF_RUNBOOK = "docs/runbooks/claude-cloud.md";
/** The routine fire endpoint's own limit on `text`. */
export const CLOUD_HANDOFF_TEXT_MAX = 65_536;

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
export const RoutineId = z.string().regex(/^trig_[A-Za-z0-9]{1,64}$/);

/**
 * STARTING: the claim is written and the fire call is in flight (a lapsed one reads as UNKNOWN).
 * STARTED: Anthropic answered with a session. UNKNOWN: the call may or may not have created a session (timeout,
 * 5xx, crash): look at the routine's runs on claude.ai. FAILED: Anthropic refused it, no session exists.
 */
export const CloudHandoffStatus = z.enum(["STARTING", "STARTED", "UNKNOWN", "FAILED"]);
export type CloudHandoffStatus = z.infer<typeof CloudHandoffStatus>;

/** Whether this repository has a routine in ~/.nexus/claude-cloud.json. Never the token or the file's content. */
export const CloudRoutineStatus = z.discriminatedUnion("configured", [
  z.object({
    configured: z.literal(false),
    reason: z.enum(["NO_FILE", "INVALID_FILE", "NO_ROUTINE_FOR_REPO"]),
    /** One owner-facing sentence: what to do on the home machine. */
    detail: z.string(),
    runbook: z.string(),
  }),
  z.object({ configured: z.literal(true), routineId: RoutineId }),
]);
export type CloudRoutineStatus = z.infer<typeof CloudRoutineStatus>;

/** A PR GitHub shows for the handoff: on a `claude/` branch, opened after it, its description says "Fixes #n". */
export const CloudHandoffPullRequest = z.object({
  number: z.int().positive(),
  url: z.url(),
  title: z.string(),
  branch: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  draft: z.boolean(),
});
export type CloudHandoffPullRequest = z.infer<typeof CloudHandoffPullRequest>;

export const CloudHandoff = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  repositoryId: RepoId,
  repositoryFullName: z.string(),
  issueNumber: z.int().positive(),
  routineId: RoutineId,
  status: CloudHandoffStatus,
  /** Only from Anthropic's 200 response. */
  sessionUrl: z.url().nullable(),
  /** Owner-facing reason for FAILED / UNKNOWN; never a token or a raw upstream body. */
  error: z.string().nullable(),
  /** From a 429's Retry-After. */
  retryAfterSeconds: z.int().nonnegative().nullable(),
  /** Only from GitHub; null until GitHub has one (or when GitHub can't be read right now, see `pullRequestCheck`). */
  pullRequest: CloudHandoffPullRequest.nullable(),
  /** OK: GitHub was read. UNAVAILABLE: it couldn't be read, so "no PR" isn't known. NOT_APPLICABLE: no session. */
  pullRequestCheck: z.enum(["OK", "UNAVAILABLE", "NOT_APPLICABLE"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CloudHandoff = z.infer<typeof CloudHandoff>;

// GET /v1/repositories/:repoId/issues/:number/cloud-handoff?projectId=
export const CloudHandoffQuery = z.object({ projectId: z.uuid() });
export type CloudHandoffQuery = z.infer<typeof CloudHandoffQuery>;

export const CloudHandoffState = z.object({
  routine: CloudRoutineStatus,
  /** The newest handoff of this issue in this project. */
  latest: CloudHandoff.nullable(),
});
export type CloudHandoffState = z.infer<typeof CloudHandoffState>;

// POST /v1/repositories/:repoId/issues/:number/cloud-handoff/preview
export const CloudHandoffPreviewRequest = z.strictObject({ projectId: z.uuid() });
export type CloudHandoffPreviewRequest = z.infer<typeof CloudHandoffPreviewRequest>;

export const CloudHandoffPreview = z.object({
  projectId: z.uuid(),
  repositoryId: RepoId,
  repositoryFullName: z.string(),
  issueNumber: z.int().positive(),
  routineId: RoutineId,
  /** Exactly the `text` NEXUS will send to the routine. */
  text: z.string().max(CLOUD_HANDOFF_TEXT_MAX),
  /** Human rows for the preview card: does / where / billing / won't do / next. */
  rows: z.array(z.object({ k: z.string(), v: z.string() })),
  /** sha256 of the canonical {projectId, repositoryId, issueNumber, routineId, text}; the approval binds to it. */
  actionHash: Hash,
  expiresAt: z.iso.datetime(),
});
export type CloudHandoffPreview = z.infer<typeof CloudHandoffPreview>;

// POST /v1/repositories/:repoId/issues/:number/cloud-handoff — Idempotency-Key required; R2: the owner's click on
// this exact hash. Answers once Anthropic has (STARTED / FAILED / UNKNOWN).
export const CreateCloudHandoffRequest = z.strictObject({
  projectId: z.uuid(),
  actionHash: Hash,
  /** Required when the issue's newest handoff is STARTED or UNKNOWN: the owner confirms a second session. */
  confirmResend: z.boolean().default(false),
});
export type CreateCloudHandoffRequest = z.infer<typeof CreateCloudHandoffRequest>;
