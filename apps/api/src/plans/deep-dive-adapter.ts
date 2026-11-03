// Adapter for the deep-dive engine (P1 wave 5, module B: apps/api/src/research/deep/service.ts), with exactly the
// signatures pinned in docs/specs/p1-wave-5-researcher.md. Deleted by the coordinator at merge: real module replaces
// this. Until then no deep dive can be created, so Talk proposals and plan steps that approve one fail honestly.
import type { FastifyBaseLogger } from "fastify";
import type {
  CreateDeepDiveRequest,
  DeepDive,
  DeepDiveDetail,
  DeepDiveList,
  DeepDiveListQuery,
} from "@nexus/contracts";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { HttpError, notFound } from "../errors.ts";
import type { Ctx } from "../research/service.ts";

export type DeepDiver = { start(id: string): void; reconcile(): Promise<void> };
export type DeepDeps = { db: Db; config: Config; diver: DeepDiver };

const UNAVAILABLE = "Deep dives aren't available in this build of NEXUS.";

export async function createDeepDive(
  _deps: DeepDeps,
  _ctx: Ctx,
  _body: CreateDeepDiveRequest,
  _idempotencyKey: string,
): Promise<{ created: boolean; deepDive: DeepDive }> {
  throw new HttpError(409, "CONFLICT", UNAVAILABLE);
}

export async function getDeepDive(_db: Db, _ownerId: string, _id: string): Promise<DeepDiveDetail> {
  throw notFound("Deep dive");
}

export async function listDeepDives(_db: Db, _ownerId: string, _q: DeepDiveListQuery): Promise<DeepDiveList> {
  return { items: [], nextCursor: null };
}

export async function cancelDeepDive(_db: Db, _ctx: Ctx, _id: string): Promise<DeepDive> {
  throw notFound("Deep dive");
}

export function createDeepDiver(
  _db: Db,
  _deps: { config: Config },
  _log: FastifyBaseLogger,
  _shutdown: AbortSignal,
): DeepDiver {
  return { start: () => undefined, reconcile: async () => undefined };
}
