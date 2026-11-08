import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  NotificationCategory,
  defaultNotificationPreferences,
  pushServiceOf,
  type NotificationPreferences,
  type PushDevice,
  type SubscribePushRequest,
  type TestPushResponse,
} from "@nexus/contracts";
import { audit } from "../audit.ts";
import type { Db, Tx } from "../db/index.ts";
import { HttpError, notFound } from "../errors.ts";
import { ownerActor } from "../jobs.ts";
import { TEST_PAYLOAD } from "./policy.ts";
import { notificationPreferences, pushDeliveries, pushDevices } from "./schema.ts";

// Devices (explicit opt-in per browser) and the owner's channel preferences. Every change is audited with ids and
// enums only: never an endpoint or key.

export type Ctx = { ownerId: string; correlationId: string };
type DeviceRow = typeof pushDevices.$inferSelect;

export const endpointHash = (endpoint: string) =>
  createHash("sha256").update(endpoint).digest("hex").slice(0, 16);

export const toPushDeviceDto = (d: DeviceRow): PushDevice => ({
  id: d.id,
  label: d.label,
  service: d.service,
  status: d.status,
  endpointHash: endpointHash(d.endpoint),
  createdAt: d.createdAt.toISOString(),
  lastSentAt: d.lastSentAt?.toISOString() ?? null,
  lastFailureAt: d.lastFailureAt?.toISOString() ?? null,
  lastError: d.lastError,
});

export async function listDevices(db: Db, ownerId: string): Promise<PushDevice[]> {
  const rows = await db
    .select()
    .from(pushDevices)
    .where(eq(pushDevices.ownerId, ownerId))
    .orderBy(desc(pushDevices.id));
  return rows.map(toPushDeviceDto);
}

/**
 * Upsert by endpoint: subscribing the same browser again renames it and refreshes its keys; a revoked or gone one
 * becomes active again and only takes notifications from now on.
 */
export async function subscribeDevice(
  db: Db,
  ctx: Ctx,
  body: SubscribePushRequest,
  retry = true,
): Promise<{ device: PushDevice; created: boolean }> {
  const { endpoint, keys } = body.subscription;
  const service = pushServiceOf(endpoint);
  if (!service) throw new HttpError(400, "VALIDATION_FAILED", "Not a known browser push service");
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.endpoint, endpoint))
      .for("update");
    if (existing && existing.ownerId !== ctx.ownerId)
      throw new HttpError(409, "CONFLICT", "This browser's push subscription belongs to another account");
    const now = new Date();
    const reactivated = existing !== undefined && existing.status !== "ACTIVE";
    const [row] = existing
      ? await tx
          .update(pushDevices)
          .set({
            label: body.label,
            p256dh: keys.p256dh,
            auth: keys.auth,
            service,
            status: "ACTIVE",
            updatedAt: now,
            ...(reactivated ? { activeSince: now, revokedAt: null, lastError: null } : {}),
          })
          .where(eq(pushDevices.id, existing.id))
          .returning()
      : await tx
          .insert(pushDevices)
          .values({
            ownerId: ctx.ownerId,
            label: body.label,
            endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth,
            service,
          })
          .onConflictDoNothing({ target: pushDevices.endpoint })
          .returning();
    if (!row) return null; // a concurrent subscribe of the same browser won: update that one instead
    await audit(tx, {
      actor: ownerActor(ctx.ownerId),
      action: existing
        ? reactivated
          ? "push_device.reactivate"
          : "push_device.update"
        : "push_device.subscribe",
      resourceType: "push_device",
      resourceId: row.id,
      correlationId: ctx.correlationId,
      metadata: { service },
    });
    return { device: toPushDeviceDto(row), created: !existing };
  });
  if (result) return result;
  if (retry) return subscribeDevice(db, ctx, body, false);
  throw new HttpError(409, "CONFLICT", "This browser was being subscribed twice at once. Try again.");
}

/** Nothing queued for it is sent any more: held or pending deliveries are skipped in the same transaction. */
export async function skipQueued(tx: Tx, deviceId: string) {
  await tx
    .update(pushDeliveries)
    .set({ status: "SKIPPED", nextAttemptAt: null })
    .where(and(eq(pushDeliveries.deviceId, deviceId), inArray(pushDeliveries.status, ["HELD", "PENDING"])));
}

/** DELETE /v1/devices/:id. Revoking twice is a no-op. The browser drops its own subscription (web). */
export async function revokeDevice(db: Db, ctx: Ctx, id: string): Promise<PushDevice> {
  return db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(pushDevices)
      .where(and(eq(pushDevices.id, id), eq(pushDevices.ownerId, ctx.ownerId)))
      .for("update");
    if (!d) throw notFound("Device");
    if (d.status === "REVOKED") return toPushDeviceDto(d);
    const now = new Date();
    const [row] = await tx
      .update(pushDevices)
      .set({ status: "REVOKED", revokedAt: now, updatedAt: now })
      .where(eq(pushDevices.id, d.id))
      .returning();
    await skipQueued(tx, d.id);
    await audit(tx, {
      actor: ownerActor(ctx.ownerId),
      action: "push_device.revoke",
      resourceType: "push_device",
      resourceId: d.id,
      correlationId: ctx.correlationId,
      metadata: { from: d.status, service: d.service },
    });
    return toPushDeviceDto(row!);
  });
}

/** POST /v1/devices/:id/test: one test push per Idempotency-Key; a repeat returns the first one's delivery. */
export async function queueTestPush(
  db: Db,
  ctx: Ctx,
  id: string,
  idempotencyKey: string,
): Promise<TestPushResponse> {
  return db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(pushDevices)
      .where(and(eq(pushDevices.id, id), eq(pushDevices.ownerId, ctx.ownerId)));
    if (!d) throw notFound("Device");
    const dedupKey = `test:${idempotencyKey}`;
    const [existing] = await tx
      .select()
      .from(pushDeliveries)
      .where(and(eq(pushDeliveries.deviceId, d.id), eq(pushDeliveries.dedupKey, dedupKey)));
    if (existing) return toTestResponse(existing);
    if (d.status !== "ACTIVE")
      throw new HttpError(409, "CONFLICT", "This device no longer takes pushes. Turn push on again on it.", {
        reason: "device_inactive",
      });
    const [row] = await tx
      .insert(pushDeliveries)
      .values({
        deviceId: d.id,
        kind: "TEST",
        dedupKey,
        status: "PENDING",
        payload: TEST_PAYLOAD(d.label),
        nextAttemptAt: new Date(),
        correlationId: ctx.correlationId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      // The same key in a concurrent request: answer with that request's delivery.
      const [first] = await tx
        .select()
        .from(pushDeliveries)
        .where(and(eq(pushDeliveries.deviceId, d.id), eq(pushDeliveries.dedupKey, dedupKey)));
      return toTestResponse(first!);
    }
    await audit(tx, {
      actor: ownerActor(ctx.ownerId),
      action: "push_device.test",
      resourceType: "push_device",
      resourceId: d.id,
      correlationId: ctx.correlationId,
      metadata: { deliveryId: row.id },
    });
    return toTestResponse(row);
  });
}

const toTestResponse = (r: typeof pushDeliveries.$inferSelect): TestPushResponse => ({
  deliveryId: r.id,
  // HELD/DIGESTED/SKIPPED never happen to a test push; a revoke between queue and send skips it, which is FAILED here.
  status: r.status === "PENDING" || r.status === "SENDING" || r.status === "SENT" ? r.status : "FAILED",
});

// ── Preferences ──

export async function preferencesOf(
  db: Db | Tx,
  ownerId: string,
  timezone: string,
): Promise<NotificationPreferences> {
  const [row] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.ownerId, ownerId));
  return row
    ? { categories: row.categories, quietHours: row.quietHours }
    : defaultNotificationPreferences(timezone);
}

/** Categories the owner hid from the Inbox (never APPROVAL_REQUIRED or SECURITY_CRITICAL: the contract refuses). */
export async function hiddenInApp(db: Db, ownerId: string): Promise<NotificationCategory[]> {
  const [row] = await db
    .select({ categories: notificationPreferences.categories })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.ownerId, ownerId));
  return row ? NotificationCategory.options.filter((c) => row.categories[c]?.inApp === false) : [];
}

export async function updatePreferences(
  db: Db,
  ctx: Ctx,
  body: NotificationPreferences,
): Promise<NotificationPreferences> {
  return db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .insert(notificationPreferences)
      .values({
        ownerId: ctx.ownerId,
        categories: body.categories,
        quietHours: body.quietHours,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: notificationPreferences.ownerId,
        set: { categories: body.categories, quietHours: body.quietHours, updatedAt: now },
      });
    const off = (ch: "inApp" | "push") => NotificationCategory.options.filter((c) => !body.categories[c][ch]);
    await audit(tx, {
      actor: ownerActor(ctx.ownerId),
      action: "notification_preferences.update",
      resourceType: "notification_preferences",
      resourceId: ctx.ownerId,
      correlationId: ctx.correlationId,
      metadata: {
        pushOff: off("push"),
        inAppOff: off("inApp"),
        quietHours: body.quietHours.enabled ? `${body.quietHours.start}-${body.quietHours.end}` : "off",
        timezone: body.quietHours.timezone,
        urgentBypass: body.quietHours.urgentBypass,
        approvalsUrgent: body.quietHours.approvalsUrgent,
      },
    });
    return body;
  });
}
