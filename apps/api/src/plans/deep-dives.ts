import type { CreateDeepDiveRequest, DeepDive, DeepDiveDetail } from "@nexus/contracts";
import type { Ctx } from "../research/service.ts";
import { cancelDeepDive, createDeepDive, getDeepDive, type DeepDeps } from "../research/deep/service.ts";

/**
 * The deep-dive operations Talk and plans use, bound to the research deep-dive service. Everything goes through its
 * typed, idempotent paths (budget reservation, emergency stop, profile checks live there); tests inject fakes here.
 */
export type DeepDives = {
  create(
    ctx: Ctx,
    body: CreateDeepDiveRequest,
    idempotencyKey: string,
  ): Promise<{ created: boolean; deepDive: DeepDive }>;
  get(ownerId: string, id: string): Promise<DeepDiveDetail>;
  cancel(ctx: Ctx, id: string): Promise<DeepDive>;
};

export const deepDiveOps = (deps: DeepDeps): DeepDives => ({
  create: (ctx, body, key) => createDeepDive(deps, ctx, body, key),
  get: (ownerId, id) => getDeepDive(deps.db, ownerId, id),
  cancel: (ctx, id) => cancelDeepDive(deps.db, ctx, id),
});
