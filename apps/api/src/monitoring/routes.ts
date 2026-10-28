import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CreateMonitoredAppRequest,
  HealthCheck,
  HealthCheckList,
  Incident,
  IncidentList,
  ListIncidentsQuery,
  MonitoredApp,
  MonitoredAppList,
  ProjectFilterQuery,
  SetIncidentStatusRequest,
  UpdateMonitoredAppRequest,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { ownerActor } from "../jobs.ts";
import { owner } from "../routes/owner.ts";
import {
  createApp,
  getIncident,
  listApps,
  listChecks,
  listIncidents,
  setIncidentStatus,
  updateApp,
  type Ctx,
} from "./service.ts";

const IdParams = z.object({ id: z.uuid() });

const ctx = (req: FastifyRequest): Ctx => {
  const { id } = owner(req);
  return { ownerId: id, actor: ownerActor(id), correlationId: req.id };
};

/** EPIC MON. Registered inside the owner scope: session required, mutations need a trusted Origin. */
export async function monitoringRoutes(app: FastifyInstance, { db, monitoring }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/v1/monitoring/apps",
    { schema: { querystring: ProjectFilterQuery, response: { 200: MonitoredAppList } } },
    async (req) => ({ items: await listApps(db, owner(req).id, req.query.projectId) }),
  );

  r.post(
    "/v1/monitoring/apps",
    { schema: { body: CreateMonitoredAppRequest, response: { 201: MonitoredApp } } },
    async (req, reply) => {
      reply.code(201);
      return createApp(db, ctx(req), req.body);
    },
  );

  r.patch(
    "/v1/monitoring/apps/:id",
    { schema: { params: IdParams, body: UpdateMonitoredAppRequest, response: { 200: MonitoredApp } } },
    async (req) => updateApp(db, ctx(req), req.params.id, req.body),
  );

  // Each manual check is an outbound request from the home host: rate-limited per client.
  r.post(
    "/v1/monitoring/apps/:id/check",
    {
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
      schema: { params: IdParams, response: { 200: HealthCheck } },
    },
    async (req) => monitoring.check(ctx(req), req.params.id),
  );

  r.get(
    "/v1/monitoring/apps/:id/checks",
    { schema: { params: IdParams, response: { 200: HealthCheckList } } },
    async (req) => ({ items: await listChecks(db, owner(req).id, req.params.id) }),
  );

  r.get(
    "/v1/incidents",
    { schema: { querystring: ListIncidentsQuery, response: { 200: IncidentList } } },
    async (req) => ({ items: await listIncidents(db, owner(req).id, req.query) }),
  );

  r.get("/v1/incidents/:id", { schema: { params: IdParams, response: { 200: Incident } } }, async (req) =>
    getIncident(db, owner(req).id, req.params.id),
  );

  r.post(
    "/v1/incidents/:id/status",
    { schema: { params: IdParams, body: SetIncidentStatusRequest, response: { 200: Incident } } },
    async (req) => setIncidentStatus(db, ctx(req), req.params.id, req.body.status),
  );
}
