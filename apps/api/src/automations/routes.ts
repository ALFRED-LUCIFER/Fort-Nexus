import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AutomationClient,
  AutomationClientList,
  AutomationClientSecret,
  AutomationRunList,
  CreateAutomationClientRequest,
  ProjectFilterQuery,
  TriggerResponse,
  UpdateAutomationClientRequest,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { owner } from "../routes/owner.ts";
import {
  clientRateLimiter,
  createClient,
  listClients,
  listRuns,
  rotateClient,
  trigger,
  updateClient,
} from "./service.ts";

const IdParams = z.object({ id: z.uuid() });
const TRIGGER_BODY_LIMIT = 64 * 1024;

const ctx = (req: FastifyRequest) => ({ ownerId: owner(req).id, correlationId: req.id });

/** EPIC AUTO owner API. Registered inside the owner scope: session required, mutations need a trusted Origin. */
export async function automationRoutes(app: FastifyInstance, { db, config }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/v1/automations/clients",
    { schema: { querystring: ProjectFilterQuery, response: { 200: AutomationClientList } } },
    async (req) => ({ items: await listClients(db, owner(req).id, req.query.projectId) }),
  );

  r.post(
    "/v1/automations/clients",
    { schema: { body: CreateAutomationClientRequest, response: { 201: AutomationClientSecret } } },
    async (req, reply) => {
      reply.code(201);
      return createClient(db, config.authSecret, ctx(req), req.body);
    },
  );

  r.patch(
    "/v1/automations/clients/:id",
    {
      schema: { params: IdParams, body: UpdateAutomationClientRequest, response: { 200: AutomationClient } },
    },
    async (req) => updateClient(db, ctx(req), req.params.id, req.body),
  );

  r.post(
    "/v1/automations/clients/:id/rotate",
    { schema: { params: IdParams, response: { 200: AutomationClientSecret } } },
    async (req) => rotateClient(db, config.authSecret, ctx(req), req.params.id),
  );

  r.get(
    "/v1/automations/runs",
    {
      schema: {
        querystring: ProjectFilterQuery.extend({ clientId: z.uuid().optional() }),
        response: { 200: AutomationRunList },
      },
    },
    async (req) => ({ items: await listRuns(db, owner(req).id, req.query) }),
  );
}

/**
 * n8n's service route, in its own scope outside the owner session: the body stays raw bytes so the HMAC is checked
 * over exactly what was signed, before anything is parsed (AUTO-G02).
 */
export async function automationTriggerRoute(app: FastifyInstance, deps: Deps) {
  const allow = clientRateLimiter();
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/v1/automations/trigger",
      { bodyLimit: TRIGGER_BODY_LIMIT, schema: { response: { 202: TriggerResponse } } },
      async (req, reply) => {
        const result = await trigger(deps, allow, {
          raw: req.body instanceof Buffer ? req.body : Buffer.alloc(0),
          headers: req.headers,
          correlationId: req.id,
          log: req.log,
        });
        reply.code(202);
        return result;
      },
    );
}
