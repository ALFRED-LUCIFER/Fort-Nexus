import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  NotificationPreferences,
  PushDevice,
  PushDeviceList,
  SubscribePushRequest,
  TestPushResponse,
  UpdateNotificationPreferencesRequest,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { HttpError } from "../errors.ts";
import { owner } from "../routes/owner.ts";
import {
  listDevices,
  preferencesOf,
  queueTestPush,
  revokeDevice,
  subscribeDevice,
  updatePreferences,
} from "./service.ts";

const IdParams = z.object({ id: z.uuid() });

/** Push devices and notification preferences, inside the owner scope (session + trusted Origin on mutations). */
export async function pushRoutes(app: FastifyInstance, deps: Deps) {
  const { db, push } = deps;
  const ctx = (req: FastifyRequest) => ({ ownerId: owner(req).id, correlationId: req.id });
  const r = app.withTypeProvider<ZodTypeProvider>();
  const requireKeys = () => {
    if (!push.publicKey)
      throw new HttpError(409, "CONFLICT", push.problem ?? "Push isn't available on the home machine", {
        reason: "push_unavailable",
      });
  };

  r.get("/v1/devices", { schema: { response: { 200: PushDeviceList } } }, async (req) => ({
    vapidPublicKey: push.publicKey,
    problem: push.problem,
    items: await listDevices(db, owner(req).id),
  }));

  r.post(
    "/v1/devices",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { body: SubscribePushRequest, response: { 200: PushDevice, 201: PushDevice } },
    },
    async (req, reply) => {
      requireKeys();
      const { device, created } = await subscribeDevice(db, ctx(req), req.body);
      reply.code(created ? 201 : 200);
      return device;
    },
  );

  r.delete("/v1/devices/:id", { schema: { params: IdParams, response: { 200: PushDevice } } }, async (req) =>
    revokeDevice(db, ctx(req), req.params.id),
  );

  // A real push to a real phone: a few a minute is plenty.
  r.post(
    "/v1/devices/:id/test",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        params: IdParams,
        headers: z.object({ [IDEMPOTENCY_HEADER]: IdempotencyKey }),
        response: { 202: TestPushResponse },
      },
    },
    async (req, reply) => {
      requireKeys();
      const queued = await queueTestPush(db, ctx(req), req.params.id, req.headers[IDEMPOTENCY_HEADER]);
      push.dispatcher.kick();
      reply.code(202);
      return queued;
    },
  );

  r.get(
    "/v1/notification-preferences",
    { schema: { response: { 200: NotificationPreferences } } },
    async (req) => preferencesOf(db, owner(req).id, deps.config.ownerTimezone),
  );

  r.put(
    "/v1/notification-preferences",
    { schema: { body: UpdateNotificationPreferencesRequest, response: { 200: NotificationPreferences } } },
    async (req) => updatePreferences(db, ctx(req), req.body),
  );
}
