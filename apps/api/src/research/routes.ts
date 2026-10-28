import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CreateWatchlistRequest,
  Finding,
  FindingExplanation,
  FindingList,
  FindingSearchQuery,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  ProjectFilterQuery,
  ResearchBrief,
  ResearchRun,
  ResearchRunList,
  UpdateWatchlistRequest,
  Watchlist,
  WatchlistList,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { ownerActor } from "../jobs.ts";
import { owner } from "../routes/owner.ts";
import { explainFinding, getExplanation } from "./explain.ts";
import {
  archiveWatchlist,
  createManualRun,
  createWatchlist,
  getBrief,
  listRuns,
  listWatchlists,
  markRead,
  searchFindings,
  updateWatchlist,
  type Ctx,
} from "./service.ts";

const IdParams = z.object({ id: z.uuid() });

const ctx = (req: FastifyRequest): Ctx => ({
  ownerId: owner(req).id,
  actor: ownerActor(owner(req).id),
  correlationId: req.id,
});

/** EPIC RES. Registered inside the owner scope: session required, mutations need a trusted Origin. */
export async function researchRoutes(app: FastifyInstance, { db, research, config }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/v1/research/watchlists",
    { schema: { querystring: ProjectFilterQuery, response: { 200: WatchlistList } } },
    async (req) => ({ items: await listWatchlists(db, owner(req).id, req.query.projectId) }),
  );

  r.post(
    "/v1/research/watchlists",
    { schema: { body: CreateWatchlistRequest, response: { 201: Watchlist } } },
    async (req, reply) => {
      reply.code(201);
      return createWatchlist(db, ctx(req), req.body);
    },
  );

  r.patch(
    "/v1/research/watchlists/:id",
    { schema: { params: IdParams, body: UpdateWatchlistRequest, response: { 200: Watchlist } } },
    async (req) => updateWatchlist(db, ctx(req), req.params.id, req.body),
  );

  r.delete("/v1/research/watchlists/:id", { schema: { params: IdParams } }, async (req, reply) => {
    await archiveWatchlist(db, ctx(req), req.params.id);
    return reply.code(204).send();
  });

  // Answers once the run is recorded; it executes in the background (poll the run).
  r.post(
    "/v1/research/watchlists/:id/run",
    {
      schema: {
        params: IdParams,
        headers: z.object({ [IDEMPOTENCY_HEADER]: IdempotencyKey }),
        response: { 202: ResearchRun },
      },
    },
    async (req, reply) => {
      const run = await createManualRun(db, ctx(req), req.params.id, req.headers[IDEMPOTENCY_HEADER]);
      if (run.status === "RUNNING") research.start(run.id);
      reply.code(202);
      return run;
    },
  );

  r.get(
    "/v1/research/runs",
    {
      schema: {
        querystring: ProjectFilterQuery.extend({ watchlistId: z.uuid().optional() }),
        response: { 200: ResearchRunList },
      },
    },
    async (req) => ({ items: await listRuns(db, owner(req).id, req.query) }),
  );

  r.get(
    "/v1/research/runs/:id",
    { schema: { params: IdParams, response: { 200: ResearchBrief } } },
    async (req) => getBrief(db, owner(req).id, req.params.id),
  );

  r.get(
    "/v1/research/findings",
    {
      schema: {
        querystring: FindingSearchQuery.extend({ cursor: z.uuid().optional() }),
        response: { 200: FindingList },
      },
    },
    async (req) => searchFindings(db, owner(req).id, req.query),
  );

  r.post(
    "/v1/research/findings/:id/read",
    { schema: { params: IdParams, response: { 200: Finding } } },
    async (req) => markRead(db, ctx(req), req.params.id),
  );

  // FR-RES-08: written once per finding (201), then served from the store (200) without calling the model.
  r.post(
    "/v1/research/findings/:id/explain",
    { schema: { params: IdParams, response: { 200: FindingExplanation, 201: FindingExplanation } } },
    async (req, reply) => {
      const { created, explanation } = await explainFinding(db, config.aiFile, ctx(req), req.params.id);
      reply.code(created ? 201 : 200);
      return explanation;
    },
  );

  r.get(
    "/v1/research/findings/:id/explanation",
    { schema: { params: IdParams, response: { 200: FindingExplanation } } },
    async (req) => getExplanation(db, owner(req).id, req.params.id),
  );
}
