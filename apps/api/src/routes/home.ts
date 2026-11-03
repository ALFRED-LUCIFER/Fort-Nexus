import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { HomeQuery, HomeSummary } from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { homeSummary } from "../home.ts";
import { owner } from "./owner.ts";

/** The Cofounder home (read-only); registered in the owner scope (session checks). */
export async function homeRoutes(app: FastifyInstance, { db, config }: Deps) {
  app
    .withTypeProvider<ZodTypeProvider>()
    .get("/v1/home", { schema: { querystring: HomeQuery, response: { 200: HomeSummary } } }, async (req) =>
      homeSummary(db, owner(req).id, config.ownerTimezone, req.query),
    );
}
