import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CreateJobRequest,
  CreateJobResponse,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  Job,
  JobEventsQuery,
  JobList,
  ListJobsQuery,
  Me,
  PairingCodeResponse,
  Runner,
  RunnerList,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { HttpError } from "../errors.ts";
import { cancelJob, createJob, getJob, listJobs, toJobDto } from "../jobs.ts";
import { createPairingCode, listRunners, revokeRunner } from "../runners.ts";
import { streamJobEvents } from "../sse.ts";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const IdParams = z.object({ id: z.uuid() });

const owner = (req: FastifyRequest) => {
  if (!req.owner) throw new HttpError(401, "UNAUTHENTICATED", "Sign in required");
  return req.owner;
};

/** Owner API: Better Auth cookie session; mutations also need an Origin in the trusted list (CSRF). */
export async function ownerRoutes(app: FastifyInstance, deps: Deps) {
  const { db, auth, config } = deps;

  app.decorateRequest("owner", null);
  app.addHook("onRequest", async (request) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) throw new HttpError(401, "UNAUTHENTICATED", "Sign in required");
    request.owner = { id: session.user.id, email: session.user.email, name: session.user.name };
    if (MUTATING.has(request.method)) {
      const origin = request.headers.origin;
      if (!origin || !config.trustedOrigins.includes(origin))
        throw new HttpError(403, "FORBIDDEN", "Request origin is not trusted");
    }
  });

  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/v1/me", { schema: { response: { 200: Me } } }, async (req) => owner(req));

  r.get("/v1/runners", { schema: { response: { 200: RunnerList } } }, async (req) => ({
    items: await listRunners(db, owner(req).id),
  }));

  r.post("/v1/runners/pair", { schema: { response: { 201: PairingCodeResponse } } }, async (req, reply) => {
    reply.code(201);
    return createPairingCode(db, { ownerId: owner(req).id, correlationId: req.id });
  });

  r.post("/v1/runners/:id/revoke", { schema: { params: IdParams, response: { 200: Runner } } }, async (req) =>
    revokeRunner(db, { ownerId: owner(req).id, runnerId: req.params.id, correlationId: req.id }),
  );

  r.post(
    "/v1/jobs",
    {
      schema: {
        headers: z.object({ [IDEMPOTENCY_HEADER]: IdempotencyKey }),
        body: CreateJobRequest,
        response: { 202: CreateJobResponse },
      },
    },
    async (req, reply) => {
      const job = await createJob(db, {
        ownerId: owner(req).id,
        idempotencyKey: req.headers[IDEMPOTENCY_HEADER],
        body: req.body,
        correlationId: req.id,
      });
      reply.code(202);
      return { jobId: job.id, status: job.status, streamUrl: `/v1/jobs/${job.id}/events` };
    },
  );

  r.get(
    "/v1/jobs",
    {
      schema: {
        querystring: ListJobsQuery.extend({ cursor: z.uuid().optional() }),
        response: { 200: JobList },
      },
    },
    async (req) => listJobs(db, owner(req).id, req.query),
  );

  r.get("/v1/jobs/:id", { schema: { params: IdParams, response: { 200: Job } } }, async (req) =>
    toJobDto(await getJob(db, owner(req).id, req.params.id)),
  );

  r.post(
    "/v1/jobs/:id/cancel",
    { schema: { params: IdParams, response: { 202: Job } } },
    async (req, reply) => {
      const job = await cancelJob(db, {
        ownerId: owner(req).id,
        jobId: req.params.id,
        correlationId: req.id,
      });
      reply.code(202);
      return toJobDto(job);
    },
  );

  r.get(
    "/v1/jobs/:id/events",
    {
      schema: {
        params: IdParams,
        querystring: JobEventsQuery,
        headers: z.object({ "last-event-id": z.coerce.number().int().nonnegative().optional() }),
      },
    },
    async (req, reply) => {
      await getJob(db, owner(req).id, req.params.id); // 404 unless the caller owns it
      const after = req.query.afterSequence ?? req.headers["last-event-id"] ?? 0;
      return streamJobEvents(deps, req, reply, req.params.id, after);
    },
  );
}

declare module "fastify" {
  interface FastifyRequest {
    owner: { id: string; email: string; name: string } | null;
  }
}
