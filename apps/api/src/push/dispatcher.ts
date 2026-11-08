import { and, asc, eq, gt, gte, inArray, lt, lte, notExists, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { NotificationPreferences } from "@nexus/contracts";
import { audit } from "../audit.ts";
import type { Db } from "../db/index.ts";
import { notifications, projects, workspaces } from "../db/schema.ts";
import { bypassesQuiet, deepLink, digestPayload, isQuietAt, isUrgent, pushOn } from "./policy.ts";
import { pushDeliveries, pushDevices, type PushDeliveryStatus } from "./schema.ts";
import type { PushResult, PushSender } from "./sender.ts";
import { preferencesOf, skipQueued } from "./service.ts";

// The push outbox (FR-NTF-07/09/10): each tick
//   1. writes one delivery row per (new notification × active device): SKIPPED (category off), HELD (quiet hours) or
//      PENDING. The row's unique keys are the idempotency key: a replayed notification or tick never pushes twice;
//   2. folds a device's HELD rows into one digest push once its quiet hours are over;
//   3. claims due PENDING rows and sends them, retrying 1 m, 5 m, 30 m. A 404/410 retires the device.
// Notifications are already written in their event's transaction (notifications.ts), so this only reads them.

const ACTOR = "system:push";
/** A notification older than this when its device first sees it is news no longer (e.g. after a long outage). */
const RECENT_MS = 60 * 60_000;
/** Claimed but never finished: the process died mid-send. Never resent, because it may have reached the phone. */
const STUCK_MS = 2 * 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const BATCH = 20;
const TTL_SECONDS = { NOTIFICATION: 24 * 3600, DIGEST: 24 * 3600, TEST: 10 * 60 } as const;

export type PushDispatcher = {
  /** One pass now (coalesced with a running one). Resolves when the pass that covers this call is done. */
  tick(): Promise<void>;
  /** Fire-and-forget tick; failures are logged. */
  kick(): void;
  /** Waits for the running pass; no new ones start. */
  close(): Promise<void>;
};

const failureText = (r: Extract<PushResult, { ok: false }>) =>
  r.statusCode === null ? "network error" : `HTTP ${r.statusCode}`;
const retriable = (r: Extract<PushResult, { ok: false }>) =>
  r.statusCode === null || r.statusCode === 429 || r.statusCode >= 500;
const gone = (r: Extract<PushResult, { ok: false }>) => r.statusCode === 404 || r.statusCode === 410;

export function createPushDispatcher(o: {
  db: Db;
  /** null when push keys aren't available: every pass is a no-op. */
  sender: PushSender | null;
  log: FastifyBaseLogger;
  timezone: string;
  now?: () => Date;
}): PushDispatcher {
  const { db, sender, log, timezone } = o;
  const clock = o.now ?? (() => new Date());
  let running: Promise<void> | null = null;
  let again = false;
  let closed = false;

  async function enqueue(now: Date) {
    const rows = await db
      .select({
        id: notifications.id,
        ownerId: notifications.ownerId,
        projectId: notifications.projectId,
        category: notifications.category,
        title: notifications.title,
        body: notifications.body,
        jobId: notifications.jobId,
        incidentId: notifications.incidentId,
        planId: notifications.planId,
        deepDiveId: notifications.deepDiveId,
        researchRunId: notifications.researchRunId,
        deviceId: pushDevices.id,
        mode: workspaces.mode,
      })
      .from(notifications)
      .innerJoin(
        pushDevices,
        and(
          eq(pushDevices.ownerId, notifications.ownerId),
          eq(pushDevices.status, "ACTIVE"),
          gte(notifications.createdAt, pushDevices.activeSince),
        ),
      )
      .leftJoin(projects, eq(projects.id, notifications.projectId))
      .leftJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(
        and(
          gt(notifications.createdAt, new Date(now.getTime() - RECENT_MS)),
          notExists(
            db
              .select({ one: sql`1` })
              .from(pushDeliveries)
              .where(
                and(
                  eq(pushDeliveries.notificationId, notifications.id),
                  eq(pushDeliveries.deviceId, pushDevices.id),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(notifications.id))
      .limit(200);
    if (rows.length === 0) return;
    const prefs = new Map<string, NotificationPreferences>();
    const values = [];
    for (const n of rows) {
      let p = prefs.get(n.ownerId);
      if (!p) prefs.set(n.ownerId, (p = await preferencesOf(db, n.ownerId, timezone)));
      const q = p.quietHours;
      const status: PushDeliveryStatus = !pushOn(p, n.category)
        ? "SKIPPED"
        : isQuietAt(q, now) && !bypassesQuiet(n.category, q)
          ? "HELD"
          : "PENDING";
      values.push({
        deviceId: n.deviceId,
        kind: "NOTIFICATION" as const,
        notificationId: n.id,
        dedupKey: `n:${n.id}`,
        status,
        // Already redacted at write time (FR-CSP-03): title and body, plus where to open it. Nothing else.
        payload: { title: n.title, body: n.body, url: deepLink(n, n.mode), tag: `n-${n.id}` },
        urgent: isUrgent(n.category, q),
        nextAttemptAt: status === "PENDING" ? now : null,
        correlationId: `notification:${n.id}`,
      });
    }
    await db.insert(pushDeliveries).values(values).onConflictDoNothing();
  }

  /** Quiet hours over (or turned off): everything a device held goes out as one digest push. */
  async function digest(now: Date) {
    const devices = await db
      .selectDistinct({ id: pushDevices.id, ownerId: pushDevices.ownerId })
      .from(pushDeliveries)
      .innerJoin(pushDevices, eq(pushDevices.id, pushDeliveries.deviceId))
      .where(and(eq(pushDeliveries.status, "HELD"), eq(pushDevices.status, "ACTIVE")));
    for (const d of devices) {
      const p = await preferencesOf(db, d.ownerId, timezone);
      if (isQuietAt(p.quietHours, now)) continue;
      await db.transaction(async (tx) => {
        const held = await tx
          .select({ id: pushDeliveries.id, payload: pushDeliveries.payload })
          .from(pushDeliveries)
          .where(and(eq(pushDeliveries.deviceId, d.id), eq(pushDeliveries.status, "HELD")))
          .orderBy(asc(pushDeliveries.id))
          .for("update", { skipLocked: true });
        if (held.length === 0) return;
        const key = held[0]!.id;
        const [row] = await tx
          .insert(pushDeliveries)
          .values({
            deviceId: d.id,
            kind: "DIGEST",
            dedupKey: `digest:${key}`,
            status: "PENDING",
            payload: digestPayload(
              held.map((h) => h.payload.title),
              key.replaceAll("-", ""),
            ),
            nextAttemptAt: now,
            correlationId: `digest:${key}`,
          })
          .onConflictDoNothing()
          .returning({ id: pushDeliveries.id });
        if (!row) return;
        await tx
          .update(pushDeliveries)
          .set({ status: "DIGESTED", digestId: row.id })
          .where(
            inArray(
              pushDeliveries.id,
              held.map((h) => h.id),
            ),
          );
      });
    }
  }

  async function send(now: Date, s: PushSender) {
    // Claimed rows move to SENDING in one statement, so two passes (or processes) never send the same row.
    const claimed = await db.transaction(async (tx) => {
      const due = await tx
        .select({ id: pushDeliveries.id })
        .from(pushDeliveries)
        .where(and(eq(pushDeliveries.status, "PENDING"), lte(pushDeliveries.nextAttemptAt, now)))
        .orderBy(asc(pushDeliveries.nextAttemptAt), asc(pushDeliveries.id))
        .limit(BATCH)
        .for("update", { skipLocked: true });
      if (due.length === 0) return [];
      return tx
        .update(pushDeliveries)
        .set({ status: "SENDING", attempts: sql`${pushDeliveries.attempts} + 1`, claimedAt: now })
        .where(
          inArray(
            pushDeliveries.id,
            due.map((r) => r.id),
          ),
        )
        .returning();
    });
    // Devices in parallel, each device's pushes in order: after a 404/410 the rest of its batch is skipped.
    const byDevice = Map.groupBy(claimed, (d) => d.deviceId);
    await Promise.all(
      [...byDevice.values()].map(async (rows) => {
        for (const d of rows) {
          const [device] = await db.select().from(pushDevices).where(eq(pushDevices.id, d.deviceId));
          if (!device || device.status !== "ACTIVE") {
            await db.update(pushDeliveries).set({ status: "SKIPPED" }).where(eq(pushDeliveries.id, d.id));
            continue;
          }
          const result = await s(
            { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
            JSON.stringify(d.payload),
            {
              ttlSeconds: TTL_SECONDS[d.kind],
              urgency: d.urgent ? "high" : "normal",
              topic: d.id.replaceAll("-", ""),
            },
          ).catch((): PushResult => ({ ok: false, statusCode: null }));
          await settle(d, device.id, result, clock());
        }
      }),
    );
  }

  async function settle(d: typeof pushDeliveries.$inferSelect, deviceId: string, r: PushResult, at: Date) {
    const meta = { deliveryId: d.id, kind: d.kind, notificationId: d.notificationId, attempt: d.attempts };
    const entry = {
      actor: ACTOR,
      resourceType: "push_device" as const,
      resourceId: deviceId,
      correlationId: d.correlationId,
    };
    await db.transaction(async (tx) => {
      if (r.ok) {
        await tx
          .update(pushDeliveries)
          .set({ status: "SENT", sentAt: at, lastError: null })
          .where(eq(pushDeliveries.id, d.id));
        await tx
          .update(pushDevices)
          .set({ lastSentAt: at, lastError: null })
          .where(eq(pushDevices.id, deviceId));
        await audit(tx, { ...entry, action: "push.sent", metadata: meta });
        return;
      }
      const error = failureText(r);
      if (gone(r)) {
        await tx
          .update(pushDeliveries)
          .set({ status: "FAILED", lastError: error })
          .where(eq(pushDeliveries.id, d.id));
        await tx
          .update(pushDevices)
          .set({
            status: "GONE",
            updatedAt: at,
            lastFailureAt: at,
            lastError: `The push service no longer knows this subscription (${error}). Turn push on again on the device.`,
          })
          .where(and(eq(pushDevices.id, deviceId), eq(pushDevices.status, "ACTIVE")));
        await skipQueued(tx, deviceId);
        await audit(tx, {
          ...entry,
          action: "push_device.gone",
          outcome: "FAILED",
          metadata: { ...meta, error },
        });
        return;
      }
      const retry = retriable(r) && d.attempts < MAX_ATTEMPTS;
      await tx
        .update(pushDeliveries)
        .set(
          retry
            ? {
                status: "PENDING",
                lastError: error,
                nextAttemptAt: new Date(at.getTime() + BACKOFF_MS[d.attempts - 1]!),
              }
            : { status: "FAILED", lastError: error, nextAttemptAt: null },
        )
        .where(eq(pushDeliveries.id, d.id));
      await tx
        .update(pushDevices)
        .set({ lastFailureAt: at, lastError: `Last push failed (${error})${retry ? "; retrying" : ""}.` })
        .where(eq(pushDevices.id, deviceId));
      await audit(tx, {
        ...entry,
        action: "push.failed",
        outcome: "FAILED",
        metadata: { ...meta, error, retry },
      });
    });
  }

  async function pass() {
    if (!sender) return;
    const now = clock();
    await db
      .update(pushDeliveries)
      .set({ status: "FAILED", lastError: "interrupted while sending; not resent" })
      .where(
        and(
          eq(pushDeliveries.status, "SENDING"),
          lt(pushDeliveries.claimedAt, new Date(now.getTime() - STUCK_MS)),
        ),
      );
    await enqueue(now);
    await digest(now);
    await send(now, sender);
  }

  const tick = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await pass();
        } while (again && !closed);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  return {
    tick,
    kick: () => void tick().catch((err: unknown) => log.error({ err }, "push dispatch failed")),
    async close() {
      closed = true;
      await running?.catch(() => {});
    },
  };
}
