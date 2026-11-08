import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CloudHandoff,
  CloudHandoffPreview,
  CloudHandoffPreviewRequest,
  CloudHandoffQuery,
  CloudHandoffState,
  CreateCloudHandoffRequest,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { ownerActor } from "../jobs.ts";
import { IssueParams } from "../routes/github.ts";
import { owner } from "../routes/owner.ts";
import { create, getState, preview, type Ctx } from "./service.ts";

const ctx = (req: FastifyRequest): Ctx => ({
  ownerId: owner(req).id,
  actor: ownerActor(owner(req).id),
  correlationId: req.id,
});

/**
 * Hand an issue to a Claude Code routine in Anthropic's cloud (docs/specs/cloud-handoff.md). Registered inside the
 * owner scope: session required, mutations need a trusted Origin.
 */
export async function cloudHandoffRoutes(app: FastifyInstance, { db, github, config }: Deps) {
  const d = { db, github, claudeCloudFile: config.claudeCloudFile };
  const r = app.withTypeProvider<ZodTypeProvider>();
  const target = (p: z.infer<typeof IssueParams>) => ({ repositoryId: p.repoId, issueNumber: p.number });

  r.get(
    "/v1/repositories/:repoId/issues/:number/cloud-handoff",
    { schema: { params: IssueParams, querystring: CloudHandoffQuery, response: { 200: CloudHandoffState } } },
    async (req) => getState(d, owner(req).id, req.query.projectId, target(req.params)),
  );

  r.post(
    "/v1/repositories/:repoId/issues/:number/cloud-handoff/preview",
    {
      schema: {
        params: IssueParams,
        body: CloudHandoffPreviewRequest,
        response: { 200: CloudHandoffPreview },
      },
    },
    async (req) => preview(d, ctx(req), target(req.params), req.body),
  );

  // Answers once Anthropic has: STARTED with the session, or the error its answer maps to (spec "Fire outcome").
  r.post(
    "/v1/repositories/:repoId/issues/:number/cloud-handoff",
    {
      schema: {
        params: IssueParams,
        headers: z.object({ [IDEMPOTENCY_HEADER]: IdempotencyKey }),
        body: CreateCloudHandoffRequest,
        response: { 200: CloudHandoff },
      },
    },
    async (req) => create(d, ctx(req), target(req.params), req.body, req.headers[IDEMPOTENCY_HEADER]),
  );
}
