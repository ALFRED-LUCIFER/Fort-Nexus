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
  ProjectFilterQuery,
  RevenueSummaryResponse,
  SalesSummaryResponse,
  TopProductsResponse,
  UpdateConnectorRequest,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { HttpError } from "../errors.ts";
import { ownerActor } from "../jobs.ts";
import { resolveProject } from "../workspaces.ts";
import {
  createConnector,
  findOwnedConnector,
  getDictionary,
  listConnectors,
  putDictionary,
  testConnector,
  updateConnector,
  type BusinessScope,
  type OwnerScope,
} from "./connectors.ts";
import { getPaymentFailures, getRevenueSummary, getSalesSummary, getTopProducts } from "./metrics.ts";

const IdParams = z.object({ id: z.uuid() });
// Matches no project: an unknown or foreign connector answers NO_CONNECTOR (and is audited) like a missing one.
const NO_PROJECT = "00000000-0000-0000-0000-000000000000";

/** Business connectors and metric tools (EPIC CON/DATA/BIZ). Registered inside the owner scope (session + Origin check). */
export async function businessRoutes(app: FastifyInstance, { db, config }: Deps) {
  const scope = (req: FastifyRequest): OwnerScope => {
    if (!req.owner) throw new HttpError(401, "UNAUTHENTICATED", "Sign in required");
    return {
      db,
      connectorsDir: config.connectorsDir,
      actor: ownerActor(req.owner.id),
      correlationId: req.id,
      ownerId: req.owner.id,
    };
  };
  // MetricQuery names only the connector, so the HTTP tools run in that connector's own project.
  const metricScope = async (req: FastifyRequest, connectorId: string): Promise<BusinessScope> => {
    const s = scope(req);
    return { ...s, projectId: (await findOwnedConnector(s, connectorId))?.projectId ?? NO_PROJECT };
  };

  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/v1/business/connectors",
    { schema: { querystring: ProjectFilterQuery, response: { 200: ConnectorList } } },
    async (req) => {
      const s = scope(req);
      const { projectId } = req.query;
      if (projectId) await resolveProject(db, s.ownerId, projectId, { mode: "BUSINESS" });
      return { items: await listConnectors({ ...s, projectId }) };
    },
  );

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
    async (req) => getSalesSummary(await metricScope(req, req.query.connectorId), req.query),
  );

  r.get(
    "/v1/business/metrics/payment-failures",
    { schema: { querystring: MetricQuery, response: { 200: PaymentFailuresResponse } } },
    async (req) => getPaymentFailures(await metricScope(req, req.query.connectorId), req.query),
  );

  r.get(
    "/v1/business/metrics/revenue",
    { schema: { querystring: MetricQuery, response: { 200: RevenueSummaryResponse } } },
    async (req) => getRevenueSummary(await metricScope(req, req.query.connectorId), req.query),
  );

  r.get(
    "/v1/business/metrics/top-products",
    { schema: { querystring: MetricQuery, response: { 200: TopProductsResponse } } },
    async (req) => getTopProducts(await metricScope(req, req.query.connectorId), req.query),
  );
}
