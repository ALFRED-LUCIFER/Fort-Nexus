import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  Claim,
  OpportunityDraft,
  PROPOSAL_TTL_MS,
  type AgentKey,
  type ClaimLabel,
  type CreateOpportunityIssueRequest,
  type DeepDiveReport,
  type IssuePreview,
  type IssuePreviewRequest,
  type Opportunity,
  type OpportunityKind,
  type OpportunityList,
  type OpportunityListQuery,
} from "@nexus/contracts";
import { resolveAgentProfile } from "../../agents/service.ts";
import { audit } from "../../audit.ts";
import type { Db, Tx } from "../../db/index.ts";
import { projectRepositories } from "../../db/schema.ts";
import { HttpError, notFound } from "../../errors.ts";
import { inert, inertTitle } from "../../github/issue-text.ts";
import type { IssueDraft, IssueWriter } from "../../github/issues.ts";
import { canonical, sha256 } from "../../jobs.ts";
import { requireGithub } from "../../routes/github.ts";
import { assertNotStopped } from "../../system.ts";
import { ownerWorkspaceIds, resolveProject } from "../../workspaces.ts";
import type { Ctx } from "../service.ts";
import { opportunityIssuePreviews, opportunityIssueRequests, researchOpportunities } from "./schema.ts";

// FR-RES-10 / FR-CXR-09 (docs/specs/p1-wave-5-researcher.md, module C): the researcher's ranked opportunities and the
// one external write they can lead to, a GitHub issue the owner approves by its exact, server-built preview (R2).

type Row = typeof researchOpportunities.$inferSelect;
type RequestRow = typeof opportunityIssueRequests.$inferSelect;

const RESEARCHER = "system:ai-researcher";
const TOOL = "github.issues.create";
const BODY_MAX = 20_000;
// An attempt's GitHub calls end well inside this (issues.ts gives each call 20 s); a crashed one lapses.
const LEASE_MS = 5 * 60_000;
// The marker search starts this long before the claim, so clock skew with GitHub can't hide an issue.
const CLOCK_SKEW_MS = 10 * 60_000;

/** Who acts on an approved issue, next to the researcher who noticed it. */
const ACTOR_BY_KIND: Record<OpportunityKind, AgentKey> = {
  OPPORTUNITY: "PRODUCT",
  RISK: "DEVOPS",
  OPTIMIZE: "DEVELOPER",
};
const KIND_TEXT: Record<OpportunityKind, string> = {
  OPPORTUNITY: "Opportunity",
  RISK: "Risk",
  OPTIMIZE: "Optimize",
};
const LABEL_TEXT: Record<ClaimLabel, string> = {
  PRIMARY: "Primary source",
  CORROBORATED: "Corroborated",
  CONTESTED: "Contested",
  UNVERIFIED: "Unverified",
};

const isVerified = (c: Claim) => c.evidence.some((e) => e.verified);

const toDto = (o: Row): Opportunity => ({
  id: o.id,
  projectId: o.projectId,
  deepDiveId: o.deepDiveId,
  kind: o.kind,
  title: o.title,
  problem: o.problem,
  targetUsers: o.targetUsers,
  impactEstimate: o.impactEstimate,
  confidence: o.confidence,
  evidence: o.evidence,
  validationSteps: o.validationSteps,
  agents: o.agents,
  status: o.status,
  issue: o.issue ?? null,
  createdAt: o.createdAt.toISOString(),
  updatedAt: o.updatedAt.toISOString(),
});

const record = (
  tx: Db | Tx,
  who: { actor: string; correlationId: string },
  o: Pick<Row, "id" | "workspaceId" | "projectId">,
  action: string,
  metadata: Record<string, unknown>,
  outcome?: "SUCCEEDED" | "DENIED" | "FAILED",
) =>
  audit(tx, {
    actor: who.actor,
    action,
    resourceType: "research_opportunity",
    resourceId: o.id,
    correlationId: who.correlationId,
    outcome,
    metadata: { workspaceId: o.workspaceId, projectId: o.projectId, ...metadata },
  });

/**
 * Called by the deep-dive engine in the transaction that completes a dive. Copies the claims the draft rests on
 * (immutable from here on) and returns the opportunity id; null when the report proposes none or none of its
 * claims has a quote NEXUS verified on a page it fetched. One opportunity per dive: a repeat returns the same id.
 */
export async function recordOpportunity(
  tx: Tx,
  dive: { id: string; workspaceId: string; projectId: string },
  report: DeepDiveReport,
): Promise<string | null> {
  const draft = OpportunityDraft.safeParse(report.opportunity);
  if (!report.opportunity || !draft.success) return null;
  const byId = new Map(report.claims.map((c) => [c.id, c]));
  const claims = Claim.array().safeParse(
    [...new Set(draft.data.claimIds)].flatMap((id) => byId.get(id) ?? []),
  );
  if (!claims.success) return null;
  const verifiedClaims = claims.data.filter(isVerified).length;
  if (verifiedClaims === 0) return null;
  const d = draft.data;
  const [row] = await tx
    .insert(researchOpportunities)
    .values({
      workspaceId: dive.workspaceId,
      projectId: dive.projectId,
      deepDiveId: dive.id,
      kind: d.kind,
      title: d.title,
      problem: d.problem,
      targetUsers: d.targetUsers,
      impactEstimate: d.impactEstimate,
      confidence: d.confidence,
      evidence: claims.data,
      verifiedClaims,
      validationSteps: d.validationSteps,
      agents: ["AI_RESEARCHER", ACTOR_BY_KIND[d.kind]],
    })
    .onConflictDoNothing({ target: researchOpportunities.deepDiveId })
    .returning();
  if (!row) {
    const [existing] = await tx
      .select({ id: researchOpportunities.id })
      .from(researchOpportunities)
      .where(eq(researchOpportunities.deepDiveId, dive.id));
    return existing!.id;
  }
  await record(tx, { actor: RESEARCHER, correlationId: dive.id }, row, "research_opportunity.record", {
    deepDiveId: dive.id,
    kind: d.kind,
    confidence: d.confidence,
    claims: claims.data.length,
    verifiedClaims,
  });
  return row.id;
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────────

const RANK = sql`case ${researchOpportunities.confidence} when 'HIGH' then 3 when 'MEDIUM' then 2 else 1 end`;

/** One project's opportunities, or the read-only "All" view: confidence, then verified evidence, then newest. */
export async function listOpportunities(
  db: Db,
  ownerId: string,
  q: OpportunityListQuery,
): Promise<OpportunityList> {
  const o = researchOpportunities;
  const scope = q.projectId
    ? eq(o.projectId, (await resolveProject(db, ownerId, q.projectId)).projectId)
    : inArray(o.workspaceId, await ownerWorkspaceIds(db, ownerId));
  const rows = await db
    .select()
    .from(o)
    .where(and(scope, q.status ? eq(o.status, q.status) : undefined))
    .orderBy(desc(RANK), desc(o.verifiedClaims), desc(o.id))
    .limit(q.limit);
  return { items: rows.map(toDto) };
}

/** By id: only inside the owner's workspaces; anything else doesn't exist for this caller. */
async function owned(db: Db | Tx, ownerId: string, id: string, lock = false): Promise<Row> {
  const q = db
    .select()
    .from(researchOpportunities)
    .where(
      and(
        eq(researchOpportunities.id, id),
        inArray(researchOpportunities.workspaceId, await ownerWorkspaceIds(db, ownerId)),
      ),
    );
  const [row] = await (lock ? q.for("update") : q);
  if (!row) throw notFound("Opportunity");
  return row;
}

export async function getOpportunity(db: Db, ownerId: string, id: string): Promise<Opportunity> {
  return toDto(await owned(db, ownerId, id));
}

export async function dismissOpportunity(db: Db, ctx: Ctx, id: string): Promise<Opportunity> {
  return db.transaction(async (tx) => {
    const o = await owned(tx, ctx.ownerId, id, true);
    await resolveProject(tx, ctx.ownerId, o.projectId, { write: true }); // archived → 409
    if (o.status === "DISMISSED") return toDto(o);
    if (o.status === "ISSUE_CREATED")
      throw new HttpError(
        409,
        "CONFLICT",
        "An issue was already created for this; close it on GitHub instead.",
      );
    const [claim] = await tx
      .select({ id: opportunityIssueRequests.id })
      .from(opportunityIssueRequests)
      .where(eq(opportunityIssueRequests.opportunityId, o.id));
    if (claim)
      throw new HttpError(
        409,
        "CONFLICT",
        "You approved an issue for this; approve it again to finish it before dismissing.",
      );
    const [updated] = await tx
      .update(researchOpportunities)
      .set({ status: "DISMISSED", updatedAt: new Date() })
      .where(eq(researchOpportunities.id, o.id))
      .returning();
    await record(tx, ctx, o, "research_opportunity.dismiss", {});
    return toDto(updated!);
  });
}

// ── The issue (FR-CXR-09) ──────────────────────────────────────────────────────────────────────────────────────

/** An evidence URL as a Markdown link target: https only, no credentials, nothing that ends the link early. */
function linkTarget(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  return u.href.replace(/[()<> ]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export const issueMarker = (opportunityId: string) => `<!-- nexus:opportunity:${opportunityId} -->`;

/**
 * The issue NEXUS would create, built by the server from the stored opportunity only: the problem, its verified
 * evidence with source links (the only links in it), validation steps, an AI-inference footer and the hidden marker
 * that lets a retry find it again.
 */
export function issueDraft(o: Row): IssueDraft {
  const head = [
    "## Problem",
    "",
    inert(o.problem),
    "",
    `- **Kind:** ${KIND_TEXT[o.kind]}`,
    `- **Who it affects:** ${inert(o.targetUsers)}`,
    `- **Impact (est.):** ${inert(o.impactEstimate)}`,
    `- **Confidence:** ${o.confidence.toLowerCase()} (a triage label, not a probability)`,
    "",
    "## Evidence (quotes NEXUS found on the pages it read)",
    "",
  ].join("\n");
  const steps = o.validationSteps.length
    ? ["", "## Validation steps", "", ...o.validationSteps.map((s) => `- [ ] ${inert(s)}`)].join("\n")
    : "";
  const tail = [
    steps,
    "",
    "---",
    "",
    `_Drafted by the NEXUS AI researcher from deep dive ${o.deepDiveId}. AI inference; review before acting._`,
    "",
    issueMarker(o.id),
  ].join("\n");

  const blocks = o.evidence.filter(isVerified).map((c, i) => {
    const quotes = c.evidence.flatMap((e) => {
      const href = e.verified ? linkTarget(e.url) : null;
      return href ? [`   > “${inert(e.quote)}”`, `   > — [${inert(e.publisher)}](${href})`] : [];
    });
    const basis = c.basis === "INFERRED" ? " (the researcher's inference)" : "";
    return [`${i + 1}. **${LABEL_TEXT[c.label]}**${basis} · ${inert(c.text)}`, ...quotes].join("\n");
  });
  // Evidence that doesn't fit GitHub's (and the contract's) body limit is cut whole, and the cut is said.
  const budget = BODY_MAX - head.length - tail.length - 120;
  const kept: string[] = [];
  let used = 0;
  for (const b of blocks) {
    if (used + b.length + 1 > budget) break;
    kept.push(b);
    used += b.length + 1;
  }
  const more = blocks.length - kept.length;
  const evidence = [
    ...kept,
    ...(more ? [`\n…and ${more} more verified ${more === 1 ? "claim" : "claims"} in NEXUS.`] : []),
  ].join("\n");
  return { title: inertTitle(o.title), body: `${head}${evidence}\n${tail}`, labels: [] };
}

const actionHash = (opportunityId: string, repositoryId: string, d: IssueDraft) =>
  sha256(canonical({ opportunityId, repositoryId, title: d.title, body: d.body, labels: d.labels }));

/** The issue client, or 409 explaining how to set GitHub up. */
const need = (w: IssueWriter | null): IssueWriter => w ?? (requireGithub(null) as never);

const notOpen = (o: Row) =>
  new HttpError(
    409,
    "CONFLICT",
    o.status === "DISMISSED"
      ? "This opportunity was dismissed."
      : "An issue was already created for this opportunity.",
    { status: o.status },
  );

/** The repository must be bound to the opportunity's project (never another project's binding). */
async function assertBound(tx: Db | Tx, projectId: string, repositoryId: string) {
  const [bound] = await tx
    .select({ id: projectRepositories.repositoryId })
    .from(projectRepositories)
    .where(
      and(eq(projectRepositories.projectId, projectId), eq(projectRepositories.repositoryId, repositoryId)),
    );
  if (!bound)
    throw new HttpError(403, "FORBIDDEN", "This repository isn't bound to this project", {
      field: "repositoryId",
    });
}

/**
 * "Exactly what will happen": the issue text, the repository and the hash the approval must name. Valid for
 * PROPOSAL_TTL_MS; previewing again refreshes it (the same opportunity and repository give the same hash).
 */
export async function previewIssue(
  db: Db,
  writer: IssueWriter | null,
  ctx: Ctx,
  id: string,
  body: IssuePreviewRequest,
): Promise<IssuePreview> {
  const o = await owned(db, ctx.ownerId, id);
  await resolveProject(db, ctx.ownerId, o.projectId, { write: true, mode: "DEV" });
  if (o.status !== "OPEN") throw notOpen(o);
  await assertBound(db, o.projectId, body.repositoryId);
  const repo = await need(writer).target(body.repositoryId);
  const draft = issueDraft(o);
  const hash = actionHash(o.id, repo.id, draft);
  const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS);
  await db.transaction(async (tx) => {
    await tx
      .insert(opportunityIssuePreviews)
      .values({
        workspaceId: o.workspaceId,
        projectId: o.projectId,
        opportunityId: o.id,
        repositoryId: repo.id,
        repositoryFullName: repo.fullName,
        ...draft,
        actionHash: hash,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [opportunityIssuePreviews.opportunityId, opportunityIssuePreviews.actionHash],
        set: { expiresAt, repositoryFullName: repo.fullName },
      });
    await record(tx, ctx, o, "research_opportunity.issue_preview", {
      repositoryId: repo.id,
      actionHash: hash,
    });
  });
  const verified = o.evidence.filter(isVerified).length;
  return {
    opportunityId: o.id,
    repositoryId: repo.id,
    repositoryFullName: repo.fullName,
    ...draft,
    rows: [
      { k: "does", v: "creates one GitHub issue with exactly the text below" },
      { k: "where", v: repo.fullName },
      { k: "evidence", v: `${verified} verified ${verified === 1 ? "claim" : "claims"}, quoted with links` },
      { k: "won't do", v: "assign, label, mention anyone, start a run or change code" },
      { k: "next", v: "a run starts only when you start one from the issue" },
    ],
    actionHash: hash,
    expiresAt: expiresAt.toISOString(),
  };
}

type Attempt = { kind: "done"; o: Row } | { kind: "run"; o: Row; claim: RequestRow; retry: boolean };

/**
 * R2 (FR-CXR-09): the owner's click on the exact previewed hash creates the issue, once. The claim row is written
 * before GitHub is called; a later attempt on a PENDING claim first adopts an issue an earlier attempt already
 * created (found by its marker), so a crash between GitHub's answer and our record never makes a second issue.
 * `issue` is set only from GitHub's response.
 */
export async function createOpportunityIssue(
  db: Db,
  writer: IssueWriter | null,
  ctx: Ctx,
  id: string,
  body: CreateOpportunityIssueRequest,
  idempotencyKey: string,
): Promise<Opportunity> {
  const found = await owned(db, ctx.ownerId, id);
  const profile = await resolveAgentProfile(db, ctx.ownerId, found.projectId, "AI_RESEARCHER");
  if (!profile.settings.tools.includes(TOOL))
    throw new HttpError(
      409,
      "CONFLICT",
      `The AI researcher's profile in this project doesn't allow ${TOOL}. Allow it in Settings → Agent profiles.`,
      { setting: "tools", tool: TOOL },
    );
  const w = need(writer);

  const attempt = await db.transaction(async (tx): Promise<Attempt> => {
    await assertNotStopped(tx);
    const o = await owned(tx, ctx.ownerId, id, true);
    await resolveProject(tx, ctx.ownerId, o.projectId, { write: true, mode: "DEV" });
    if (o.status === "ISSUE_CREATED") return { kind: "done", o }; // approving twice: the one issue
    if (o.status !== "OPEN") throw notOpen(o);
    const now = new Date();
    const [preview] = await tx
      .select()
      .from(opportunityIssuePreviews)
      .where(
        and(
          eq(opportunityIssuePreviews.opportunityId, o.id),
          eq(opportunityIssuePreviews.actionHash, body.actionHash),
          eq(opportunityIssuePreviews.repositoryId, body.repositoryId),
        ),
      );
    if (!preview)
      throw new HttpError(409, "CONFLICT", "The issue changed since it was shown; preview it again.");
    if (preview.expiresAt <= now)
      throw new HttpError(409, "CONFLICT", "This preview has expired; preview the issue again.");
    // Never sends an issue that no longer matches what the opportunity would produce now.
    if (actionHash(o.id, preview.repositoryId, issueDraft(o)) !== preview.actionHash)
      throw new HttpError(409, "CONFLICT", "The issue changed since it was shown; preview it again.");
    await assertBound(tx, o.projectId, preview.repositoryId);

    const [existing] = await tx
      .select()
      .from(opportunityIssueRequests)
      .where(eq(opportunityIssueRequests.opportunityId, o.id))
      .for("update");
    const lease = new Date(now.getTime() + LEASE_MS);
    if (existing) {
      if (existing.actionHash !== body.actionHash)
        throw new HttpError(
          409,
          existing.idempotencyKey === idempotencyKey ? "IDEMPOTENCY_KEY_REUSED" : "CONFLICT",
          `An issue for this was already approved on ${existing.repositoryFullName}; approve that preview again to finish it.`,
          { repositoryId: existing.repositoryId },
        );
      if (existing.lockedUntil && existing.lockedUntil > now)
        throw new HttpError(
          409,
          "CONFLICT",
          "NEXUS is creating this issue right now; it shows here when GitHub answers.",
        );
      const [claim] = await tx
        .update(opportunityIssueRequests)
        .set({ attempts: existing.attempts + 1, lockedUntil: lease, updatedAt: now })
        .where(eq(opportunityIssueRequests.id, existing.id))
        .returning();
      await record(tx, ctx, o, "research_opportunity.issue_retry", {
        repositoryId: existing.repositoryId,
        actionHash: existing.actionHash,
        attempt: claim!.attempts,
      });
      return { kind: "run", o, claim: claim!, retry: true };
    }
    const [claim] = await tx
      .insert(opportunityIssueRequests)
      .values({
        workspaceId: o.workspaceId,
        projectId: o.projectId,
        opportunityId: o.id,
        repositoryId: preview.repositoryId,
        repositoryFullName: preview.repositoryFullName,
        title: preview.title,
        body: preview.body,
        labels: preview.labels,
        actionHash: preview.actionHash,
        idempotencyKey,
        status: "PENDING",
        attempts: 1,
        lockedUntil: lease,
      })
      .returning();
    await record(tx, ctx, o, "research_opportunity.issue_approve", {
      repositoryId: preview.repositoryId,
      actionHash: preview.actionHash,
      profileVersionId: profile.versionId,
    });
    return { kind: "run", o, claim: claim!, retry: false };
  });
  if (attempt.kind === "done") return toDto(attempt.o);

  const { o, claim, retry } = attempt;
  let posted = false;
  try {
    const repo = await w.target(claim.repositoryId);
    const since = new Date(claim.createdAt.getTime() - CLOCK_SKEW_MS);
    const adopted = retry ? await w.find(repo, issueMarker(o.id), since) : null;
    posted = !adopted;
    const issue = adopted ?? (await w.create(repo, claim));
    return await db.transaction(async (tx) => {
      await tx
        .update(opportunityIssueRequests)
        .set({
          status: "CREATED",
          issueNumber: issue.number,
          issueUrl: issue.url,
          lockedUntil: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(opportunityIssueRequests.id, claim.id));
      const [done] = await tx
        .update(researchOpportunities)
        .set({ status: "ISSUE_CREATED", issue, updatedAt: new Date() })
        .where(eq(researchOpportunities.id, o.id))
        .returning();
      await record(tx, ctx, o, "research_opportunity.issue_create", {
        repositoryId: claim.repositoryId,
        actionHash: claim.actionHash,
        issueNumber: issue.number,
        adopted: adopted !== null,
        attempt: claim.attempts,
      });
      return toDto(done!);
    });
  } catch (err) {
    // On a first attempt that never reached GitHub's create, or that GitHub refused (4xx), no issue exists: release
    // the claim, so another repository can be chosen. Otherwise GitHub may have created it: the claim stays PENDING
    // and the next approve looks for it first.
    const refused = err instanceof HttpError && err.statusCode < 500;
    const release = !retry && (!posted || refused);
    const message = err instanceof HttpError ? err.message : "Unexpected error while creating the issue.";
    await db.transaction(async (tx) => {
      if (release) await tx.delete(opportunityIssueRequests).where(eq(opportunityIssueRequests.id, claim.id));
      else
        await tx
          .update(opportunityIssueRequests)
          .set({ lockedUntil: null, lastError: message, updatedAt: new Date() })
          .where(eq(opportunityIssueRequests.id, claim.id));
      await record(
        tx,
        ctx,
        o,
        "research_opportunity.issue_create",
        {
          repositoryId: claim.repositoryId,
          actionHash: claim.actionHash,
          attempt: claim.attempts,
          code: err instanceof HttpError ? err.code : "INTERNAL",
          released: release,
        },
        "FAILED",
      );
    });
    throw err;
  }
}
