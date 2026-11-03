import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ApproveJobDraftRequest,
  CreateJobDraftRequest,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  JobDraft,
  JobDraftList,
  JobDraftPreview,
  JobDraftPreviewRequest,
  ListJobDraftsQuery,
  UpdateJobDraftRequest,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import type { GithubAppConfig } from "../github/app-config.ts";
import { createIssueWriter } from "../github/issues.ts";
import { ownerActor } from "../jobs.ts";
import { owner } from "../routes/owner.ts";
import {
  approveJobDraft,
  createJobDraft,
  discardJobDraft,
  getJobDraft,
  listJobDrafts,
  previewJobDraft,
  updateJobDraft,
  type Ctx,
  type JobDraftDeps,
} from "./service.ts";

const IdParams = z.object({ id: z.uuid() });
const KeyHeader = z.object({ [IDEMPOTENCY_HEADER]: IdempotencyKey });

const ctx = (req: FastifyRequest): Ctx => ({
  ownerId: owner(req).id,
  actor: ownerActor(owner(req).id),
  correlationId: req.id,
});

/**
 * Jobs wave B: a job in plain words. Registered inside the owner scope: session required, mutations need a trusted
 * Origin. `githubApp` is null until GitHub is set up.
 */
export async function jobDraftRoutes(app: FastifyInstance, deps: Deps, githubApp: GithubAppConfig | null) {
  const svc: JobDraftDeps = {
    db: deps.db,
    config: deps.config,
    github: deps.github,
    writer: githubApp && deps.github ? createIssueWriter(githubApp, deps.github, app.log) : null,
  };
  const { db } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/v1/job-drafts",
    {
      // Each draft is a paid model call (FR-CSP-08).
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { headers: KeyHeader, body: CreateJobDraftRequest, response: { 201: JobDraft } },
    },
    async (req, reply) => {
      reply.code(201);
      return createJobDraft(svc, ctx(req), req.body, req.headers[IDEMPOTENCY_HEADER]);
    },
  );

  r.get(
    "/v1/job-drafts",
    { schema: { querystring: ListJobDraftsQuery, response: { 200: JobDraftList } } },
    async (req) => listJobDrafts(db, owner(req).id, req.query),
  );

  r.get("/v1/job-drafts/:id", { schema: { params: IdParams, response: { 200: JobDraft } } }, async (req) =>
    getJobDraft(db, owner(req).id, req.params.id),
  );

  r.patch(
    "/v1/job-drafts/:id",
    { schema: { params: IdParams, body: UpdateJobDraftRequest, response: { 200: JobDraft } } },
    async (req) => updateJobDraft(svc, ctx(req), req.params.id, req.body),
  );

  r.post(
    "/v1/job-drafts/:id/preview",
    { schema: { params: IdParams, body: JobDraftPreviewRequest, response: { 200: JobDraftPreview } } },
    async (req) => previewJobDraft(svc, ctx(req), req.params.id, req.body),
  );

  // Answers once GitHub and the job record have: STARTED with the job, or the error (a retry resumes it).
  r.post(
    "/v1/job-drafts/:id/approve",
    {
      schema: {
        params: IdParams,
        headers: KeyHeader,
        body: ApproveJobDraftRequest,
        response: { 200: JobDraft },
      },
    },
    async (req) => approveJobDraft(svc, ctx(req), req.params.id, req.body, req.headers[IDEMPOTENCY_HEADER]),
  );

  r.post(
    "/v1/job-drafts/:id/discard",
    { schema: { params: IdParams, response: { 200: JobDraft } } },
    async (req) => discardJobDraft(db, ctx(req), req.params.id),
  );
}
