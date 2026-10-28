// shortcut: adapter to the pinned research signatures (docs/specs/p1-wave-2.md, "Cross-module signatures"); the
// coordinator removes this file at merge and imports getWatchlist/createManualRun from ../research/service.ts.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ResearchRun, Watchlist } from "@nexus/contracts";
import type { Db } from "../db/index.ts";
import { notFound } from "../errors.ts";
import { createManualRun as startManualRun, listWatchlists } from "../research/service.ts";
import { researchWatchlists } from "../research/schema.ts";
import { ownerWorkspaceIds, resolveProject } from "../workspaces.ts";

async function watchlistScope(db: Db, ownerId: string, id: string) {
  const [w] = await db
    .select({ workspaceId: researchWatchlists.workspaceId, projectId: researchWatchlists.projectId })
    .from(researchWatchlists)
    .where(
      and(
        eq(researchWatchlists.id, id),
        isNull(researchWatchlists.archivedAt),
        inArray(researchWatchlists.workspaceId, await ownerWorkspaceIds(db, ownerId)),
      ),
    );
  if (!w) throw notFound("Watchlist");
  return w;
}

export async function getWatchlist(db: Db, ownerId: string, id: string): Promise<Watchlist> {
  const found = (await listWatchlists(db, await watchlistScope(db, ownerId, id))).find((w) => w.id === id);
  if (!found) throw notFound("Watchlist");
  return found;
}

export async function createManualRun(
  db: Db,
  ctx: { ownerId: string; actor: string; correlationId: string },
  watchlistId: string,
  idempotencyKey: string,
): Promise<ResearchRun> {
  const w = await watchlistScope(db, ctx.ownerId, watchlistId);
  const { workspaceId, projectId } = await resolveProject(db, ctx.ownerId, w.projectId, { write: true });
  const { run } = await startManualRun(
    db,
    { scope: { workspaceId, projectId }, actor: ctx.actor, correlationId: ctx.correlationId },
    watchlistId,
    idempotencyKey,
  );
  return run;
}
