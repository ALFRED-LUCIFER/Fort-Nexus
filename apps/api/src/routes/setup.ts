import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { SetupQuery, SetupStatus } from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { setupStatus } from "../setup.ts";
import { owner } from "./owner.ts";

/** GET /v1/setup: what NEXUS still needs before it can work. Registered inside the owner scope. */
export async function setupRoutes(app: FastifyInstance, deps: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/v1/setup", { schema: { querystring: SetupQuery, response: { 200: SetupStatus } } }, async (req) =>
    setupStatus(deps, owner(req).id, req.query.projectId),
  );
}
