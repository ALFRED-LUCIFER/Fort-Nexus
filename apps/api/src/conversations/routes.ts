import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ActionProposal,
  CreateThreadRequest,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  PostTurnRequest,
  PostTurnResponse,
  ProjectFilterQuery,
  ProposalDecisionRequest,
  Thread,
  ThreadDetail,
  ThreadList,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { HttpError } from "../errors.ts";
import { createThread, decideProposal, getThreadDetail, listThreads, postTurn } from "./service.ts";

const IdParams = z.object({ id: z.uuid() });
const ListQuery = ProjectFilterQuery.extend({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Talk, text (EPIC CWV/CXR). Registered inside the owner scope: session + trusted Origin on mutations. */
export async function conversationRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;
  const ownerId = (req: { owner: { id: string } | null }) => {
    if (!req.owner) throw new HttpError(401, "UNAUTHENTICATED", "Sign in required");
    return req.owner.id;
  };
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/v1/conversations",
    { schema: { querystring: ListQuery, response: { 200: ThreadList } } },
    async (req) => listThreads(db, ownerId(req), req.query),
  );

  r.post(
    "/v1/conversations",
    { schema: { body: CreateThreadRequest, response: { 201: Thread } } },
    async (req, reply) => {
      reply.code(201);
      return createThread(db, { ownerId: ownerId(req), body: req.body, correlationId: req.id });
    },
  );

  r.get(
    "/v1/conversations/:id",
    { schema: { params: IdParams, response: { 200: ThreadDetail } } },
    async (req) => getThreadDetail(db, ownerId(req), req.params.id),
  );

  r.post(
    "/v1/conversations/:id/turns",
    {
      // Each turn is a paid model call (FR-CSP-08).
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        params: IdParams,
        headers: z.object({ [IDEMPOTENCY_HEADER]: IdempotencyKey }),
        body: PostTurnRequest,
        response: { 200: PostTurnResponse },
      },
    },
    async (req) =>
      postTurn(deps, {
        ownerId: ownerId(req),
        threadId: req.params.id,
        idempotencyKey: req.headers[IDEMPOTENCY_HEADER],
        body: req.body,
        correlationId: req.id,
      }),
  );

  r.post(
    "/v1/conversations/proposals/:id/decision",
    { schema: { params: IdParams, body: ProposalDecisionRequest, response: { 200: ActionProposal } } },
    async (req) =>
      decideProposal(deps, {
        ownerId: ownerId(req),
        proposalId: req.params.id,
        body: req.body,
        correlationId: req.id,
      }),
  );
}
