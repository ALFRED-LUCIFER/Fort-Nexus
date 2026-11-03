import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { PutResearchDomainRequest, ResearchDomain, SourceTier } from "@nexus/contracts";
import { audit } from "../audit.ts";
import type { Db, Tx } from "../db/index.ts";
import { notFound } from "../errors.ts";
import { ownerWorkspaceIds } from "../workspaces.ts";
import { researchDomains } from "./schema.ts";
import type { Ctx } from "./service.ts";

// PRD §9 RES "source allowlist": the owner's per-workspace credibility tier and block list for web domains. Every
// read and write is checked against the caller's own workspaces (FR-CSP-01); another owner's rule doesn't exist.

type DomainRow = typeof researchDomains.$inferSelect;
export type DomainVerdict = { domain: string | null; tier: SourceTier; blocked: boolean };

const UNKNOWN: DomainVerdict = { domain: null, tier: "COMMUNITY", blocked: false };

const toDto = (r: DomainRow): ResearchDomain => ({
  id: r.id,
  workspaceId: r.workspaceId,
  domain: r.domain,
  tier: r.tier,
  blocked: r.blocked,
  note: r.note,
  updatedAt: r.updatedAt.toISOString(),
});

/** A URL host as a rule compares it: lower case, no IPv6 brackets, no trailing root dot. */
const normalHost = (host: string) =>
  host
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");

/**
 * The workspace's policy as a pure lookup, loaded once per call site (a dive loads it at start). A rule matches its
 * domain and every subdomain; the longest matching rule wins; no match is COMMUNITY and not blocked.
 */
export async function domainPolicy(
  db: Db | Tx,
  workspaceId: string,
): Promise<(host: string) => DomainVerdict> {
  const rules = await db
    .select({ domain: researchDomains.domain, tier: researchDomains.tier, blocked: researchDomains.blocked })
    .from(researchDomains)
    .where(eq(researchDomains.workspaceId, workspaceId));
  const byDomain = new Map(rules.map((r) => [r.domain, r]));
  return (host) => {
    // Walk from the full host up to its last two labels; the first hit is the longest matching rule.
    const labels = normalHost(host).split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const rule = byDomain.get(labels.slice(i).join("."));
      if (rule) return { domain: rule.domain, tier: rule.tier, blocked: rule.blocked };
    }
    return UNKNOWN;
  };
}

/** 404 unless `workspaceId` is one of the owner's. */
async function assertOwnedWorkspace(db: Db | Tx, ownerId: string, workspaceId: string) {
  if (!(await ownerWorkspaceIds(db, ownerId)).includes(workspaceId)) throw notFound("Workspace");
}

export async function listDomains(db: Db, ownerId: string, workspaceId: string): Promise<ResearchDomain[]> {
  await assertOwnedWorkspace(db, ownerId, workspaceId);
  const rows = await db
    .select()
    .from(researchDomains)
    .where(eq(researchDomains.workspaceId, workspaceId))
    .orderBy(asc(researchDomains.domain));
  return rows.map(toDto);
}

/** Upsert by (workspaceId, domain); PUT replaces the rule, so an omitted note clears it. Idempotent by design. */
export async function putDomain(db: Db, ctx: Ctx, body: PutResearchDomainRequest): Promise<ResearchDomain> {
  return db.transaction(async (tx) => {
    await assertOwnedWorkspace(tx, ctx.ownerId, body.workspaceId);
    const values = {
      tier: body.tier,
      blocked: body.blocked,
      note: body.note || null,
      updatedAt: new Date(),
    };
    const [row] = await tx
      .insert(researchDomains)
      .values({ workspaceId: body.workspaceId, domain: body.domain, createdBy: ctx.ownerId, ...values })
      .onConflictDoUpdate({ target: [researchDomains.workspaceId, researchDomains.domain], set: values })
      // xmax = 0 only on a freshly inserted row: tells create from update for the audit trail.
      .returning({ ...getTableColumns(researchDomains), inserted: sql<boolean>`(xmax = 0)` });
    const { inserted, ...rule } = row!;
    await audit(tx, {
      actor: ctx.actor,
      action: inserted ? "research.domain.create" : "research.domain.update",
      resourceType: "research_domain",
      resourceId: rule.id,
      correlationId: ctx.correlationId,
      metadata: {
        workspaceId: rule.workspaceId,
        domain: rule.domain,
        tier: rule.tier,
        blocked: rule.blocked,
      },
    });
    return toDto(rule);
  });
}

export async function deleteDomain(db: Db, ctx: Ctx, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [rule] = await tx
      .delete(researchDomains)
      .where(
        and(
          eq(researchDomains.id, id),
          inArray(researchDomains.workspaceId, await ownerWorkspaceIds(tx, ctx.ownerId)),
        ),
      )
      .returning();
    if (!rule) throw notFound("Domain rule");
    await audit(tx, {
      actor: ctx.actor,
      action: "research.domain.delete",
      resourceType: "research_domain",
      resourceId: rule.id,
      correlationId: ctx.correlationId,
      metadata: {
        workspaceId: rule.workspaceId,
        domain: rule.domain,
        tier: rule.tier,
        blocked: rule.blocked,
      },
    });
  });
}
