import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CreatePlanRequest,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  Plan,
  PlanDecisionRequest,
  PlanList,
  ProjectFilterQuery,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { owner } from "../routes/owner.ts";
import { cancelPlan, createPlan, decidePlan, getPlan, listPlans } from "./service.ts";

const IdParams = z.object({ id: z.uuid() });

/** Chief of Staff plans (EPIC AGT). Registered inside the owner scope: session + trusted Origin on mutations. */
export async function planRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/v1/plans",
    {
      // Each draft is a paid model call (FR-CSP-08).
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        headers: z.object({ [IDEMPOTENCY_HEADER]: IdempotencyKey }),
        body: CreatePlanRequest,
        response: { 201: Plan },
      },
    },
    async (req, reply) => {
      reply.code(201);
      return createPlan(deps, {
        ownerId: owner(req).id,
        idempotencyKey: req.headers[IDEMPOTENCY_HEADER],
        body: req.body,
        correlationId: req.id,
      });
    },
  );

  r.get(
    "/v1/plans",
    { schema: { querystring: ProjectFilterQuery, response: { 200: PlanList } } },
    async (req) => listPlans(db, owner(req).id, req.query.projectId),
  );

  r.get("/v1/plans/:id", { schema: { params: IdParams, response: { 200: Plan } } }, async (req) =>
    getPlan(db, owner(req).id, req.params.id),
  );

  r.post(
    "/v1/plans/:id/decision",
    { schema: { params: IdParams, body: PlanDecisionRequest, response: { 200: Plan } } },
    async (req) =>
      decidePlan(db, { ownerId: owner(req).id, id: req.params.id, body: req.body, correlationId: req.id }),
  );

  r.post("/v1/plans/:id/cancel", { schema: { params: IdParams, response: { 200: Plan } } }, async (req) =>
    cancelPlan(db, { ownerId: owner(req).id, id: req.params.id, correlationId: req.id }),
  );
}
