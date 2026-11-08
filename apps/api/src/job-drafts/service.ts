import { and, desc, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import {
  JobDraftBudget,
  PROPOSAL_TTL_MS,
  type AgentTool,
  type ApproveJobDraftRequest,
  type CreateJobDraftRequest,
  type CreateJobRequest,
  type EffectiveAgentProfile,
  type JobDraft,
  type JobDraftList,
  type JobDraftPreview,
  type JobDraftPreviewRequest,
  type JobDraftStatus,
  type ListJobDraftsQuery,
  type UpdateJobDraftRequest,
} from "@nexus/contracts";
import { costUsd } from "../ai-cost.ts";
import { loadAi } from "../ai.ts";
import type { Deps } from "../app.ts";
import { resolveAgentProfile } from "../agents/service.ts";
import { audit } from "../audit.ts";
import type { Db, Tx } from "../db/index.ts";
import { jobs, projectRepositories, runners } from "../db/schema.ts";
import { HttpError, notFound } from "../errors.ts";
import { stripHtmlComments } from "../github/acceptance-criteria.ts";
import { inert, inertLines, inertTitle, reinertTitle } from "../github/issue-text.ts";
import type { IssueWriter } from "../github/issues.ts";
import { canonical, createJob, sha256 } from "../jobs.ts";
import { requireGithub } from "../routes/github.ts";
import { assertNotStopped, reserveAiSpend, settleAiSpend } from "../system.ts";
import { boundRepositoryIds, ownerWorkspaceIds, resolveProject } from "../workspaces.ts";
import { draftJob, type DraftedJob } from "./draft.ts";
import { jobDrafts } from "./schema.ts";

// Jobs wave B (FR-CMD-02/04/05, FR-CXR-09, CMD-G01): plain words → a drafted job (model) → the repository resolved
// among the project's bound ones and the exact issue + run built (server) → one approval of that hash (owner) →
// the issue (R2, at most once) and the run (R1, at most once).

type Row = typeof jobDrafts.$inferSelect;
type Repo = { id: string; fullName: string };

export type Ctx = { ownerId: string; actor: string; correlationId: string };
export type JobDraftDeps = Pick<Deps, "db" | "config" | "github"> & { writer: IssueWriter | null };

const AGENT = "DEVELOPER";
const RUN_TOOL: AgentTool = "jobs.create.issue_run";
const ISSUE_TOOL: AgentTool = "github.issues.create";
// Reserved against today's budget for the one drafting call (FR-CSP-08); its worst case fits well inside.
const DRAFT_CAP_USD = 0.25;
const DEFAULT_MINUTES = 45;
const BODY_MAX = 20_000;
// Longer than one model call with the SDK's retries: a claim this old belongs to a crashed attempt.
const STALE_DRAFTING_MS = 5 * 60_000;
// An approval's GitHub calls and job creation end well inside this; a crashed one's lease lapses.
const LEASE_MS = 5 * 60_000;
// The marker search starts this long before the draft, so clock skew with GitHub can't hide an issue.
const CLOCK_SKEW_MS = 10 * 60_000;
const FOOTER =
  "_Drafted by the NEXUS Developer agent from your request. AI inference; review before approving._";

export const draftMarker = (id: string) => `<!-- nexus:job-draft:${id} -->`;
const tail = (id: string) => `\n\n---\n\n${FOOTER}\n\n${draftMarker(id)}`;
const jobKey = (id: string) => `job-draft:${id}`;
const usd = (n: number) => `$${n.toFixed(2)}`;

const toDto = (d: Row): JobDraft => ({
  id: d.id,
  projectId: d.projectId,
  status: d.status as JobDraftStatus, // DRAFTING rows never leave this module (owned/list filter them)
  text: d.text,
  kind: d.kind,
  repository:
    d.repositoryId && d.repositoryFullName ? { id: d.repositoryId, fullName: d.repositoryFullName } : null,
  candidates: d.candidates,
  issue:
    d.kind === "NEW_ISSUE" && d.issueTitle !== null && d.issueBody !== null
      ? { title: d.issueTitle, body: d.issueBody }
      : null,
  issueNumber: d.kind === "EXISTING_ISSUE" ? d.issueNumber : null,
  budget: d.budget,
  unsupportedReason: d.unsupportedReason,
  createdIssue:
    d.createdIssueNumber !== null && d.createdIssueUrl !== null
      ? { number: d.createdIssueNumber, url: d.createdIssueUrl }
      : null,
  jobId: d.jobId,
  error: d.error,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
});

const record = (
  tx: Db | Tx,
  ctx: Ctx,
  d: Pick<Row, "id" | "workspaceId" | "projectId">,
  action: string,
  metadata: Record<string, unknown>,
  outcome?: "SUCCEEDED" | "FAILED",
) =>
  audit(tx, {
    actor: ctx.actor,
    action,
    resourceType: "job_draft",
    resourceId: d.id,
    correlationId: ctx.correlationId,
    outcome,
    // Ids, enums and counts only: never the owner's text or the issue text.
    metadata: { workspaceId: d.workspaceId, projectId: d.projectId, ...metadata },
  });

/** The owner's draft (never one still being drafted); anything else doesn't exist for this caller. */
async function owned(db: Db | Tx, ownerId: string, id: string, lock = false): Promise<Row> {
  const q = db
    .select()
    .from(jobDrafts)
    .where(and(eq(jobDrafts.id, id), eq(jobDrafts.ownerId, ownerId), ne(jobDrafts.status, "DRAFTING")));
  const [row] = await (lock ? q.for("update") : q);
  if (!row) throw notFound("Job draft");
  return row;
}

const conflict = (message: string, details?: Record<string, unknown>) =>
  new HttpError(409, "CONFLICT", message, details);

const notBound = () =>
  new HttpError(403, "FORBIDDEN", "This repository isn't bound to this project", { field: "repositoryId" });

const STATUS_TEXT: Record<Row["status"], string> = {
  DRAFTING: "still being drafted",
  READY: "ready",
  NEEDS_REPO: "waiting for you to pick a repository",
  UNSUPPORTED: "not a job NEXUS can run",
  STARTED: "already started",
  DISCARDED: "discarded",
  FAILED: "failed",
};
const notIn = (d: Row, what: string) =>
  conflict(`This job draft is ${STATUS_TEXT[d.status]}; ${what}.`, { status: d.status });

/** The issue client, or 409 explaining how to set GitHub up. */
const need = (w: IssueWriter | null): IssueWriter => w ?? (requireGithub(null) as never);

/** The Developer's profile must allow `tools`; acting (approve) needs at least "Act with approval". */
function assertProfile(p: EffectiveAgentProfile, tools: AgentTool[], act: boolean) {
  for (const tool of tools)
    if (!p.settings.tools.includes(tool))
      throw conflict(
        `The Developer's profile in this project doesn't allow ${tool}. Allow it in Settings → Agent profiles.`,
        { setting: "tools", tool },
      );
  const autonomy = p.settings.autonomy;
  if (autonomy === "SUGGEST" || (act && autonomy === "DRAFT"))
    throw conflict(
      `The Developer's autonomy in this project is ${autonomy}: it can only ${autonomy === "DRAFT" ? "draft" : "suggest"}. Set it to "Act with approval" in Settings → Agent profiles.`,
      { setting: "autonomy" },
    );
}

function assertBudgetFits(p: EffectiveAgentProfile, b: JobDraftBudget) {
  if (b.maxCostUsd > p.settings.maxCostUsdPerTask || b.maxTurns > p.settings.maxTurns)
    throw conflict(
      `The Developer's profile caps a task at ${usd(p.settings.maxCostUsdPerTask)} and ${p.settings.maxTurns} turns. Lower the budget, or raise the caps in Settings → Agent profiles.`,
      { setting: "budget" },
    );
}

/** The Developer's caps and 45 minutes, within the run budget's bounds. */
const defaultBudget = (p: EffectiveAgentProfile): JobDraftBudget =>
  JobDraftBudget.parse({
    maxWallClockMinutes: DEFAULT_MINUTES,
    maxTurns: Math.min(Math.max(p.settings.maxTurns, 1), 200),
    maxCostUsd: Math.min(p.settings.maxCostUsdPerTask, 50),
  });

/** The project's bound repositories NEXUS can still see (names come from the app's installations only). */
async function boundRepos(deps: JobDraftDeps, ownerId: string, projectId: string): Promise<Repo[]> {
  const bound = await boundRepositoryIds(deps.db, ownerId, projectId);
  if (bound.size === 0) return [];
  const { items } = await requireGithub(deps.github).repositories();
  return items.filter((r) => bound.has(r.id)).map((r) => ({ id: r.id, fullName: r.fullName }));
}

async function assertBound(tx: Db | Tx, projectId: string, repositoryId: string) {
  const [bound] = await tx
    .select({ id: projectRepositories.repositoryId })
    .from(projectRepositories)
    .where(
      and(eq(projectRepositories.projectId, projectId), eq(projectRepositories.repositoryId, repositoryId)),
    );
  if (!bound) throw notBound();
}

/**
 * CMD-G01, server-side only: the model's repository counts only when it is one of `known` by full name, or by bare
 * name when exactly one has it; no name and a single bound repository means that one. Anything else is the owner's
 * choice among `known` (the bare-name matches, or all of them). A name outside `known` is never used or echoed.
 */
export function resolveRepository(
  known: Repo[],
  named: string | null,
): { repo: Repo } | { candidates: Repo[] } {
  if (named === null) return known.length === 1 ? { repo: known[0]! } : { candidates: known };
  const want = named.trim().toLowerCase();
  const full = known.find((r) => r.fullName.toLowerCase() === want);
  if (full) return { repo: full };
  if (!want.includes("/")) {
    const bare = known.filter((r) => r.fullName.split("/")[1]!.toLowerCase() === want);
    if (bare.length === 1) return { repo: bare[0]! };
    if (bare.length > 1) return { candidates: bare };
  }
  return { candidates: known };
}

/** The issue NEXUS would create, built by the server from the model's fields: all of them neutralised. */
function newIssueText(id: string, j: Extract<DraftedJob, { kind: "NEW_ISSUE" }>) {
  const content = [
    inertLines(j.summary),
    "",
    "## Acceptance criteria",
    "",
    ...j.acceptanceCriteria.map((c) => `- [ ] ${inert(c)}`),
  ].join("\n");
  return { issueTitle: inertTitle(j.title), issueBody: `${content}${tail(id)}` };
}

/** The owner's edit of the body, neutralised again; the server's own footer and marker are re-appended. */
function editedBody(id: string, body: string): string {
  const lines = stripHtmlComments(body)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== FOOTER);
  const content = inertLines(lines.join("\n"))
    .replace(/(?:\n+-{3,})+$/, "")
    .trim();
  if (!content)
    throw new HttpError(400, "VALIDATION_FAILED", "The issue body can't be empty", { field: "body" });
  const full = `${content}${tail(id)}`;
  if (full.length > BODY_MAX)
    throw new HttpError(
      400,
      "VALIDATION_FAILED",
      `The issue body is too long (at most ${BODY_MAX} characters with NEXUS's footer)`,
      { field: "body" },
    );
  return full;
}

/** What the draft becomes from the model's answer; the repository only ever from `known`. */
function drafted(id: string, job: DraftedJob, known: Repo[], preselected: Repo | null): Partial<Row> {
  if (job.kind === "UNSUPPORTED")
    return { status: "UNSUPPORTED", kind: null, unsupportedReason: inertTitle(job.reason), candidates: [] };
  const r = preselected ? { repo: preselected } : resolveRepository(known, job.repository);
  const where: Partial<Row> =
    "repo" in r
      ? { status: "READY", repositoryId: r.repo.id, repositoryFullName: r.repo.fullName, candidates: [] }
      : { status: "NEEDS_REPO", candidates: r.candidates };
  return job.kind === "EXISTING_ISSUE"
    ? { ...where, kind: "EXISTING_ISSUE", issueNumber: job.issueNumber }
    : { ...where, kind: "NEW_ISSUE", ...newIssueText(id, job) };
}

// ── Create ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One model call drafts the job. The row claims the Idempotency-Key and the call's cap is reserved before it, so a
 * concurrent retry never pays twice and an engaged stop or a spent budget refuses before any call. Invalid output
 * stores nothing; the spend is settled to the measured cost in every outcome.
 */
export async function createJobDraft(
  deps: JobDraftDeps,
  ctx: Ctx,
  body: CreateJobDraftRequest,
  idempotencyKey: string,
): Promise<JobDraft> {
  const { db, config } = deps;
  const scope = await resolveProject(db, ctx.ownerId, body.projectId, { write: true, mode: "DEV" });
  const requestHash = sha256(canonical(body));
  const byKey = and(eq(jobDrafts.ownerId, ctx.ownerId), eq(jobDrafts.idempotencyKey, idempotencyKey));
  const replay = (d: Row | undefined) => {
    if (d && d.requestHash !== requestHash)
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key was already used with a different request",
      );
    if (!d || d.status === "DRAFTING")
      throw conflict("This job is still being drafted. If nothing appears, try again shortly.", {
        reason: "in_progress",
      });
    return toDto(d);
  };
  const staleBefore = new Date(Date.now() - STALE_DRAFTING_MS);
  const [existing] = await db.select().from(jobDrafts).where(byKey);
  const staleId = existing?.status === "DRAFTING" && existing.createdAt < staleBefore ? existing.id : null;
  if (existing && !staleId) return replay(existing);

  const profile = await resolveAgentProfile(db, ctx.ownerId, scope.projectId, AGENT);
  assertProfile(profile, [RUN_TOOL], false);
  const known = await boundRepos(deps, ctx.ownerId, scope.projectId);
  if (known.length === 0)
    throw conflict(
      "Bind a repository to this project first: NEXUS only starts jobs in repositories you bound to it.",
      { field: "repositoryId" },
    );
  const preselected = body.repositoryId ? (known.find((r) => r.id === body.repositoryId) ?? null) : null;
  if (body.repositoryId && !preselected) throw notBound();
  const ai = await loadAi(config.aiFile); // 409 with the runbook path until ai.json exists
  const model = profile.settings.model ?? ai.model;

  const claim = await db.transaction(async (tx) => {
    // A crashed attempt's claim: its reservation stays counted in full (its outcome is unknown).
    if (staleId)
      await tx
        .delete(jobDrafts)
        .where(
          and(
            eq(jobDrafts.id, staleId),
            eq(jobDrafts.status, "DRAFTING"),
            lt(jobDrafts.createdAt, staleBefore),
          ),
        );
    const [row] = await tx
      .insert(jobDrafts)
      .values({
        ownerId: ctx.ownerId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        idempotencyKey,
        requestHash,
        status: "DRAFTING",
        text: body.text,
        budget: defaultBudget(profile),
      })
      .onConflictDoNothing({ target: [jobDrafts.ownerId, jobDrafts.idempotencyKey] })
      .returning();
    if (!row) return null;
    const { spendId } = await reserveAiSpend(tx, {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      source: "JOB_DRAFT",
      sourceId: row.id,
      maxUsd: DRAFT_CAP_USD,
      timezone: config.ownerTimezone,
    });
    return { row, spendId };
  });
  if (!claim) return replay((await db.select().from(jobDrafts).where(byKey))[0]);

  const { row, spendId } = claim;
  const done = (tx: Db | Tx, outcome: "SUCCEEDED" | "FAILED", extra: Record<string, unknown>) =>
    record(
      tx,
      ctx,
      row,
      "job_draft.create",
      { agent: AGENT, profileVersionId: profile.versionId, model, ...extra },
      outcome,
    );
  // Without a response the provider may still have billed the call (a timeout): count the whole cap.
  let cost = DRAFT_CAP_USD;
  try {
    const res = await draftJob(ai, model, {
      request: body.text,
      repositories: known.map((r) => r.fullName),
      preselectedRepository: preselected?.fullName ?? null,
    });
    if ("usage" in res) cost = costUsd(model, res.usage);
    if (!res.ok) {
      const provider = res.outcome === "PROVIDER_ERROR";
      await db.transaction(async (tx) => {
        await tx.delete(jobDrafts).where(eq(jobDrafts.id, row.id)); // nothing was produced: the key may be retried
        await settleAiSpend(tx, spendId, cost);
        await done(tx, "FAILED", { reason: provider ? "provider_error" : "invalid_output", costUsd: cost });
      });
      throw new HttpError(
        provider ? 502 : 422,
        provider ? "INTERNAL" : "VALIDATION_FAILED",
        `${res.message} Nothing was saved; ${provider ? "try again" : "rephrase the job and try again"}.`,
        { reason: provider ? "provider_error" : "invalid_output" },
      );
    }
    const fields = drafted(row.id, res.input.job, known, preselected);
    return await db.transaction(async (tx) => {
      const [d] = await tx
        .update(jobDrafts)
        .set({ ...fields, updatedAt: new Date() })
        .where(and(eq(jobDrafts.id, row.id), eq(jobDrafts.status, "DRAFTING")))
        .returning();
      if (!d) throw conflict("This draft took too long and was restarted. Try again in a moment.");
      await settleAiSpend(tx, spendId, cost);
      await done(tx, "SUCCEEDED", {
        kind: d.kind,
        status: d.status,
        candidates: d.candidates.length,
        costUsd: cost,
      });
      return toDto(d);
    });
  } catch (err) {
    // Anything but a stored draft leaves no claim behind and settles the call (both no-ops if already done).
    await db
      .transaction(async (tx) => {
        await tx.delete(jobDrafts).where(and(eq(jobDrafts.id, row.id), eq(jobDrafts.status, "DRAFTING")));
        await settleAiSpend(tx, spendId, cost);
      })
      .catch(() => undefined);
    throw err;
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** One project's drafts, or every project of the owner; newest first, keyset by id. */
export async function listJobDrafts(db: Db, ownerId: string, q: ListJobDraftsQuery): Promise<JobDraftList> {
  const d = jobDrafts;
  const scope = q.projectId
    ? eq(d.projectId, (await resolveProject(db, ownerId, q.projectId)).projectId)
    : inArray(d.workspaceId, await ownerWorkspaceIds(db, ownerId));
  const rows = await db
    .select()
    .from(d)
    .where(
      and(scope, eq(d.ownerId, ownerId), ne(d.status, "DRAFTING"), q.cursor ? lt(d.id, q.cursor) : undefined),
    )
    .orderBy(desc(d.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return { items: page.map(toDto), nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null };
}

export async function getJobDraft(db: Db, ownerId: string, id: string): Promise<JobDraft> {
  return toDto(await owned(db, ownerId, id));
}

// ── Owner edits ────────────────────────────────────────────────────────────────────────────────────────────────

/** Only while READY or NEEDS_REPO. A bound repository makes it READY; any change drops the preview. */
export async function updateJobDraft(
  deps: JobDraftDeps,
  ctx: Ctx,
  id: string,
  body: UpdateJobDraftRequest,
): Promise<JobDraft> {
  const { db } = deps;
  const before = await owned(db, ctx.ownerId, id);
  const repo = body.repositoryId
    ? ((await boundRepos(deps, ctx.ownerId, before.projectId)).find((r) => r.id === body.repositoryId) ??
      null)
    : null;
  if (body.repositoryId && !repo) throw notBound();
  const profile = body.budget ? await resolveAgentProfile(db, ctx.ownerId, before.projectId, AGENT) : null;
  if (profile && body.budget) assertBudgetFits(profile, body.budget);

  return db.transaction(async (tx) => {
    const d = await owned(tx, ctx.ownerId, id, true);
    await resolveProject(tx, ctx.ownerId, d.projectId, { write: true, mode: "DEV" });
    if (d.status !== "READY" && d.status !== "NEEDS_REPO") throw notIn(d, "it can't be changed");
    if ((body.title !== undefined || body.body !== undefined) && d.kind !== "NEW_ISSUE")
      throw conflict("Only a new issue's title and body can be edited.", { field: "title" });
    if (body.issueNumber !== undefined && d.kind !== "EXISTING_ISSUE")
      throw conflict("Only a run on an existing issue has an issue number.", { field: "issueNumber" });
    if (repo) await assertBound(tx, d.projectId, repo.id); // under the lock: an unbind in between wins
    const title = body.title === undefined ? undefined : reinertTitle(body.title);
    if (title !== undefined && title.length < 3)
      throw new HttpError(400, "VALIDATION_FAILED", "The issue title is too short", { field: "title" });
    const now = new Date();
    const [updated] = await tx
      .update(jobDrafts)
      .set({
        ...(repo
          ? {
              repositoryId: repo.id,
              repositoryFullName: repo.fullName,
              status: "READY" as const,
              candidates: [],
            }
          : {}),
        ...(title === undefined ? {} : { issueTitle: title }),
        ...(body.body === undefined ? {} : { issueBody: editedBody(d.id, body.body) }),
        ...(body.issueNumber === undefined ? {} : { issueNumber: body.issueNumber }),
        ...(body.budget ? { budget: body.budget } : {}),
        previewHash: null,
        preview: null,
        previewRunnerId: null,
        previewExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(jobDrafts.id, d.id))
      .returning();
    await record(tx, ctx, d, "job_draft.update", {
      fields: Object.keys(body).sort(),
      from: d.status,
      status: updated!.status,
      ...(repo ? { repositoryId: repo.id } : {}),
    });
    return toDto(updated!);
  });
}

/** Anything but a started job can be discarded; an issue already created stays on GitHub. */
export async function discardJobDraft(db: Db, ctx: Ctx, id: string): Promise<JobDraft> {
  return db.transaction(async (tx) => {
    const d = await owned(tx, ctx.ownerId, id, true);
    await resolveProject(tx, ctx.ownerId, d.projectId, { write: true });
    if (d.status === "DISCARDED") return toDto(d);
    if (d.status === "STARTED")
      throw conflict("This job already started; cancel the run instead.", { status: d.status });
    if (d.claimedAt && d.claimedAt.getTime() + LEASE_MS > Date.now())
      throw conflict("NEXUS is starting this job right now; wait for it to finish, then discard it.");
    const [updated] = await tx
      .update(jobDrafts)
      .set({
        status: "DISCARDED",
        previewHash: null,
        preview: null,
        previewRunnerId: null,
        previewExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(jobDrafts.id, d.id))
      .returning();
    await record(tx, ctx, d, "job_draft.discard", { from: d.status });
    return toDto(updated!);
  });
}

// ── Preview and approve ────────────────────────────────────────────────────────────────────────────────────────

/** sha256 of the canonical action: the only thing an approval can name. */
const actionHash = (d: Row, runnerId: string | null) =>
  sha256(
    canonical({
      draftId: d.id,
      kind: d.kind,
      repositoryId: d.repositoryId,
      title: d.kind === "NEW_ISSUE" ? d.issueTitle : null,
      body: d.kind === "NEW_ISSUE" ? d.issueBody : null,
      issueNumber: d.kind === "EXISTING_ISSUE" ? d.issueNumber : null,
      budget: d.budget,
      runnerId,
    }),
  );

const canAct = (d: Row) => d.status === "READY" || d.status === "FAILED";

/**
 * "Exactly what will happen", from the stored draft only, valid for PROPOSAL_TTL_MS. A new issue is checked against
 * the app's issue permission, an existing one against GitHub. The latest preview is the only one an approval can use.
 */
export async function previewJobDraft(
  deps: JobDraftDeps,
  ctx: Ctx,
  id: string,
  body: JobDraftPreviewRequest,
): Promise<JobDraftPreview> {
  const { db } = deps;
  const d = await owned(db, ctx.ownerId, id);
  await resolveProject(db, ctx.ownerId, d.projectId, { write: true, mode: "DEV" });
  if (!canAct(d)) throw notIn(d, "only a ready job can be previewed");
  const [runner = null] = body.runnerId
    ? await db
        .select({ id: runners.id, name: runners.name })
        .from(runners)
        .where(
          and(eq(runners.id, body.runnerId), eq(runners.ownerId, ctx.ownerId), isNull(runners.revokedAt)),
        )
    : [];
  if (body.runnerId && !runner)
    throw new HttpError(400, "VALIDATION_FAILED", "Unknown or revoked runner", { field: "runnerId" });
  const newIssue = d.kind === "NEW_ISSUE";
  // GitHub's answer, not ours: the app may create issues there, or the issue exists (and the run could start).
  const { fullName } = newIssue
    ? await need(deps.writer).target(d.repositoryId!)
    : await requireGithub(deps.github).issueSnapshot(d.repositoryId!, d.issueNumber!);

  const hash = actionHash(d, runner?.id ?? null);
  const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS);
  const b = d.budget;
  const preview: JobDraftPreview = {
    draftId: d.id,
    riskTier: newIssue ? "R2" : "R1",
    rows: [
      ...(newIssue
        ? [
            { k: "Creates issue", v: `${d.issueTitle} · in ${fullName}` },
            { k: "Then runs", v: "Developer on that issue" },
          ]
        : [{ k: "Then runs", v: `Developer on #${d.issueNumber} in ${fullName}` }]),
      { k: "On", v: runner?.name ?? "the first free runner" },
      {
        k: "Budget",
        v: `up to ${usd(b.maxCostUsd)} (est.) · ${b.maxTurns} turns · ${b.maxWallClockMinutes} min`,
      },
      { k: "Won't do", v: "push, open a PR or merge without your separate approval" },
    ],
    actionHash: hash,
    expiresAt: expiresAt.toISOString(),
  };
  await db.transaction(async (tx) => {
    const now = await owned(tx, ctx.ownerId, id, true);
    // Changed while GitHub answered: this preview no longer shows what an approval would do.
    if (!canAct(now) || actionHash(now, runner?.id ?? null) !== hash)
      throw conflict("The job changed while it was being previewed; preview it again.");
    await tx
      .update(jobDrafts)
      .set({ previewHash: hash, preview, previewRunnerId: runner?.id ?? null, previewExpiresAt: expiresAt })
      .where(eq(jobDrafts.id, d.id));
    await record(tx, ctx, d, "job_draft.preview", {
      actionHash: hash,
      riskTier: preview.riskTier,
      repositoryId: d.repositoryId,
      runnerId: runner?.id ?? null,
    });
  });
  return preview;
}

type Attempt = { kind: "done"; d: Row } | { kind: "run"; d: Row; issueFirst: boolean; retry: boolean };

/**
 * The owner's click on the exact previewed hash. NEW_ISSUE (R2): the claim is written before GitHub is called; a
 * later attempt first adopts an issue an earlier one already created (found by its marker), so a crash between
 * GitHub's answer and our record never makes a second issue. Then the run, under the fixed key `job-draft:<id>`, so
 * it exists at most once. A failure after the issue exists keeps it (FAILED); approving again resumes.
 * `createdIssue` and `jobId` only ever come from GitHub's response and NEXUS's own job record.
 */
export async function approveJobDraft(
  deps: JobDraftDeps,
  ctx: Ctx,
  id: string,
  body: ApproveJobDraftRequest,
  idempotencyKey: string,
): Promise<JobDraft> {
  const { db } = deps;
  const found = await owned(db, ctx.ownerId, id);
  if (found.status === "STARTED") return toDto(found); // approving twice: the one issue and run
  const profile = await resolveAgentProfile(db, ctx.ownerId, found.projectId, AGENT);
  const needsIssue = found.kind === "NEW_ISSUE" && found.createdIssueNumber === null;
  assertProfile(profile, needsIssue ? [ISSUE_TOOL, RUN_TOOL] : [RUN_TOOL], true);
  assertBudgetFits(profile, found.budget);

  const attempt = await db.transaction(async (tx): Promise<Attempt> => {
    await assertNotStopped(tx);
    const d = await owned(tx, ctx.ownerId, id, true);
    await resolveProject(tx, ctx.ownerId, d.projectId, { write: true, mode: "DEV" });
    if (d.status === "STARTED") return { kind: "done", d };
    if (!canAct(d)) throw notIn(d, "it can't be approved");
    const now = new Date();
    if (d.approveIdempotencyKey === idempotencyKey && d.approveHash !== body.actionHash)
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key was already used to approve another preview",
      );
    if (d.previewHash !== body.actionHash)
      throw conflict("The job changed since it was shown; preview it again.");
    if (!d.previewExpiresAt || d.previewExpiresAt <= now)
      throw conflict("This preview has expired; preview the job again.");
    if (d.claimedAt && d.claimedAt.getTime() + LEASE_MS > now.getTime())
      throw conflict("NEXUS is starting this job right now; it shows here when GitHub answers.");
    await assertBound(tx, d.projectId, d.repositoryId!);
    const issueFirst = d.kind === "NEW_ISSUE" && d.createdIssueNumber === null;
    const [claimed] = await tx
      .update(jobDrafts)
      .set({
        claimedAt: now,
        attempt: issueFirst ? d.attempt + 1 : d.attempt,
        approveIdempotencyKey: idempotencyKey,
        approveHash: body.actionHash,
        updatedAt: now,
      })
      .where(eq(jobDrafts.id, d.id))
      .returning();
    return { kind: "run", d: claimed!, issueFirst, retry: issueFirst && claimed!.attempt > 1 };
  });
  if (attempt.kind === "done") return toDto(attempt.d);

  let d = attempt.d;
  const meta = { actionHash: body.actionHash, profileVersionId: profile.versionId };
  /** FAILED with an owner-safe error; the lease is released and a created issue kept. */
  const fail = async (err: unknown, step: "issue" | "job", set: Partial<Row> = {}) => {
    const message =
      err instanceof HttpError
        ? err.message
        : "Something went wrong while starting the job. Approve again to finish it; NEXUS won't create a second issue or run.";
    await db.transaction(async (tx) => {
      await tx
        .update(jobDrafts)
        .set({ status: "FAILED", error: message, claimedAt: null, updatedAt: new Date(), ...set })
        .where(and(eq(jobDrafts.id, d.id), ne(jobDrafts.status, "STARTED")));
      await record(
        tx,
        ctx,
        d,
        "job_draft.approve",
        {
          ...meta,
          step,
          attempt: set.attempt ?? d.attempt,
          code: err instanceof HttpError ? err.code : "INTERNAL",
        },
        "FAILED",
      );
    });
  };

  if (attempt.issueFirst) {
    let posted = false;
    try {
      const w = need(deps.writer);
      const repo = await w.target(d.repositoryId!);
      const since = new Date(d.createdAt.getTime() - CLOCK_SKEW_MS);
      const adopted = attempt.retry ? await w.find(repo, draftMarker(d.id), since) : null;
      posted = !adopted;
      const issue =
        adopted ?? (await w.create(repo, { title: d.issueTitle!, body: d.issueBody!, labels: [] }));
      d = await db.transaction(async (tx) => {
        // From here on the draft is a run on that issue: a later preview is R1, a retry never creates another.
        const [u] = await tx
          .update(jobDrafts)
          .set({
            createdIssueNumber: issue.number,
            createdIssueUrl: issue.url,
            kind: "EXISTING_ISSUE",
            issueNumber: issue.number,
            updatedAt: new Date(),
          })
          .where(eq(jobDrafts.id, d.id))
          .returning();
        await record(tx, ctx, d, "job_draft.issue_create", {
          repositoryId: d.repositoryId,
          issueNumber: issue.number,
          adopted: adopted !== null,
          attempt: d.attempt,
        });
        return u!;
      });
    } catch (err) {
      // A first attempt that never reached GitHub's create, or that GitHub refused (4xx), made no issue: forget it.
      // Otherwise GitHub may have created it, and the next approve looks for it first.
      const refused = err instanceof HttpError && err.statusCode < 500;
      const release = !attempt.retry && (!posted || refused);
      await fail(err, "issue", release ? { attempt: d.attempt - 1 } : {});
      throw err;
    }
  }

  try {
    const request: Extract<CreateJobRequest, { jobType: "DEV_ISSUE_TO_PR" }> = {
      jobType: "DEV_ISSUE_TO_PR",
      projectId: d.projectId,
      repositoryId: d.repositoryId!,
      issueNumber: d.issueNumber!,
      budget: d.budget,
      ...(d.previewRunnerId ? { runnerId: d.previewRunnerId } : {}),
    };
    // A crash after the job was created left it under the draft's key: adopt it, whatever the runner now.
    const [existing] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.initiatorId, ctx.ownerId), eq(jobs.idempotencyKey, jobKey(d.id))));
    const job =
      existing ??
      (await createJob(db, {
        ownerId: ctx.ownerId,
        idempotencyKey: jobKey(d.id),
        body: request,
        agent: AGENT,
        correlationId: ctx.correlationId,
        timezone: deps.config.ownerTimezone,
        pinIssue: (b) =>
          requireGithub(deps.github).issueSnapshot(b.repositoryId, b.issueNumber, b.baseBranch),
      }));
    return await db.transaction(async (tx) => {
      const [u] = await tx
        .update(jobDrafts)
        .set({ status: "STARTED", jobId: job.id, error: null, claimedAt: null, updatedAt: new Date() })
        .where(eq(jobDrafts.id, d.id))
        .returning();
      await record(tx, ctx, d, "job_draft.approve", {
        ...meta,
        jobId: job.id,
        repositoryId: d.repositoryId,
        issueNumber: d.issueNumber,
        createdIssue: d.createdIssueNumber !== null,
        adoptedJob: existing !== undefined,
      });
      return toDto(u!);
    });
  } catch (err) {
    await fail(err, "job");
    throw err;
  }
}
