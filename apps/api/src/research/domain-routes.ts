import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  PutResearchDomainRequest,
  ResearchDomain,
  ResearchDomainList,
  SearchProviderStatus,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { ownerActor } from "../jobs.ts";
import { owner } from "../routes/owner.ts";
import { deleteDomain, listDomains, putDomain } from "./domains.ts";
import { searchProviderStatus } from "./web/search.ts";

/** The owner's source registry and the search-provider status. Registered inside the owner scope. */
export async function researchDomainRoutes(
  app: FastifyInstance,
  { db, config }: Pick<Deps, "db" | "config">,
) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const ctx = (id: string, correlationId: string) => ({ ownerId: id, actor: ownerActor(id), correlationId });

  r.get(
    "/v1/research/domains",
    {
      schema: {
        querystring: z.object({ workspaceId: z.uuid() }),
        response: { 200: ResearchDomainList },
      },
    },
    async (req) => ({ items: await listDomains(db, owner(req).id, req.query.workspaceId) }),
  );

  r.put(
    "/v1/research/domains",
    { schema: { body: PutResearchDomainRequest, response: { 200: ResearchDomain } } },
    async (req) => putDomain(db, ctx(owner(req).id, req.id), req.body),
  );

  r.delete(
    "/v1/research/domains/:id",
    { schema: { params: z.object({ id: z.uuid() }) } },
    async (req, reply) => {
      await deleteDomain(db, ctx(owner(req).id, req.id), req.params.id);
      return reply.code(204).send();
    },
  );

  r.get("/v1/research/search-provider", { schema: { response: { 200: SearchProviderStatus } } }, async () =>
    searchProviderStatus(config.searchFile),
  );
}
