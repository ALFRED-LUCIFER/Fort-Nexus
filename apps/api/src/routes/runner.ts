import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppendEventsRequest,
  AppendEventsResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  LeaseResponse,
  RunnerRegisterRequest,
  RunnerRegisterResponse,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { HttpError } from "../errors.ts";
import { appendRunnerEvents, heartbeat, tryLease } from "../jobs.ts";
import { ANY_JOB } from "../notify.ts";
import { authenticateRunner, registerRunner, type RunnerRow } from "../runners.ts";

const RECHECK_MS = 5_000;

const runnerOf = (req: FastifyRequest) => {
  if (!req.runner) throw new HttpError(401, "UNAUTHENTICATED", "Runner token required");
  return req.runner;
};

/** Register: pairing code, strictly rate limited (it is the only unauthenticated runner write). */
export async function runnerRegisterRoute(app: FastifyInstance, deps: Deps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/v1/runner/register",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { body: RunnerRegisterRequest, response: { 201: RunnerRegisterResponse } },
    },
    async (req, reply) => {
      reply.code(201);
      return registerRunner(deps.db, { ...req.body, correlationId: req.id });
    },
  );
}

/** Runner API: `Authorization: Bearer <token>`; unknown or revoked tokens get 401. */
export async function runnerRoutes(app: FastifyInstance, deps: Deps) {
  const { db, hub, config } = deps;

  app.decorateRequest("runner", null);
  app.addHook("onRequest", async (request) => {
    const [scheme, token] = (request.headers.authorization ?? "").split(" ");
    const runner = scheme === "Bearer" && token ? await authenticateRunner(db, token) : null;
    if (!runner) throw new HttpError(401, "UNAUTHENTICATED", "Runner token is missing, invalid or revoked");
    request.runner = runner;
  });

  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/v1/runner/heartbeat",
    { schema: { body: HeartbeatRequest, response: { 200: HeartbeatResponse } } },
    async (req) => ({
      cancelJobIds: await heartbeat(db, runnerOf(req), req.body.activeJobIds),
    }),
  );

  r.post(
    "/v1/runner/lease",
    { schema: { response: { 200: LeaseResponse, 204: z.null() } } },
    async (req, reply) => {
      const gone = new AbortController();
      reply.raw.on("close", () => gone.abort());
      const job = await leaseWithWait(
        deps,
        runnerOf(req),
        AbortSignal.any([deps.shutdown, gone.signal]),
        config.leasePollMs,
      );
      if (!job) return reply.code(204).send(null);
      req.log.info({ correlationId: job.id, fencingToken: job.fencingToken }, "job leased");
      return {
        jobId: job.id,
        request: job.request,
        fencingToken: job.fencingToken,
        leaseExpiresAt: job.leaseExpiresAt!.toISOString(),
      };
    },
  );

  r.post(
    "/v1/runner/jobs/:id/events",
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        body: AppendEventsRequest,
        response: { 200: AppendEventsResponse },
      },
    },
    async (req) => {
      // Runner calls are correlated by job id (spec); later log lines and errors carry it.
      req.log = req.log.child({ correlationId: req.params.id });
      return appendRunnerEvents(db, runnerOf(req), req.params.id, req.body);
    },
  );

  /**
   * Long-poll: try now, then again on any job notification or every RECHECK_MS until the deadline.
   * shortcut: wakes on every job event (fine for one owner / few runners); add a dedicated "queued" channel
   * if lease traffic grows. A client that disconnects right after a claim leaves the job to the reaper.
   */
  async function leaseWithWait(d: Deps, runner: RunnerRow, signal: AbortSignal, pollMs: number) {
    const deadline = Date.now() + pollMs;
    let dirty = false;
    let wake = () => {};
    const unsubscribe = hub.subscribe(ANY_JOB, () => {
      dirty = true;
      wake();
    });
    const onAbort = () => wake();
    signal.addEventListener("abort", onAbort);
    try {
      for (;;) {
        if (signal.aborted) return null;
        dirty = false;
        const job = await tryLease(d.db, runner);
        const remaining = deadline - Date.now();
        if (job || remaining <= 0) return job;
        if (dirty) continue;
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => wake(), Math.min(remaining, RECHECK_MS));
          wake = () => {
            clearTimeout(t);
            wake = () => {};
            resolve();
          };
          if (signal.aborted) wake();
        });
      }
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
    }
  }
}

declare module "fastify" {
  interface FastifyRequest {
    runner: RunnerRow | null;
  }
}
