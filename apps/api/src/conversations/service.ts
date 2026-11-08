import type { FastifyBaseLogger } from "fastify";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  PROPOSAL_TTL_MS,
  TOOL_RISK,
  type ActionProposal,
  type CreateThreadRequest,
  type PostTurnRequest,
  type PostTurnResponse,
  type ProposalDecisionRequest,
  type Thread,
  type ThreadDetail,
  type ThreadList,
  type Turn,
} from "@nexus/contracts";
import { pinnedAgentProfile, resolveAgentProfile } from "../agents/service.ts";
import { loadAi, requestCapUsd } from "../ai.ts";
import { meteredCall, reserveCall } from "../ai-spend.ts";
import type { Deps } from "../app.ts";
import { audit } from "../audit.ts";
import type { Db, Tx } from "../db/index.ts";
import { jobs } from "../db/schema.ts";
import { HttpError, notFound } from "../errors.ts";
import { canonical, createJob, ownerActor, sha256 } from "../jobs.ts";
import { requireGithub } from "../routes/github.ts";
import { ownerWorkspaceIds, resolveProject } from "../workspaces.ts";
import { routeIntent, routeRequest } from "./router.ts";
import { actionProposals, conversationThreads, conversationTurns } from "./schema.ts";
import { answer, type Reply } from "./tools.ts";

type ThreadRow = typeof conversationThreads.$inferSelect;
type TurnRow = typeof conversationTurns.$inferSelect;
type ProposalRow = typeof actionProposals.$inferSelect;

const DEFAULT_TITLE = "New conversation";
const CONTEXT_TURNS = 6;
// shortcut: a thread shows its newest 200 turns; add paging when threads get that long.
const DETAIL_TURNS = 200;
// Older than any live answer (one routing attempt with a 60 s timeout, then NEXUS's own reads): the request that
// stored the owner's message died, so a replay records it as unanswered and the owner sends it again.
const TURN_LEASE_MS = 5 * 60_000;
const UNANSWERED =
  "NEXUS was interrupted before it could answer this message. Nothing was done; send it again.";

const toThreadDto = (t: ThreadRow): Thread => ({
  id: t.id,
  projectId: t.projectId,
  title: t.title,
  subjectJobId: t.subjectJobId,
  profileVersionId: t.profileVersionId,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

const toTurnDto = (t: TurnRow): Turn => ({
  id: t.id,
  threadId: t.threadId,
  role: t.role,
  text: t.text,
  intent: t.intent,
  basis: t.basis,
  sources: t.sources,
  proposalId: t.proposalId,
  correlationId: t.correlationId,
  createdAt: t.createdAt.toISOString(),
});

// A pending proposal past its expiry is reported EXPIRED; the decision endpoint records it.
export const toProposalDto = (p: ProposalRow, now = new Date()): ActionProposal => ({
  id: p.id,
  threadId: p.threadId,
  turnId: p.turnId,
  riskTier: p.riskTier,
  action: p.action,
  actionHash: p.actionHash,
  status: p.status === "AWAITING_APPROVAL" && p.expiresAt <= now ? "EXPIRED" : p.status,
  expiresAt: p.expiresAt.toISOString(),
  decidedAt: p.decidedAt?.toISOString() ?? null,
  result: p.resultJobId
    ? { jobId: p.resultJobId }
    : p.resultDeepDiveId
      ? { deepDiveId: p.resultDeepDiveId }
      : null,
  error: p.error,
  createdAt: p.createdAt.toISOString(),
});

/** A read by id: the owner's thread in one of the owner's workspaces, else 404 (NFR-CNV-05). */
async function getThread(db: Db, ownerId: string, threadId: string): Promise<ThreadRow> {
  const [t] = await db
    .select()
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.id, threadId),
        eq(conversationThreads.ownerId, ownerId),
        inArray(conversationThreads.workspaceId, await ownerWorkspaceIds(db, ownerId)),
      ),
    );
  if (!t) throw notFound("Conversation");
  return t;
}

const auditMeta = (row: { workspaceId: string; projectId: string }, extra: Record<string, unknown>) => ({
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  ...extra,
});

/** One project's threads, or the read-only "All" view across the owner's workspaces when projectId is omitted. */
export async function listThreads(
  db: Db,
  ownerId: string,
  q: { projectId?: string; cursor?: string; limit: number },
): Promise<ThreadList> {
  const rows = await db
    .select()
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.ownerId, ownerId),
        q.projectId
          ? eq(conversationThreads.projectId, (await resolveProject(db, ownerId, q.projectId)).projectId)
          : inArray(conversationThreads.workspaceId, await ownerWorkspaceIds(db, ownerId)),
        q.cursor ? lt(conversationThreads.id, q.cursor) : undefined,
      ),
    )
    .orderBy(desc(conversationThreads.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return { items: page.map(toThreadDto), nextCursor: rows.length > q.limit ? page.at(-1)!.id : null };
}

export async function createThread(
  db: Db,
  input: { ownerId: string; body: CreateThreadRequest; correlationId: string },
): Promise<Thread> {
  const { subjectJobId } = input.body;
  // FR-WKS-05: the thread keeps the Chief of Staff version effective now, even after the profile changes.
  const { versionId } = await resolveAgentProfile(db, input.ownerId, input.body.projectId, "CHIEF_OF_STAFF");
  return db.transaction(async (tx) => {
    const scope = await resolveProject(tx, input.ownerId, input.body.projectId, { write: true });
    if (subjectJobId) {
      // The subject must be a run of this project: a thread never reaches into another one.
      const [job] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, subjectJobId),
            eq(jobs.initiatorId, input.ownerId),
            eq(jobs.projectId, scope.projectId),
          ),
        );
      if (!job)
        throw new HttpError(400, "VALIDATION_FAILED", "Unknown run in this project", {
          field: "subjectJobId",
        });
    }
    const [thread] = await tx
      .insert(conversationThreads)
      .values({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        ownerId: input.ownerId,
        title: input.body.title ?? DEFAULT_TITLE,
        subjectJobId: subjectJobId ?? null,
        profileVersionId: versionId,
      })
      .returning();
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: "conversation.create",
      resourceType: "conversation",
      resourceId: thread!.id,
      correlationId: input.correlationId,
      metadata: auditMeta(scope, { subjectJobId: subjectJobId ?? null, profileVersionId: versionId }),
    });
    return toThreadDto(thread!);
  });
}

export async function getThreadDetail(db: Db, ownerId: string, threadId: string): Promise<ThreadDetail> {
  const thread = await getThread(db, ownerId, threadId);
  const [turns, proposals] = await Promise.all([
    db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.threadId, thread.id))
      .orderBy(desc(conversationTurns.id))
      .limit(DETAIL_TURNS),
    db
      .select()
      .from(actionProposals)
      .where(eq(actionProposals.threadId, thread.id))
      .orderBy(asc(actionProposals.id)),
  ]);
  const now = new Date();
  return {
    thread: toThreadDto(thread),
    turns: turns.reverse().map(toTurnDto),
    proposals: proposals.map((p) => toProposalDto(p, now)),
  };
}

/**
 * FR-CWV-01/05: stores the owner's message, routes it (one metered model call), answers from NEXUS's own records and
 * stores the reply, plus a proposal when the intent is an action. Replaying the Idempotency-Key returns the stored
 * turns without calling the model again; a message left unanswered past TURN_LEASE_MS gets a failed reply instead.
 */
export async function postTurn(
  deps: Deps,
  input: {
    ownerId: string;
    threadId: string;
    idempotencyKey: string;
    body: PostTurnRequest;
    correlationId: string;
    /** For errors that aren't the owner's to read (they get a generic failed reply). */
    log?: FastifyBaseLogger;
  },
): Promise<PostTurnResponse> {
  const { db } = deps;
  const thread = await getThread(db, input.ownerId, input.threadId);
  // An archived project's threads are read-only (409), checked before anything is stored or the model is called.
  await resolveProject(db, input.ownerId, thread.projectId, { write: true });
  const scope = { workspaceId: thread.workspaceId, projectId: thread.projectId };
  const requestHash = sha256(canonical(input.body));
  const byKey = and(
    eq(conversationTurns.threadId, thread.id),
    eq(conversationTurns.idempotencyKey, input.idempotencyKey),
  );

  // A reply that never comes (the request died mid-answer) is recorded as failed, once: the unique reply_to index
  // keeps the first reply, so a late normal answer and a replay can't both land.
  const failReply = async (user: TurnRow, text: string, reason: string): Promise<TurnRow> => {
    const stored = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(conversationTurns)
        .values({
          ...scope,
          threadId: thread.id,
          role: "ASSISTANT",
          text,
          intent: null,
          basis: "NONE",
          sources: [],
          replyTo: user.id,
          correlationId: input.correlationId,
        })
        .onConflictDoNothing()
        .returning();
      if (row)
        await audit(tx, {
          actor: ownerActor(input.ownerId),
          action: "conversation.turn",
          resourceType: "conversation",
          resourceId: thread.id,
          correlationId: input.correlationId,
          outcome: "FAILED",
          metadata: auditMeta(scope, { userTurnId: user.id, assistantTurnId: row.id, reason }),
        });
      return row;
    });
    if (stored) return stored;
    const [reply] = await db.select().from(conversationTurns).where(eq(conversationTurns.replyTo, user.id));
    return reply!;
  };

  const replay = async (user: TurnRow): Promise<PostTurnResponse> => {
    if (user.requestHash !== requestHash)
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key was already used with a different message",
      );
    let [reply] = await db.select().from(conversationTurns).where(eq(conversationTurns.replyTo, user.id));
    if (!reply) {
      if (user.createdAt.getTime() > Date.now() - TURN_LEASE_MS)
        throw new HttpError(
          409,
          "CONFLICT",
          "This message is still being answered. If no answer appears, send it again.",
        );
      // Past the lease nothing is answering it any more; its reservation stays counted in full (outcome unknown).
      reply = await failReply(user, UNANSWERED, "interrupted");
    }
    const [proposal] = reply.proposalId
      ? await db.select().from(actionProposals).where(eq(actionProposals.id, reply.proposalId))
      : [];
    return {
      userTurn: toTurnDto(user),
      assistantTurn: toTurnDto(reply),
      proposal: proposal ? toProposalDto(proposal) : null,
    };
  };

  const [existing] = await db.select().from(conversationTurns).where(byKey);
  if (existing) return replay(existing);

  const ai = await loadAi(deps.config.aiFile); // 409 with the runbook path until ai.json exists
  const profile = await pinnedAgentProfile(db, "CHIEF_OF_STAFF", thread.profileVersionId);
  const model = profile.settings.model ?? ai.model;
  const recent = await db
    .select({ role: conversationTurns.role, text: conversationTurns.text })
    .from(conversationTurns)
    .where(eq(conversationTurns.threadId, thread.id))
    .orderBy(desc(conversationTurns.id))
    .limit(CONTEXT_TURNS);
  const [subject] = thread.subjectJobId
    ? await db
        .select({ jobId: jobs.id, jobType: jobs.jobType, status: jobs.status, request: jobs.request })
        .from(jobs)
        .where(eq(jobs.id, thread.subjectJobId))
    : [];
  const routeCtx = { text: input.body.text, subject: subject ?? null, recentTurns: recent.reverse() };

  // The owner's turn claims the key and the routing call's cap is reserved with it (emergency stop and budget 409s
  // store nothing), so a retry never pays twice.
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(conversationTurns)
      .values({
        ...scope,
        threadId: thread.id,
        role: "USER",
        text: input.body.text,
        intent: null,
        basis: "NONE",
        sources: [],
        idempotencyKey: input.idempotencyKey,
        requestHash,
        correlationId: input.correlationId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return null;
    if (thread.title === DEFAULT_TITLE)
      await tx
        .update(conversationThreads)
        .set({ title: input.body.text.replace(/\s+/g, " ").slice(0, 80) })
        .where(eq(conversationThreads.id, thread.id));
    const spend = await reserveCall(tx, {
      ...scope,
      source: "TALK",
      sourceId: row.id,
      model,
      maxUsd: requestCapUsd(routeRequest(model, routeCtx)),
      timezone: deps.config.ownerTimezone,
    });
    return { user: row, spend };
  });
  if (!claimed) {
    // A concurrent request with the same key won the insert.
    const [raced] = await db.select().from(conversationTurns).where(byKey);
    return replay(raced!);
  }
  const { user, spend } = claimed;

  let reply: Omit<Reply, "intent"> & { intent: Reply["intent"] | null };
  let costUsd: number;
  try {
    const metered = await meteredCall(db, spend, () =>
      routeIntent({ ...ai, model }, routeCtx, { signal: deps.shutdown }),
    );
    costUsd = metered.costUsd;
    const routed = metered.res;
    reply =
      "providerError" in routed
        ? { intent: null, text: `${routed.providerError} Nothing was done.`, basis: "NONE", sources: [] }
        : await answer(routed.intent, {
            db,
            github: deps.github,
            ownerId: input.ownerId,
            projectId: thread.projectId,
            subjectJobId: thread.subjectJobId,
            connectorsDir: deps.config.connectorsDir,
            correlationId: input.correlationId,
          });
  } catch (err) {
    // The message never stays unanswered: HttpError text is written for the owner; anything else stays in the log.
    const owned = err instanceof HttpError;
    if (!owned) input.log?.error({ err, threadId: thread.id, userTurnId: user.id }, "talk turn failed");
    const failed = await failReply(
      user,
      owned
        ? `NEXUS couldn't answer this: ${err.message} Nothing was done.`
        : "Something went wrong while NEXUS was answering. Nothing was done; send it again.",
      owned ? err.code : "internal_error",
    );
    return { userTurn: toTurnDto(user), assistantTurn: toTurnDto(failed), proposal: null };
  }

  const stored = await db.transaction(async (tx) => {
    const proposalId = reply.proposal
      ? (await tx.execute<{ id: string }>(sql`select uuidv7() as id`)).rows[0]!.id
      : null;
    const [assistant] = await tx
      .insert(conversationTurns)
      .values({
        ...scope,
        threadId: thread.id,
        role: "ASSISTANT",
        text: reply.text,
        intent: reply.intent,
        basis: reply.basis,
        sources: reply.sources,
        proposalId,
        replyTo: user.id,
        correlationId: input.correlationId,
      })
      .onConflictDoNothing()
      .returning();
    if (!assistant) return null; // already recorded as unanswered (past its lease): that reply stands
    let proposal: ProposalRow | undefined;
    if (reply.proposal && proposalId) {
      const now = new Date();
      [proposal] = await tx
        .insert(actionProposals)
        .values({
          id: proposalId,
          ...scope,
          threadId: thread.id,
          turnId: assistant.id,
          // A sandboxed job (its push is a separate R2 approval) or a deep dive (spends budget, writes nothing outside
          // NEXUS): both R1.
          riskTier: reply.proposal.type === "research.deep_dive" ? TOOL_RISK["research.deep_dive"] : "R1",
          action: reply.proposal,
          actionHash: sha256(canonical(reply.proposal)),
          status: "AWAITING_APPROVAL",
          createdAt: now,
          expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
        })
        .returning();
      await audit(tx, {
        actor: "system:conversations",
        action: "action_proposal.propose",
        resourceType: "action_proposal",
        resourceId: proposalId,
        correlationId: input.correlationId,
        metadata: auditMeta(scope, {
          threadId: thread.id,
          actionHash: proposal!.actionHash,
          actionType: reply.proposal.type,
        }),
      });
    }
    await tx
      .update(conversationThreads)
      .set({ updatedAt: new Date(), ...(reply.subjectJobId ? { subjectJobId: reply.subjectJobId } : {}) })
      .where(eq(conversationThreads.id, thread.id));
    await audit(tx, {
      actor: ownerActor(input.ownerId),
      action: "conversation.turn",
      resourceType: "conversation",
      resourceId: thread.id,
      correlationId: input.correlationId,
      metadata: auditMeta(scope, {
        userTurnId: user.id,
        assistantTurnId: assistant.id,
        intent: reply.intent?.kind ?? null,
        basis: reply.basis,
        proposalId,
        subjectJobId: reply.subjectJobId ?? null,
        profileVersionId: thread.profileVersionId,
        model,
        costUsd,
      }),
    });
    return {
      userTurn: toTurnDto(user),
      assistantTurn: toTurnDto(assistant),
      proposal: proposal ? toProposalDto(proposal) : null,
    };
  });
  return stored ?? replay(user);
}

/**
 * FR-CXR-05: the owner's authenticated decision on the exact action hash is the only approval. Approve creates the
 * job or deep dive through its normal path with idempotency key `proposal:<id>`, so a retried or doubled approve
 * creates it once.
 */
export async function decideProposal(
  deps: Pick<Deps, "db" | "config" | "github" | "deepDives">,
  input: { ownerId: string; proposalId: string; body: ProposalDecisionRequest; correlationId: string },
): Promise<ActionProposal> {
  const { db } = deps;
  const actor = ownerActor(input.ownerId);
  const { decision, actionHash } = input.body;
  const record = (
    tx: Tx,
    p: ProposalRow,
    action: string,
    outcome: "SUCCEEDED" | "DENIED" | "FAILED",
    extra = {},
  ) =>
    audit(tx, {
      actor,
      action,
      resourceType: "action_proposal",
      resourceId: p.id,
      correlationId: input.correlationId,
      outcome,
      metadata: auditMeta(p, { threadId: p.threadId, actionHash: p.actionHash, decision, ...extra }),
    });

  const decided = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ p: actionProposals })
      .from(actionProposals)
      .innerJoin(conversationThreads, eq(conversationThreads.id, actionProposals.threadId))
      .where(and(eq(actionProposals.id, input.proposalId), eq(conversationThreads.ownerId, input.ownerId)))
      .for("update", { of: actionProposals });
    if (!row) throw notFound("Proposal");
    const p = row.p;
    // 404 outside the owner's projects, 409 once archived; share-locked so an archive waits for this decision.
    await resolveProject(tx, input.ownerId, p.projectId, { write: true });
    // A retried approve of an approved proposal re-runs the idempotent job creation (crash between the two).
    const retry = decision === "approve" && (p.status === "APPROVED" || p.status === "EXECUTED");
    if (!retry && p.status !== "AWAITING_APPROVAL")
      throw new HttpError(409, "CONFLICT", `This proposal is already ${p.status.toLowerCase()}`, {
        status: p.status,
      });
    const now = new Date();
    if (!retry && p.expiresAt <= now) {
      const [expired] = await tx
        .update(actionProposals)
        .set({ status: "EXPIRED", decidedAt: now })
        .where(eq(actionProposals.id, p.id))
        .returning();
      await record(tx, p, "action_proposal.expire", "DENIED");
      return expired!;
    }
    if (p.actionHash !== actionHash)
      throw new HttpError(409, "CONFLICT", "The action changed since it was shown; review it again");
    if (retry) return p;
    const [updated] = await tx
      .update(actionProposals)
      .set({ status: decision === "approve" ? "APPROVED" : "DENIED", decidedAt: now, decidedBy: actor })
      .where(eq(actionProposals.id, p.id))
      .returning();
    await record(tx, p, `action_proposal.${decision}`, decision === "approve" ? "SUCCEEDED" : "DENIED");
    return updated!;
  });
  if (decided.status === "EXPIRED")
    throw new HttpError(409, "CONFLICT", "This proposal has expired. Ask again to get a fresh one.");
  if (decided.status !== "APPROVED") return toProposalDto(decided);

  let finished: ProposalRow;
  try {
    const action = decided.action;
    const key = `proposal:${decided.id}`;
    // The created record is the only result (truth hierarchy); both paths are idempotent per key.
    const result =
      action.type === "jobs.create"
        ? {
            resultJobId: (
              await createJob(db, {
                ownerId: input.ownerId,
                idempotencyKey: key,
                body: action.request,
                correlationId: input.correlationId,
                timezone: deps.config.ownerTimezone,
                pinIssue: (b) =>
                  requireGithub(deps.github).issueSnapshot(b.repositoryId, b.issueNumber, b.baseBranch),
              })
            ).id,
          }
        : {
            resultDeepDiveId: (
              await deps.deepDives.create(
                { ownerId: input.ownerId, actor, correlationId: input.correlationId },
                action.request,
                key,
              )
            ).deepDive.id,
          };
    finished = await db.transaction(async (tx) => {
      const [done] = await tx
        .update(actionProposals)
        .set({ status: "EXECUTED", ...result })
        .where(and(eq(actionProposals.id, decided.id), eq(actionProposals.status, "APPROVED")))
        .returning();
      if (!done) {
        // A concurrent approve finished it first; both point at the same job or dive.
        const [current] = await tx.select().from(actionProposals).where(eq(actionProposals.id, decided.id));
        return current!;
      }
      // The thread is now about the job that really exists; a deep dive isn't a run, so the subject stays.
      if ("resultJobId" in result)
        await tx
          .update(conversationThreads)
          .set({ subjectJobId: result.resultJobId, updatedAt: new Date() })
          .where(eq(conversationThreads.id, decided.threadId));
      await record(
        tx,
        decided,
        "action_proposal.execute",
        "SUCCEEDED",
        "resultJobId" in result ? { jobId: result.resultJobId } : { deepDiveId: result.resultDeepDiveId },
      );
      return done;
    });
  } catch (err) {
    // Unexpected errors leave it APPROVED, so approving again retries the same idempotent job creation.
    if (!(err instanceof HttpError)) throw err;
    finished = await db.transaction(async (tx) => {
      const [failed] = await tx
        .update(actionProposals)
        .set({ status: "FAILED", error: err.message })
        .where(and(eq(actionProposals.id, decided.id), eq(actionProposals.status, "APPROVED")))
        .returning();
      if (failed) await record(tx, decided, "action_proposal.execute", "FAILED", { code: err.code });
      return (
        failed ?? (await tx.select().from(actionProposals).where(eq(actionProposals.id, decided.id)))[0]!
      );
    });
  }
  return toProposalDto(finished);
}
