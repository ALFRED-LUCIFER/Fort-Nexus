import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppendEventsRequest,
  AppendEventsResponse,
  CHANGESET_MAX_BYTES,
  HeartbeatRequest,
  HeartbeatResponse,
  LeaseResponse,
  RunnerRegisterRequest,
  RunnerRegisterResponse,
  UploadChangesetRequest,
  UploadChangesetResponse,
  type IssueToPrTask,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { HttpError } from "../errors.ts";
import { uploadChangeset, workBranch } from "../issue-to-pr.ts";
import { appendRunnerEvents, failJob, heartbeat, runnerActor, tryLease } from "../jobs.ts";
import { leaseRequest } from "../system.ts";
import { ANY_JOB } from "../notify.ts";
import { authenticateRunner, registerRunner, type RunnerRow } from "../runners.ts";

const RECHECK_MS = 5_000;
// Base64 of CHANGESET_MAX_BYTES plus room for 300 paths and JSON; the decoded size is checked exactly.
const CHANGESET_BODY_LIMIT = Math.ceil(CHANGESET_MAX_BYTES / 3) * 4 + 2 * 1024 * 1024;
const JobParams = z.object({ id: z.uuid() });

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
      // Daily budget: the run's cost cap shrinks to what is left of today's; nothing left → fail, don't start.
      const request = await leaseRequest(db, job, config.ownerTimezone);
      if (!request) {
        await failJob(db, {
          jobId: job.id,
          actor: "system:budget",
          reason: "BUDGET_EXHAUSTED",
          message: `Today's AI budget was used up before this run could start. It resets at midnight ${config.ownerTimezone}.`,
        });
        return reply.code(204).send(null);
      }
      let task: IssueToPrTask | undefined;
      if (job.issueSnapshot) {
        const snapshot = job.issueSnapshot;
        try {
          if (!deps.github) throw new HttpError(409, "CONFLICT", "GitHub isn't set up on this NEXUS.");
          const git = await deps.github.readToken(snapshot.repositoryId);
          task = { kind: "issue_to_pr", snapshot, workBranch: workBranch(snapshot.issueNumber, job.id), git };
        } catch (err) {
          // The runner can't fetch without it: fail the job (the owner re-runs) rather than wedge the queue.
          if (!(err instanceof HttpError)) req.log.error({ err, correlationId: job.id }, "read token failed");
          await failJob(db, {
            jobId: job.id,
            actor: runnerActor(runnerOf(req).id),
            reason: "GITHUB_TOKEN_UNAVAILABLE",
            message:
              err instanceof HttpError ? err.message : "Couldn't get a GitHub token for the repository.",
          });
          return reply.code(204).send(null);
        }
      }
      return {
        jobId: job.id,
        request,
        fencingToken: job.fencingToken,
        leaseExpiresAt: job.leaseExpiresAt!.toISOString(),
        ...(task ? { task } : {}),
      };
    },
  );

  r.post(
    "/v1/runner/jobs/:id/events",
    {
      schema: {
        params: JobParams,
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

  r.post(
    "/v1/runner/jobs/:id/changeset",
    {
      bodyLimit: CHANGESET_BODY_LIMIT,
      schema: { params: JobParams, body: UploadChangesetRequest, response: { 200: UploadChangesetResponse } },
    },
    async (req) => {
      req.log = req.log.child({ correlationId: req.params.id });
      return uploadChangeset(db, runnerOf(req), req.params.id, req.body);
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
