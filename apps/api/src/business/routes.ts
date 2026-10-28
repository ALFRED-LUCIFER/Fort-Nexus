import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ConnectionTestResult,
  Connector,
  ConnectorList,
  CreateConnectorRequest,
  MetricDictionary,
  MetricQuery,
  PaymentFailuresResponse,
  SalesSummaryResponse,
  UpdateConnectorRequest,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { HttpError } from "../errors.ts";
import { ownerActor } from "../jobs.ts";
import { projectScope } from "../scope.ts";
import {
  createConnector,
  getDictionary,
  listConnectors,
  putDictionary,
  testConnector,
  updateConnector,
  type BusinessScope,
} from "./connectors.ts";
import { getPaymentFailures, getSalesSummary } from "./metrics.ts";

const IdParams = z.object({ id: z.uuid() });

/** Business connectors and metric tools (EPIC CON/DATA/BIZ). Registered inside the owner scope (session + Origin check). */
export async function businessRoutes(app: FastifyInstance, { db, config }: Deps) {
  const scope = (req: FastifyRequest): BusinessScope => {
    if (!req.owner) throw new HttpError(401, "UNAUTHENTICATED", "Sign in required");
    return {
      ...projectScope(),
      db,
      connectorsDir: config.connectorsDir,
      actor: ownerActor(req.owner.id),
      correlationId: req.id,
    };
  };

  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/v1/business/connectors", { schema: { response: { 200: ConnectorList } } }, async (req) => ({
    items: await listConnectors(scope(req)),
  }));

  r.post(
    "/v1/business/connectors",
    { schema: { body: CreateConnectorRequest, response: { 201: Connector } } },
    async (req, reply) => {
      reply.code(201);
      return createConnector(scope(req), req.body);
    },
  );

  r.patch(
    "/v1/business/connectors/:id",
    { schema: { params: IdParams, body: UpdateConnectorRequest, response: { 200: Connector } } },
    async (req) => updateConnector(scope(req), req.params.id, req.body),
  );

  // Opens a connection to the source: rate-limited like sign-in.
  r.post(
    "/v1/business/connectors/:id/test",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { params: IdParams, response: { 200: ConnectionTestResult } },
    },
    async (req) => testConnector(scope(req), req.params.id),
  );

  r.get(
    "/v1/business/connectors/:id/dictionary",
    { schema: { params: IdParams, response: { 200: MetricDictionary } } },
    async (req) => getDictionary(scope(req), req.params.id),
  );

  r.put(
    "/v1/business/connectors/:id/dictionary",
    { schema: { params: IdParams, body: MetricDictionary, response: { 200: MetricDictionary } } },
    async (req) => putDictionary(scope(req), req.params.id, req.body),
  );

  r.get(
    "/v1/business/metrics/sales-summary",
    { schema: { querystring: MetricQuery, response: { 200: SalesSummaryResponse } } },
    async (req) => getSalesSummary(scope(req), req.query),
  );

  r.get(
    "/v1/business/metrics/payment-failures",
    { schema: { querystring: MetricQuery, response: { 200: PaymentFailuresResponse } } },
    async (req) => getPaymentFailures(scope(req), req.query),
  );
}
