import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PushPayload, defaultNotificationPreferences, type NotificationPreferences } from "@nexus/contracts";
import { createDb, runMigrations, type Db } from "../src/db/index.ts";
import { auditRecords, jobs, notifications, projects, user, workspaces } from "../src/db/schema.ts";
import { notifyForJobEvents, notifySecurity } from "../src/notifications.ts";
import { createPushDispatcher } from "../src/push/dispatcher.ts";
import { notificationPreferences, pushDeliveries, pushDevices } from "../src/push/schema.ts";
import type { PushOptions, PushResult, PushSender, PushTarget } from "../src/push/sender.ts";
import { freshDatabaseUrl } from "./helpers/owner-session.ts";

// Slice A's outbox on its own database (no app, so no second dispatcher ticking on the real clock). The push service
// is a fake that records each send and answers what the test scripts; nothing reaches Apple/Google/Mozilla.

let db: Db;
let pool: { end(): Promise<void> };
let ownerId: string;
let projectId: string;

type Sent = { target: PushTarget; payload: PushPayload; o: PushOptions };
const sent: Sent[] = [];
let answers: PushResult[] = [];
const sender: PushSender = async (target, payload, o) => {
  sent.push({ target, payload: PushPayload.strict().parse(JSON.parse(payload)), o });
  return answers.shift() ?? { ok: true };
};
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;
let clock: Date;
const dispatcher = (now?: () => Date) =>
  createPushDispatcher({ db, sender, log, timezone: "Asia/Dubai", ...(now ? { now } : {}) });
const fixed = () => dispatcher(() => clock);

async function device(activeSince = new Date(Date.now() - 60_000)) {
  const [d] = await db
    .insert(pushDevices)
    .values({
      ownerId,
      label: "Alfred's iPhone",
      endpoint: `https://web.push.apple.com/${randomBytes(24).toString("base64url")}`,
      p256dh: randomBytes(65).toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
      service: "APPLE",
      activeSince,
    })
    .returning();
  return d!;
}

async function notice(over: Partial<typeof notifications.$inferInsert> = {}) {
  const [n] = await db
    .insert(notifications)
    .values({
      ownerId,
      projectId,
      category: "TASK_FAILED",
      title: `Run failed · ${randomBytes(3).toString("hex")}`,
      body: "The runner shut down during the run. Restart the runner, then start a new run.",
      dedupKey: randomUUID(),
      ...over,
    })
    .returning();
  return n!;
}

async function setPrefs(p: NotificationPreferences) {
  await db
    .insert(notificationPreferences)
    .values({ ownerId, ...p })
    .onConflictDoUpdate({ target: notificationPreferences.ownerId, set: p });
}

const deliveriesOf = (deviceId: string) =>
  db.select().from(pushDeliveries).where(eq(pushDeliveries.deviceId, deviceId)).orderBy(pushDeliveries.id);
const sentTo = (deviceId: string, devices: Map<string, string>) =>
  sent.filter((s) => devices.get(s.target.endpoint) === deviceId);

beforeAll(async () => {
  ({ db, pool } = createDb(await freshDatabaseUrl()));
  await runMigrations(db);
});
afterAll(async () => {
  await pool?.end();
});
beforeEach(async () => {
  sent.length = 0;
  answers = [];
  // A fresh owner per test, and earlier tests' devices retired: the dispatcher serves every owner, so whatever an
  // earlier test left queued (on its own clock) must not be sent here.
  await db.update(pushDevices).set({ status: "REVOKED" });
  await db
    .update(pushDeliveries)
    .set({ status: "SKIPPED" })
    .where(inArray(pushDeliveries.status, ["HELD", "PENDING"]));
  ownerId = randomUUID();
  await db.insert(user).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.com` });
  const [ws] = await db.insert(workspaces).values({ ownerId, mode: "DEV", name: "Dev" }).returning();
  const [p] = await db
    .insert(projects)
    .values({ workspaceId: ws!.id, slug: "home", name: "Home" })
    .returning();
  projectId = p!.id;
});

describe("@NTF-G07 a finished run reaches the phone once, redacted", () => {
  it("pushes one notification per device however often the event and the outbox are replayed", async () => {
    const d = await device();
    const [job] = await db
      .insert(jobs)
      .values({
        initiatorId: ownerId,
        projectId,
        jobType: "RUNNER_DIAGNOSTIC",
        status: "COMPLETED",
        riskTier: "R0",
        request: { jobType: "RUNNER_DIAGNOSTIC", preset: "node-version", projectId },
        requestHash: "h",
        idempotencyKey: randomUUID(),
        agent: "DEVOPS",
      })
      .returning();
    const completed = [
      { type: "job.state.changed" as const, payload: { to: "COMPLETED", outcome: "COMMAND_SUCCEEDED" } },
    ];
    const push = dispatcher();
    // The event is delivered twice and the outbox replayed twice (two passes and one concurrent kick).
    await db.transaction((tx) => notifyForJobEvents(tx, job!.id, completed));
    await push.tick();
    await db.transaction((tx) => notifyForJobEvents(tx, job!.id, completed));
    await Promise.all([push.tick(), push.tick()]);
    await push.tick();

    expect(sent).toHaveLength(1);
    const [s] = sent;
    expect(s!.target.endpoint).toBe(d.endpoint);
    // Title and body as the Inbox has them (already redacted at write time), the run's deep link, nothing else.
    expect(Object.keys(s!.payload).sort()).toEqual(["body", "tag", "title", "url"]);
    expect(s!.payload.title).toBe("Finished · node-version diagnostic");
    expect(s!.payload.body).toBe("The command succeeded. Open the run for its output.");
    expect(s!.payload.url).toBe(`/?ws=dev&project=${projectId}&drawer=run%3A${job!.id}`);
    expect(s!.o).toMatchObject({ urgency: "normal", ttlSeconds: 86_400 });
    expect(s!.o.topic).toMatch(/^[0-9a-f]{32}$/);

    const [row] = await deliveriesOf(d.id);
    expect(row).toMatchObject({ kind: "NOTIFICATION", status: "SENT", attempts: 1 });
    const audits = await db.select().from(auditRecords).where(eq(auditRecords.resourceId, d.id));
    expect(audits.map((a) => a.action)).toEqual(["push.sent"]);
    expect(audits[0]!.correlationId).toBe(`notification:${row!.notificationId}`);
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain(d.endpoint);
  });

  it("sends nothing for a category the owner switched off, and nothing from before the device subscribed", async () => {
    const prefs = defaultNotificationPreferences("Asia/Dubai");
    prefs.categories.TASK_FAILED.push = false;
    await setPrefs(prefs);
    await notice({ createdAt: new Date(Date.now() - 10 * 60_000) });
    const d = await device(new Date(Date.now() - 60_000));
    await notice({ category: "TASK_FAILED" });
    const done = await notice({ category: "TASK_DONE", title: "Finished · run" });
    await dispatcher().tick();

    expect(sent.map((s) => s.payload.title)).toEqual(["Finished · run"]);
    const rows = await deliveriesOf(d.id);
    expect(rows.map((r) => [r.notificationId === done.id ? "done" : "failed", r.status])).toEqual([
      ["failed", "SKIPPED"],
      ["done", "SENT"],
    ]);
  });

  it("sends a security notice with high urgency, and every active device gets its own copy", async () => {
    const a = await device();
    const b = await device();
    await db.transaction((tx) =>
      notifySecurity(tx, {
        ownerId,
        dedupKey: `stop:${randomUUID()}`,
        title: "Emergency stop engaged",
        body: "No new work starts.",
      }),
    );
    await dispatcher().tick();
    expect(sent.map((s) => s.target.endpoint).sort()).toEqual([a.endpoint, b.endpoint].sort());
    expect(sent.every((s) => s.o.urgency === "high" && s.payload.url === "/?drawer=inbox")).toBe(true);
  });
});

describe("@NTF-G09 quiet hours hold pushes until the digest", () => {
  // 23:10 in Dubai (UTC+4, no daylight saving) on a fixed day.
  const at = (hhmm: string, day = 9) => {
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(Date.UTC(2026, 10, day, h! - 4, m!));
  };
  const quiet = (over: Partial<NotificationPreferences["quietHours"]> = {}) => {
    const p = defaultNotificationPreferences("Asia/Dubai");
    p.quietHours = {
      ...p.quietHours,
      enabled: true,
      start: "22:00",
      end: "07:00",
      urgentBypass: false,
      ...over,
    };
    return p;
  };

  it("holds two failures at 23:10 and sends one digest listing both at 07:00", async () => {
    await setPrefs(quiet());
    clock = at("23:10");
    const d = await device(at("21:00"));
    const map = new Map([[d.endpoint, d.id]]);
    const first = await notice({ createdAt: at("23:10"), title: "Run failed · tts-test#1" });
    const second = await notice({ createdAt: at("23:10"), title: "Run failed · tts-test#3" });
    const push = fixed();
    await push.tick();
    expect(sent).toHaveLength(0);
    expect((await deliveriesOf(d.id)).map((r) => r.status)).toEqual(["HELD", "HELD"]);

    clock = at("06:59", 10);
    await push.tick();
    expect(sent).toHaveLength(0);

    clock = at("07:00", 10);
    await push.tick();
    await push.tick();
    expect(sentTo(d.id, map)).toHaveLength(1);
    const digest = sent[0]!.payload;
    expect(digest.title).toBe("While you were in quiet hours · 2 updates");
    expect(digest.body).toBe(`• ${first.title}\n• ${second.title}`);
    expect(digest.url).toBe("/?drawer=inbox");

    const rows = await deliveriesOf(d.id);
    const digestRow = rows.find((r) => r.kind === "DIGEST")!;
    expect(digestRow.status).toBe("SENT");
    expect(rows.filter((r) => r.kind === "NOTIFICATION").map((r) => [r.status, r.digestId])).toEqual([
      ["DIGESTED", digestRow.id],
      ["DIGESTED", digestRow.id],
    ]);
  });

  it("lets a security notice through only when urgentBypass is on", async () => {
    clock = at("23:30");
    const d = await device(at("21:00"));
    await setPrefs(quiet({ urgentBypass: false }));
    await notice({
      createdAt: at("23:30"),
      category: "SECURITY_CRITICAL",
      projectId: null,
      title: "Runner revoked",
    });
    await fixed().tick();
    expect(sent).toHaveLength(0);

    await setPrefs(quiet({ urgentBypass: true }));
    await notice({
      createdAt: at("23:31"),
      category: "SECURITY_CRITICAL",
      projectId: null,
      title: "Emergency stop",
    });
    await notice({ createdAt: at("23:31"), category: "TASK_DONE", title: "Finished · run" });
    await fixed().tick();
    expect(sent.map((s) => [s.payload.title, s.o.urgency])).toEqual([["Emergency stop", "high"]]);
    expect((await deliveriesOf(d.id)).map((r) => r.status)).toEqual(["HELD", "SENT", "HELD"]);
  });

  it("sends the held pushes as a digest as soon as quiet hours are switched off", async () => {
    clock = at("23:10");
    await setPrefs(quiet());
    await device(at("21:00"));
    await notice({ createdAt: at("23:10") });
    await fixed().tick();
    expect(sent).toHaveLength(0);
    await setPrefs(quiet({ enabled: false }));
    await fixed().tick();
    expect(sent.map((s) => s.payload.title)).toEqual(["While you were in quiet hours · 1 update"]);
  });
});

describe("delivery failures", () => {
  it("retires a device the push service no longer knows (410) and skips what it still had queued", async () => {
    const d = await device();
    answers = [{ ok: false, statusCode: 410 }];
    await notice();
    await notice();
    await dispatcher().tick();

    const [dev] = await db.select().from(pushDevices).where(eq(pushDevices.id, d.id));
    expect(dev).toMatchObject({ status: "GONE", lastError: expect.stringContaining("HTTP 410") });
    // Both were claimed in one batch; the second is never sent once the device is gone.
    expect(sent).toHaveLength(1);
    expect((await deliveriesOf(d.id)).map((r) => r.status)).toEqual(["FAILED", "SKIPPED"]);
    const gone = await db
      .select()
      .from(auditRecords)
      .where(and(eq(auditRecords.resourceId, d.id), eq(auditRecords.action, "push_device.gone")));
    expect(gone.map((a) => a.outcome)).toEqual(["FAILED"]);

    sent.length = 0;
    await notice();
    await dispatcher().tick();
    expect(sent).toHaveLength(0);
  });

  it("retries a 5xx after 1, 5 and 30 minutes, then gives up", async () => {
    clock = new Date();
    const d = await device(new Date(clock.getTime() - 60_000));
    await notice({ createdAt: clock });
    answers = Array.from({ length: 4 }, () => ({ ok: false as const, statusCode: 503 }));
    const push = fixed();
    const advance = async (ms: number) => {
      clock = new Date(clock.getTime() + ms);
      await push.tick();
    };

    await push.tick();
    expect(sent).toHaveLength(1);
    await advance(59_000);
    expect(sent).toHaveLength(1);
    await advance(1_000);
    expect(sent).toHaveLength(2);
    await advance(5 * 60_000);
    expect(sent).toHaveLength(3);
    await advance(30 * 60_000);
    expect(sent).toHaveLength(4);
    await advance(60 * 60_000);
    expect(sent).toHaveLength(4);

    // Every attempt was the same push (one topic): a retry can only replace an undelivered copy.
    expect(new Set(sent.map((s) => s.o.topic)).size).toBe(1);
    const [row] = await deliveriesOf(d.id);
    expect(row).toMatchObject({ status: "FAILED", attempts: 4, lastError: "HTTP 503" });
    const [dev] = await db.select().from(pushDevices).where(eq(pushDevices.id, d.id));
    expect(dev).toMatchObject({ status: "ACTIVE", lastError: "Last push failed (HTTP 503)." });
  });

  it("doesn't retry a push the service refused (403), and never resends one interrupted mid-send", async () => {
    const d = await device();
    answers = [{ ok: false, statusCode: 403 }];
    await notice();
    await dispatcher().tick();
    expect((await deliveriesOf(d.id))[0]).toMatchObject({ status: "FAILED", lastError: "HTTP 403" });

    const n = await notice();
    // As if the process died after claiming it: SENDING for longer than any send can take.
    await db.insert(pushDeliveries).values({
      deviceId: d.id,
      kind: "NOTIFICATION",
      notificationId: n.id,
      dedupKey: `n:${n.id}`,
      status: "SENDING",
      payload: { title: n.title, body: n.body, url: "/?drawer=inbox", tag: `n-${n.id}` },
      attempts: 1,
      claimedAt: new Date(Date.now() - 3 * 60_000),
      correlationId: `notification:${n.id}`,
    });
    sent.length = 0;
    await dispatcher().tick();
    expect(sent).toHaveLength(0);
    const [stuck] = await db.select().from(pushDeliveries).where(eq(pushDeliveries.notificationId, n.id));
    expect(stuck).toMatchObject({ status: "FAILED", lastError: "interrupted while sending; not resent" });
  });

  it("is a no-op without push keys", async () => {
    await device();
    await notice();
    await createPushDispatcher({ db, sender: null, log, timezone: "Asia/Dubai" }).tick();
    expect(sent).toHaveLength(0);
  });
});
