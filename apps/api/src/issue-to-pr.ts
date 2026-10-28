import { and, desc, eq, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import {
  APPROVAL_TTL_MS,
  CHANGESET_MAX_BYTES,
  WORK_BRANCH_PREFIX,
  type Approval,
  type ApprovalDecisionRequest,
  type ChangesetFile,
  type IssueSnapshot,
  type ListApprovalsQuery,
  type PushDraftPrAction,
  type UploadChangesetRequest,
  type UploadChangesetResponse,
  type Verification,
} from "@nexus/contracts";
import { audit } from "./audit.ts";
import type { Db, Tx } from "./db/index.ts";
import { approvals, changesets, externalActions, jobs } from "./db/schema.ts";
import { HttpError, invalidTransition, notFound } from "./errors.ts";
import type { GithubCatalog } from "./github/catalog.ts";
import {
  canonical,
  moveJob,
  ownerActor,
  runnerActor,
  sha256,
  writeEvents,
  type JobRow,
  type NewEvent,
} from "./jobs.ts";
import type { RunnerRow } from "./runners.ts";
import { assertNotStopped } from "./system.ts";
import { assertProjectActive } from "./workspaces.ts";

// ENG-07: changeset upload → owner approval of the exact action hash → the API pushes and opens a draft PR.

type ApprovalRow = typeof approvals.$inferSelect;

const PR_TITLE_MAX = 256;
const PR_FILE_LIST_MAX_CHARS = 30_000; // keeps the body well under GitHub's 65 536 limit
const EXECUTOR = "system:executor";
export const pushIdempotencyKey = (jobId: string) => `${jobId}:push_draft_pr`;

// uuidv7's leading hex digits are a timestamp shared by jobs created close together; the tail is random.
export const workBranch = (issueNumber: number, jobId: string) =>
  `${WORK_BRANCH_PREFIX}issue-${issueNumber}-${jobId.replaceAll("-", "").slice(-8)}`;

export const toApprovalDto = (a: ApprovalRow): Approval => ({
  id: a.id,
  jobId: a.jobId,
  projectId: a.projectId,
  riskTier: a.riskTier,
  status: a.status,
  action: a.action,
  actionHash: a.actionHash,
  createdAt: a.createdAt.toISOString(),
  expiresAt: a.expiresAt.toISOString(),
  decidedAt: a.decidedAt?.toISOString() ?? null,
  result: a.result,
  error: a.error,
});

/** Untrusted text inside a fence longer than any backtick run in it: no @mentions, links or closing keywords. */
const fenced = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
};

const SYMBOL = { added: "A", modified: "M", deleted: "D" } as const;

const seconds = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

const TESTS_HEADING: Record<Verification["status"], (v: Verification) => string> = {
  passed: () => "### Tests: passed (run by NEXUS in the sandbox)",
  failed: (v) => `### Tests: FAILED with exit code ${v.exitCode ?? "?"} (run by NEXUS in the sandbox)`,
  error: () => "### Tests: could not run (NEXUS tried in the sandbox)",
  not_configured: () => "### Tests: not verified by NEXUS",
};

/** FR-DEV-05: what NEXUS itself ran, never the agent's claim. Commands and output are repo-controlled: fenced. */
function testsSection(v: Verification): string[] {
  if (v.status === "not_configured")
    return [
      TESTS_HEADING.not_configured(v),
      "No test setup at the base commit: add `.nexus.json` (`verify.test`), or a package.json `test` script with a lockfile.",
    ];
  const source =
    v.source === "nexus.json" ? ".nexus.json at the base commit" : "package.json (auto-detected)";
  const commands = [v.install, v.test].flatMap((argv) => (argv ? [`$ ${argv.join(" ")}`] : []));
  return [
    TESTS_HEADING[v.status](v),
    `Exit code ${v.exitCode ?? "none"} · ${seconds(v.durationMs)} · from ${source}`,
    fenced([...commands, "", v.outputTail.trimEnd() || "(no output)"].join("\n")),
  ];
}

export function buildAction(
  jobId: string,
  s: IssueSnapshot,
  files: ChangesetFile[],
  changeset: Pick<UploadChangesetRequest, "stats" | "agentSummary" | "verification">,
  changesetSha256: string,
): PushDraftPrAction {
  const lines: string[] = [];
  let size = 0;
  for (const f of files) {
    const line = `${SYMBOL[f.change]}  ${f.path}`;
    if (size + line.length > PR_FILE_LIST_MAX_CHARS) {
      lines.push(`… and ${files.length - lines.length} more (see the commit)`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  const { added, removed } = changeset.stats;
  const body = [
    `Refs #${s.issueNumber}`, // a reference only: never auto-closes the issue
    "",
    `### Changes: +${added} −${removed} in ${files.length} file${files.length === 1 ? "" : "s"}`,
    fenced(lines.join("\n")),
    "",
    "### Agent report (unverified)",
    fenced(changeset.agentSummary.trim() || "(no summary)"),
    "",
    ...testsSection(changeset.verification),
    "",
    "Opened by NEXUS — human review required, never auto-merged.",
  ].join("\n");
  return {
    type: "github.push_draft_pr",
    repositoryId: s.repositoryId,
    repositoryFullName: s.fullName,
    issueNumber: s.issueNumber,
    baseBranch: s.baseBranch,
    baseSha: s.baseSha,
    headBranch: workBranch(s.issueNumber, jobId),
    title: `#${s.issueNumber}: ${s.title}`.slice(0, PR_TITLE_MAX),
    body,
    changesetSha256,
    files: files.map((f) => ({ path: f.path, change: f.change })),
    stats: { added, removed },
    verification: changeset.verification,
  };
}

/** Appends events to a job without changing its state. */
async function appendEvents(tx: Tx, job: JobRow, actor: string, events: NewEvent[]) {
  const seq = await writeEvents(tx, job.id, job.lastEventSequence, actor, events);
  await tx.update(jobs).set({ lastEventSequence: seq, updatedAt: new Date() }).where(eq(jobs.id, job.id));
}

// ── Runner: changeset upload ──

/**
 * Stores the runner's changeset, creates the approval for the exact push action and moves the job to
 * AWAITING_APPROVAL, releasing the lease. A retry of the same upload under the same lease returns the same answer.
 */
export async function uploadChangeset(
  db: Db,
  runner: RunnerRow,
  jobId: string,
  body: UploadChangesetRequest,
): Promise<UploadChangesetResponse> {
  const seen = new Set<string>();
  let bytes = 0;
  for (const f of body.files) {
    if (seen.has(f.path))
      throw new HttpError(400, "VALIDATION_FAILED", `Duplicate path in changeset: ${f.path}`);
    seen.add(f.path);
    if (f.change !== "deleted") bytes += Buffer.byteLength(f.contentBase64, "base64");
  }
  if (bytes > CHANGESET_MAX_BYTES)
    throw new HttpError(413, "VALIDATION_FAILED", `Changeset content exceeds ${CHANGESET_MAX_BYTES} bytes`, {
      bytes,
    });
  const files = [...body.files].sort((a, b) => (a.path < b.path ? -1 : 1));
  const changesetSha256 = sha256(canonical({ baseSha: body.baseSha, files }));

  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
    if (!job || job.initiatorId !== runner.ownerId) throw notFound("Job");
    const stale = () =>
      new HttpError(409, "STALE_LEASE", "This runner no longer holds the lease for this job");

    const [prior] = await tx.select().from(changesets).where(eq(changesets.jobId, job.id));
    if (prior) {
      const same =
        prior.runnerId === runner.id &&
        prior.fencingToken === body.fencingToken &&
        prior.sha256 === changesetSha256;
      // The same upload retried under the same lease gets its answer; anything else is a stale writer.
      if (!same) throw stale();
      const [a] = await tx.select().from(approvals).where(eq(approvals.jobId, job.id));
      return { approvalId: a!.id, actionHash: a!.actionHash };
    }

    if (
      job.runnerId !== runner.id ||
      job.fencingToken !== body.fencingToken ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= new Date()
    )
      throw stale();
    if (job.status !== "RUNNING" && job.status !== "VERIFYING")
      throw invalidTransition(job.status, "AWAITING_APPROVAL");
    const snapshot = job.issueSnapshot;
    if (job.jobType !== "DEV_ISSUE_TO_PR" || !snapshot)
      throw new HttpError(400, "VALIDATION_FAILED", "Only DEV_ISSUE_TO_PR jobs take a changeset");
    if (body.baseSha !== snapshot.baseSha)
      throw new HttpError(409, "CONFLICT", "The changeset isn't based on the job's pinned base commit");

    const now = new Date();
    const action = buildAction(job.id, snapshot, files, body, changesetSha256);
    const actionHash = sha256(canonical(action));
    await tx.insert(changesets).values({
      jobId: job.id,
      runnerId: runner.id,
      fencingToken: body.fencingToken,
      baseSha: body.baseSha,
      sha256: changesetSha256,
      files,
      stats: body.stats,
      agentSummary: body.agentSummary,
    });
    const [approval] = await tx
      .insert(approvals)
      .values({
        jobId: job.id,
        projectId: job.projectId,
        riskTier: "R2",
        status: "PENDING",
        action,
        actionHash,
        createdAt: now,
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
      })
      .returning();
    const actor = runnerActor(runner.id);
    await moveJob(
      tx,
      job,
      "AWAITING_APPROVAL",
      actor,
      [
        {
          type: "artifact.created",
          stage: "review",
          payload: {
            artifactType: "changeset",
            changesetSha256,
            baseSha: body.baseSha,
            files: action.files,
            stats: action.stats,
            agentSummary: body.agentSummary, // untrusted agent report; shown labelled as such
          },
        },
        {
          type: "approval.requested",
          stage: "publish",
          payload: { approval: toApprovalDto(approval!) },
        },
      ],
      { leaseExpiresAt: null }, // the runner is done; the reaper ignores AWAITING_APPROVAL
    );
    await audit(tx, {
      actor,
      action: "job.changeset_uploaded",
      resourceType: "job",
      resourceId: job.id,
      correlationId: job.id,
      metadata: { approvalId: approval!.id, actionHash, changesetSha256, files: files.length, bytes },
    });
    return { approvalId: approval!.id, actionHash };
  });
}

// ── Owner: approvals ──

// shortcut: newest 100 only; add a cursor when the inbox can hold more.
export async function listApprovals(db: Db, ownerId: string, q: ListApprovalsQuery): Promise<Approval[]> {
  const rows = await db
    .select({ a: approvals })
    .from(approvals)
    .innerJoin(jobs, eq(jobs.id, approvals.jobId))
    .where(
      and(
        eq(jobs.initiatorId, ownerId),
        q.projectId ? eq(approvals.projectId, q.projectId) : undefined,
        q.status ? eq(approvals.status, q.status) : undefined,
        q.jobId ? eq(approvals.jobId, q.jobId) : undefined,
      ),
    )
    .orderBy(desc(approvals.id))
    .limit(100);
  return rows.map((r) => toApprovalDto(r.a));
}

async function expireTx(tx: Tx, a: ApprovalRow, job: JobRow, actor: string, correlationId: string) {
  await tx.update(approvals).set({ status: "EXPIRED", decidedAt: new Date() }).where(eq(approvals.id, a.id));
  if (job.status === "AWAITING_APPROVAL")
    await moveJob(tx, job, "EXPIRED", actor, [
      { type: "approval.decided", stage: "publish", payload: { approvalId: a.id, decision: "expired" } },
    ]);
  await audit(tx, {
    actor,
    action: "approval.expire",
    resourceType: "approval",
    resourceId: a.id,
    correlationId,
    metadata: { jobId: job.id, actionHash: a.actionHash },
  });
}

/** PENDING approvals past their expiry → EXPIRED, job EXPIRED. Runs with the lease reaper. */
export async function expireApprovals(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(approvals)
      .innerJoin(jobs, eq(jobs.id, approvals.jobId))
      .where(and(eq(approvals.status, "PENDING"), lt(approvals.expiresAt, new Date())))
      .limit(100)
      .for("update", { skipLocked: true });
    for (const r of due) await expireTx(tx, r.approvals, r.jobs, "system:reaper", r.jobs.id);
    return due.length;
  });
}

/**
 * Records the owner's one-time decision on the exact action hash (SEC-G04). Deny completes the job with
 * APPROVAL_DENIED; approve writes the ledger row, then the caller executes. Expired → EXPIRED and 409.
 */
export async function decideApproval(
  db: Db,
  input: { ownerId: string; approvalId: string; body: ApprovalDecisionRequest; correlationId: string },
): Promise<ApprovalRow> {
  const actor = ownerActor(input.ownerId);
  const { decision, actionHash } = input.body;
  const outcome = await db.transaction(async (tx) => {
    if (decision === "approve") await assertNotStopped(tx); // deny executes nothing, so it stays allowed
    const [row] = await tx
      .select()
      .from(approvals)
      .innerJoin(jobs, eq(jobs.id, approvals.jobId))
      .where(and(eq(approvals.id, input.approvalId), eq(jobs.initiatorId, input.ownerId)))
      .for("update");
    if (!row) throw notFound("Approval");
    const { approvals: a, jobs: job } = row;
    await assertProjectActive(tx, a.projectId);
    if (a.status !== "PENDING")
      throw new HttpError(409, "CONFLICT", `This approval is already ${a.status.toLowerCase()}`, {
        status: a.status,
      });
    const now = new Date();
    if (a.expiresAt <= now) {
      await expireTx(tx, a, job, actor, input.correlationId);
      return null;
    }
    if (a.actionHash !== actionHash)
      throw new HttpError(409, "CONFLICT", "The action changed since it was shown; review it again");
    if (job.status !== "AWAITING_APPROVAL") throw invalidTransition(job.status, "COMPLETED");

    const status = decision === "approve" ? "APPROVED" : "DENIED";
    const [decided] = await tx
      .update(approvals)
      .set({ status, decidedAt: now, decidedBy: actor })
      .where(eq(approvals.id, a.id))
      .returning();
    const event: NewEvent = {
      type: "approval.decided",
      stage: "publish",
      payload: { approvalId: a.id, decision, actionHash },
    };
    if (decision === "deny")
      await moveJob(tx, job, "COMPLETED", actor, [event], { outcome: "APPROVAL_DENIED" });
    else {
      // Ledger first, GitHub after commit (PRD §18.4: one ledger record per idempotent action key).
      await tx
        .insert(externalActions)
        .values({
          idempotencyKey: pushIdempotencyKey(job.id),
          jobId: job.id,
          approvalId: a.id,
          provider: "github",
          operation: "push_draft_pr",
          status: "PENDING",
        })
        .onConflictDoNothing({ target: externalActions.idempotencyKey });
      await appendEvents(tx, job, actor, [event]);
    }
    await audit(tx, {
      actor,
      action: `approval.${decision}`,
      resourceType: "approval",
      resourceId: a.id,
      correlationId: input.correlationId,
      outcome: decision === "deny" ? "DENIED" : "SUCCEEDED",
      metadata: { jobId: job.id, actionHash, decision },
    });
    return decided!;
  });
  if (!outcome) throw new HttpError(409, "CONFLICT", "This approval has expired; the run is now EXPIRED");
  return outcome;
}

// ── Execution ──

/**
 * Runs approved push actions. One in-flight execution per approval per process; finishing writes are
 * conditional on the approval still being APPROVED, so a second executor can't overwrite the first.
 * `reconcile` picks up approvals a crashed process left APPROVED (startup path).
 */
export function createExecutor(db: Db, github: GithubCatalog | null, log: FastifyBaseLogger) {
  const inFlight = new Map<string, Promise<Approval>>();

  async function finish(
    approvalId: string,
    result:
      | { ok: true; value: NonNullable<Approval["result"]> & { adopted: boolean } }
      | { ok: false; error: string },
  ): Promise<Approval> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(approvals)
        .innerJoin(jobs, eq(jobs.id, approvals.jobId))
        .where(eq(approvals.id, approvalId))
        .for("update");
      const { approvals: a, jobs: job } = row!;
      if (a.status !== "APPROVED") return toApprovalDto(a);
      const ledger = eq(externalActions.idempotencyKey, pushIdempotencyKey(job.id));
      let done: ApprovalRow | undefined;
      if (result.ok) {
        const { adopted, ...prResult } = result.value;
        await tx
          .update(externalActions)
          .set({
            status: "SUCCEEDED",
            externalId: prResult.pullRequestUrl,
            result: prResult,
            updatedAt: new Date(),
          })
          .where(ledger);
        [done] = await tx
          .update(approvals)
          .set({ status: "EXECUTED", result: prResult })
          .where(eq(approvals.id, a.id))
          .returning();
        await moveJob(
          tx,
          job,
          "COMPLETED",
          EXECUTOR,
          [
            {
              type: "external_action.completed",
              stage: "publish",
              payload: {
                approvalId: a.id,
                provider: "github",
                operation: "push_draft_pr",
                adopted,
                ...prResult,
              },
            },
            { type: "job.completed", stage: "publish", payload: { outcome: "PR_CREATED", ...prResult } },
          ],
          { outcome: "PR_CREATED" },
        );
      } else {
        await tx
          .update(externalActions)
          .set({ status: "FAILED", error: result.error, updatedAt: new Date() })
          .where(ledger);
        [done] = await tx
          .update(approvals)
          .set({ status: "FAILED", error: result.error })
          .where(eq(approvals.id, a.id))
          .returning();
        await moveJob(tx, job, "FAILED", EXECUTOR, [
          {
            type: "job.failed",
            stage: "publish",
            payload: { reason: "GITHUB_PUSH_FAILED", message: result.error },
          },
        ]);
      }
      await audit(tx, {
        actor: EXECUTOR,
        action: "approval.execute",
        resourceType: "approval",
        resourceId: a.id,
        correlationId: job.id,
        outcome: result.ok ? "SUCCEEDED" : "FAILED",
        metadata: result.ok
          ? { jobId: job.id, actionHash: a.actionHash, ...result.value }
          : { jobId: job.id, actionHash: a.actionHash, error: result.error },
      });
      return toApprovalDto(done!);
    });
  }

  async function run(approvalId: string): Promise<Approval> {
    const [row] = await db
      .select()
      .from(approvals)
      .innerJoin(externalActions, eq(externalActions.approvalId, approvals.id))
      .innerJoin(changesets, eq(changesets.jobId, approvals.jobId))
      .where(eq(approvals.id, approvalId));
    if (!row) throw notFound("Approval");
    const { approvals: a, external_actions: ledger, changesets: cs } = row;
    if (a.status !== "APPROVED") return toApprovalDto(a);
    // Done on GitHub but not recorded here (crash between the two): finish from the ledger.
    if (ledger.status === "SUCCEEDED" && ledger.result)
      return finish(a.id, { ok: true, value: { ...ledger.result, adopted: true } });
    if (!github) return finish(a.id, { ok: false, error: "GitHub isn't set up on this NEXUS." });
    try {
      const value = await github.pushDraftPr(a.action, cs.files, ledger.commitSha, async (sha) => {
        await db
          .update(externalActions)
          .set({ commitSha: sha, updatedAt: new Date() })
          .where(eq(externalActions.id, ledger.id));
      });
      return await finish(a.id, { ok: true, value });
    } catch (err) {
      // HttpError messages are written for the owner and carry no secrets; anything else stays in the log.
      if (!(err instanceof HttpError)) log.error({ err, approvalId }, "push draft PR failed");
      const error = err instanceof HttpError ? err.message : "Unexpected error while pushing to GitHub.";
      return finish(a.id, { ok: false, error });
    }
  }

  const execute = (approvalId: string): Promise<Approval> => {
    let p = inFlight.get(approvalId);
    if (!p) {
      p = run(approvalId).finally(() => inFlight.delete(approvalId));
      inFlight.set(approvalId, p);
    }
    return p;
  };

  return {
    execute,
    /** Startup: finish approvals left APPROVED by a crash (DEV-G08: the push adopts what already exists). */
    async reconcile(): Promise<number> {
      const open = await db
        .select({ id: approvals.id })
        .from(approvals)
        .where(eq(approvals.status, "APPROVED"));
      for (const { id } of open) await execute(id);
      return open.length;
    },
  };
}

export type Executor = ReturnType<typeof createExecutor>;
