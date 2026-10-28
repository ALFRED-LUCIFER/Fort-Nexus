import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CreateMonitoredAppRequest,
  HealthCheck,
  HealthCheckList,
  Incident,
  IncidentList,
  IncidentTriage,
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
import { getTriage, triageIncident } from "./triage.ts";

const IdParams = z.object({ id: z.uuid() });

const ctx = (req: FastifyRequest): Ctx => {
  const { id } = owner(req);
  return { ownerId: id, actor: ownerActor(id), correlationId: req.id };
};

/** EPIC MON. Registered inside the owner scope: session required, mutations need a trusted Origin. */
export async function monitoringRoutes(app: FastifyInstance, { db, monitoring, config }: Deps) {
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

  // FR-MON-07: written once per incident (201), then served from the store (200) without calling the model.
  r.post(
    "/v1/incidents/:id/triage",
    { schema: { params: IdParams, response: { 200: IncidentTriage, 201: IncidentTriage } } },
    async (req, reply) => {
      const { created, triage } = await triageIncident(db, config.aiFile, ctx(req), req.params.id);
      reply.code(created ? 201 : 200);
      return triage;
    },
  );

  r.get(
    "/v1/incidents/:id/triage",
    { schema: { params: IdParams, response: { 200: IncidentTriage } } },
    async (req) => getTriage(db, owner(req).id, req.params.id),
  );
}
