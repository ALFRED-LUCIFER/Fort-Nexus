import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AgentKey,
  AgentList,
  AgentProfileVersion,
  AgentProfileVersionList,
  SetAgentProfileRequest,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { owner } from "../routes/owner.ts";
import { listAgents, listVersions, setAgentProfile } from "./service.ts";

// Profiles resolve per project, so reads need one.
const ProjectQuery = z.object({ projectId: z.uuid() });
const AgentParams = z.object({ agent: AgentKey });

/** EPIC AGT registry. Registered inside the owner scope: session required, mutations need a trusted Origin. */
export async function agentRoutes(app: FastifyInstance, { db }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/v1/agents", { schema: { querystring: ProjectQuery, response: { 200: AgentList } } }, async (req) =>
    listAgents(db, owner(req).id, req.query.projectId),
  );

  r.get(
    "/v1/agents/:agent/versions",
    {
      schema: { params: AgentParams, querystring: ProjectQuery, response: { 200: AgentProfileVersionList } },
    },
    async (req) => ({ items: await listVersions(db, owner(req).id, req.query.projectId, req.params.agent) }),
  );

  r.put(
    "/v1/agents/:agent/profile",
    { schema: { params: AgentParams, body: SetAgentProfileRequest, response: { 200: AgentProfileVersion } } },
    async (req) =>
      setAgentProfile(db, {
        ownerId: owner(req).id,
        agent: req.params.agent,
        body: req.body,
        correlationId: req.id,
      }),
  );
}
