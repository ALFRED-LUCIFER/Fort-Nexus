import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CreateOpportunityIssueRequest,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  IssuePreview,
  IssuePreviewRequest,
  Opportunity,
  OpportunityList,
  OpportunityListQuery,
} from "@nexus/contracts";
import type { Deps } from "../../app.ts";
import type { GithubAppConfig } from "../../github/app-config.ts";
import { createIssueWriter } from "../../github/issues.ts";
import { ownerActor } from "../../jobs.ts";
import { owner } from "../../routes/owner.ts";
import type { Ctx } from "../service.ts";
import {
  createOpportunityIssue,
  dismissOpportunity,
  getOpportunity,
  listOpportunities,
  previewIssue,
} from "./service.ts";

const IdParams = z.object({ id: z.uuid() });

const ctx = (req: FastifyRequest): Ctx => ({
  ownerId: owner(req).id,
  actor: ownerActor(owner(req).id),
  correlationId: req.id,
});

/**
 * FR-RES-10 / FR-CXR-09: the Cofounder "noticed" cards and their approved issue. Registered inside the owner scope:
 * session required, mutations need a trusted Origin. `githubApp` is null until GitHub is set up.
 */
export async function opportunityRoutes(
  app: FastifyInstance,
  { db, github }: Deps,
  githubApp: GithubAppConfig | null,
) {
  const writer = githubApp && github ? createIssueWriter(githubApp, github, app.log) : null;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/v1/research/opportunities",
    { schema: { querystring: OpportunityListQuery, response: { 200: OpportunityList } } },
    async (req) => listOpportunities(db, owner(req).id, req.query),
  );

  r.get(
    "/v1/research/opportunities/:id",
    { schema: { params: IdParams, response: { 200: Opportunity } } },
    async (req) => getOpportunity(db, owner(req).id, req.params.id),
  );

  r.post(
    "/v1/research/opportunities/:id/dismiss",
    { schema: { params: IdParams, response: { 200: Opportunity } } },
    async (req) => dismissOpportunity(db, ctx(req), req.params.id),
  );

  r.post(
    "/v1/research/opportunities/:id/issue-preview",
    { schema: { params: IdParams, body: IssuePreviewRequest, response: { 200: IssuePreview } } },
    async (req) => previewIssue(db, writer, ctx(req), req.params.id, req.body),
  );

  // Answers once GitHub has: ISSUE_CREATED with the issue, or the error (the claim lets a retry finish it).
  r.post(
    "/v1/research/opportunities/:id/issue",
    {
      schema: {
        params: IdParams,
        headers: z.object({ [IDEMPOTENCY_HEADER]: IdempotencyKey }),
        body: CreateOpportunityIssueRequest,
        response: { 200: Opportunity },
      },
    },
    async (req) =>
      createOpportunityIssue(db, writer, ctx(req), req.params.id, req.body, req.headers[IDEMPOTENCY_HEADER]),
  );
}
