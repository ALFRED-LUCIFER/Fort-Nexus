import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  OwnerSessionList,
  SetDailyBudgetRequest,
  SetEmergencyStopRequest,
  SystemControls,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { listOwnerSessions, revokeOwnerSession } from "../sessions.ts";
import { getSystemControls, setDailyBudget, setEmergencyStop } from "../system.ts";
import { owner } from "./owner.ts";

const SessionParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });

/** Owner safety controls and sessions; registered in the owner scope (session + trusted Origin checks). */
export async function systemRoutes(app: FastifyInstance, deps: Deps) {
  const { db, auth, config } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();
  const controls = () => getSystemControls(db, config.ownerTimezone);

  r.get("/v1/system", { schema: { response: { 200: SystemControls } } }, controls);

  r.put(
    "/v1/system/emergency-stop",
    { schema: { body: SetEmergencyStopRequest, response: { 200: SystemControls } } },
    async (req) => {
      await setEmergencyStop(db, {
        ownerId: owner(req).id,
        engaged: req.body.engaged,
        correlationId: req.id,
      });
      // Approved pushes a crash left unfinished are held while stopped (app.ts); release picks them up.
      if (!req.body.engaged)
        deps.executor
          .reconcile()
          .catch((err: unknown) => req.log.error({ err }, "approval reconciliation failed"));
      return controls();
    },
  );

  r.put(
    "/v1/system/budget",
    { schema: { body: SetDailyBudgetRequest, response: { 200: SystemControls } } },
    async (req) => {
      await setDailyBudget(db, {
        ownerId: owner(req).id,
        dailyCapUsd: req.body.dailyCapUsd,
        correlationId: req.id,
      });
      return controls();
    },
  );

  r.get("/v1/sessions", { schema: { response: { 200: OwnerSessionList } } }, async (req) => {
    const o = owner(req);
    return { items: await listOwnerSessions(auth, o.id, o.sessionId) };
  });

  r.delete("/v1/sessions/:id", { schema: { params: SessionParams } }, async (req, reply) => {
    const o = owner(req);
    const cookies = await revokeOwnerSession(db, auth, {
      userId: o.id,
      sessionId: req.params.id,
      currentSessionId: o.sessionId,
      headers: fromNodeHeaders(req.headers),
      correlationId: req.id,
    });
    if (cookies.length > 0) reply.header("set-cookie", cookies);
    return reply.code(204).send();
  });
}
