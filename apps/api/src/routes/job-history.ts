import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AgentPerformance, AgentPerformanceQuery, JobHistoryList, JobHistoryQuery } from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { agentPerformance, jobHistory } from "../job-history.ts";
import { owner } from "./owner.ts";

/** The Jobs page and agent performance (read-only); registered in the owner scope (session checks). */
export async function jobHistoryRoutes(app: FastifyInstance, { db, config }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Static segment: find-my-way matches it before /v1/jobs/:id.
  r.get(
    "/v1/jobs/history",
    { schema: { querystring: JobHistoryQuery, response: { 200: JobHistoryList } } },
    async (req) => jobHistory(db, owner(req).id, config.ownerTimezone, req.query),
  );

  r.get(
    "/v1/agents/performance",
    { schema: { querystring: AgentPerformanceQuery, response: { 200: AgentPerformance } } },
    async (req) => agentPerformance(db, owner(req).id, config.ownerTimezone, req.query),
  );
}
