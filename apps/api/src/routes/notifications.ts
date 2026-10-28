import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ListNotificationsQuery,
  Notification,
  NotificationList,
  SetNotificationStatusRequest,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { listNotifications, setNotificationStatus } from "../notifications.ts";
import { owner } from "./owner.ts";

/** In-app inbox (FR-NTF-02, FR-INB-01); registered in the owner scope (session + trusted Origin checks). */
export async function notificationRoutes(app: FastifyInstance, { db }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/v1/notifications",
    { schema: { querystring: ListNotificationsQuery, response: { 200: NotificationList } } },
    async (req) => listNotifications(db, owner(req).id, req.query),
  );

  r.post(
    "/v1/notifications/:id/status",
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        body: SetNotificationStatusRequest,
        response: { 200: Notification },
      },
    },
    async (req) =>
      setNotificationStatus(db, {
        ownerId: owner(req).id,
        id: req.params.id,
        body: req.body,
        correlationId: req.id,
      }),
  );
}
