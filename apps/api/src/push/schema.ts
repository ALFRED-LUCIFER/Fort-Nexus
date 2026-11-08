import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { NotificationPreferences, PushDeviceStatus, PushPayload, PushService } from "@nexus/contracts";
import { notifications, user } from "../db/schema.ts";

// P1 wave 4 slice A: the owner's push devices, their channel preferences and one delivery row per (notification,
// device). The delivery row is the idempotency key: a replayed notification or a retried tick never pushes twice.

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`);

export const pushDevices = pgTable(
  "push_devices",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    label: text("label").notNull(),
    // The subscription's capability URL and keys: secrets, never logged or returned.
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    service: text("service").$type<PushService>().notNull(),
    status: text("status").$type<PushDeviceStatus>().notNull().default("ACTIVE"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    // When the current subscription started taking notifications: re-subscribing never replays older ones.
    activeSince: ts("active_since").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
    lastSentAt: ts("last_sent_at"),
    lastFailureAt: ts("last_failure_at"),
    lastError: text("last_error"),
  },
  (t) => [
    index("push_devices_owner_idx").on(t.ownerId, t.id),
    check("push_devices_status_valid", sql`${t.status} in ('ACTIVE', 'REVOKED', 'GONE')`),
    check("push_devices_service_valid", sql`${t.service} in ('APPLE', 'GOOGLE', 'MOZILLA', 'MICROSOFT')`),
  ],
);

export const notificationPreferences = pgTable("notification_preferences", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => user.id),
  // Validated by NotificationPreferences on every write.
  categories: jsonb("categories").$type<NotificationPreferences["categories"]>().notNull(),
  quietHours: jsonb("quiet_hours").$type<NotificationPreferences["quietHours"]>().notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type PushDeliveryKind = "NOTIFICATION" | "DIGEST" | "TEST";
export type PushDeliveryStatus =
  // Quiet hours: waits for the digest at their end.
  | "HELD"
  | "PENDING"
  // Claimed by a tick; a row stuck here was interrupted and is never sent again (it may have reached the phone).
  | "SENDING"
  | "SENT"
  | "FAILED"
  // Delivered inside the digest row `digest_id`.
  | "DIGESTED"
  // Never sent: the category's push was off, or the device was revoked/gone first.
  | "SKIPPED";

export const pushDeliveries = pgTable(
  "push_deliveries",
  {
    id: id(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => pushDevices.id),
    kind: text("kind").$type<PushDeliveryKind>().notNull(),
    notificationId: uuid("notification_id").references(() => notifications.id),
    // Per device: `n:<notificationId>`, `digest:<first held delivery id>` or `test:<Idempotency-Key>`.
    dedupKey: text("dedup_key").notNull(),
    status: text("status").$type<PushDeliveryStatus>().notNull(),
    // Built when the row is written, from the redacted notification: a retry sends the same bytes.
    payload: jsonb("payload").$type<PushPayload>().notNull(),
    urgent: boolean("urgent").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    claimedAt: ts("claimed_at"),
    digestId: uuid("digest_id"),
    lastError: text("last_error"),
    correlationId: text("correlation_id").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    sentAt: ts("sent_at"),
  },
  (t) => [
    uniqueIndex("push_deliveries_notification_device_uq").on(t.notificationId, t.deviceId),
    uniqueIndex("push_deliveries_device_dedup_uq").on(t.deviceId, t.dedupKey),
    index("push_deliveries_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'PENDING'`),
    index("push_deliveries_held_idx")
      .on(t.deviceId)
      .where(sql`${t.status} = 'HELD'`),
    check("push_deliveries_kind_valid", sql`${t.kind} in ('NOTIFICATION', 'DIGEST', 'TEST')`),
    check(
      "push_deliveries_status_valid",
      sql`${t.status} in ('HELD', 'PENDING', 'SENDING', 'SENT', 'FAILED', 'DIGESTED', 'SKIPPED')`,
    ),
    check(
      "push_deliveries_notification_kind",
      sql`(${t.kind} = 'NOTIFICATION') = (${t.notificationId} is not null)`,
    ),
    check("push_deliveries_attempts_nonnegative", sql`${t.attempts} >= 0`),
  ],
);
