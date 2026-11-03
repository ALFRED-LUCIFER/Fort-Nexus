import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CreateDeepDiveRequest,
  DeepDive,
  DeepDiveDetail,
  DeepDiveList,
  DeepDiveListQuery,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
} from "@nexus/contracts";
import type { Deps } from "../../app.ts";
import { ownerActor } from "../../jobs.ts";
import { owner } from "../../routes/owner.ts";
import type { Ctx } from "../service.ts";
import { cancelDeepDive, createDeepDive, getDeepDive, listDeepDives } from "./service.ts";

const IdParams = z.object({ id: z.uuid() });

const ctx = (req: FastifyRequest): Ctx => ({
  ownerId: owner(req).id,
  actor: ownerActor(owner(req).id),
  correlationId: req.id,
});

/** RESEARCH_DEEP_DIVE (PRD §10.1). Registered inside the owner scope: session required, trusted Origin on writes. */
export async function deepDiveRoutes(app: FastifyInstance, { db, config, diver }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Answers once the dive is queued and its cap reserved; it runs in the background (poll the dive).
  r.post(
    "/v1/research/deep-dives",
    {
      schema: {
        headers: z.object({ [IDEMPOTENCY_HEADER]: IdempotencyKey }),
        body: CreateDeepDiveRequest,
        response: { 202: DeepDive },
      },
    },
    async (req, reply) => {
      const { deepDive } = await createDeepDive(
        { db, config, diver },
        ctx(req),
        req.body,
        req.headers[IDEMPOTENCY_HEADER],
      );
      reply.code(202);
      return deepDive;
    },
  );

  r.get(
    "/v1/research/deep-dives",
    { schema: { querystring: DeepDiveListQuery, response: { 200: DeepDiveList } } },
    async (req) => listDeepDives(db, owner(req).id, req.query),
  );

  r.get(
    "/v1/research/deep-dives/:id",
    { schema: { params: IdParams, response: { 200: DeepDiveDetail } } },
    async (req) => getDeepDive(db, owner(req).id, req.params.id),
  );

  r.post(
    "/v1/research/deep-dives/:id/cancel",
    { schema: { params: IdParams, response: { 200: DeepDive } } },
    async (req) => cancelDeepDive(db, ctx(req), req.params.id),
  );
}
