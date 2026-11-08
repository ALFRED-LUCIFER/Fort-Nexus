import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultNotificationPreferences,
  pushServiceOf,
  type NotificationList,
  type NotificationPreferences,
  type PushDevice,
  type PushDeviceList,
  type TestPushResponse,
} from "@nexus/contracts";
import { createDb, type Db } from "../src/db/index.ts";
import { auditRecords, notifications } from "../src/db/schema.ts";
import { PushKeyFile, loadOrCreatePushKeys } from "../src/push/keys.ts";
import { deepLink, digestPayload, isQuietAt } from "../src/push/policy.ts";
import type { PushSender } from "../src/push/sender.ts";
import { createTestApp, ownerSession, type TestApp } from "./helpers/owner-session.ts";

// Slice A's API: devices (subscribe, list, test push, revoke), preferences, the key file and the pure policy rules.
// The push service is a fake sender; nothing reaches a real one.

let t: TestApp;
let db: Db;
let pool: { end(): Promise<void> };
let cookie: string;
const pushes: { endpoint: string; payload: string }[] = [];
const sender: PushSender = async (target, payload) => {
  pushes.push({ endpoint: target.endpoint, payload });
  return { ok: true };
};
let ip = "127.0.0.1";
let n = 0;

const call = (
  method: "GET" | "PUT" | "POST" | "DELETE",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  t.app.inject({
    method,
    url,
    remoteAddress: ip,
    headers: { cookie, origin: t.config.publicOrigin, ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });

const subscription = (endpoint = `https://web.push.apple.com/${randomBytes(24).toString("base64url")}`) => ({
  endpoint,
  expirationTime: null,
  keys: { p256dh: randomBytes(65).toString("base64url"), auth: randomBytes(16).toString("base64url") },
});
async function subscribe(label = "Alfred's iPhone", sub = subscription()) {
  const res = await call("POST", "/v1/devices", { label, subscription: sub });
  expect(res.statusCode, res.body).toBe(201);
  return { device: res.json<PushDevice>(), sub };
}

beforeAll(async () => {
  t = await createTestApp({ OWNER_TIMEZONE: "Asia/Dubai" }, { pushSender: sender });
  ({ db, pool } = createDb(t.databaseUrl));
  cookie = await ownerSession(t);
});
afterAll(async () => {
  await t?.app.close();
  await pool?.end();
});
beforeEach(() => {
  ip = `127.0.9.${++n}`;
  pushes.length = 0;
});

describe("devices", () => {
  it("needs a session, and a trusted Origin to change anything", async () => {
    const anon = await t.app.inject({ method: "GET", url: "/v1/devices" });
    expect(anon.statusCode).toBe(401);
    const noOrigin = await t.app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: { cookie },
      payload: { label: "x", subscription: subscription() },
    });
    expect(noOrigin.statusCode).toBe(403);
  });

  it("gives the VAPID public key from the 0600 key file it created on first start", async () => {
    const res = await call("GET", "/v1/devices");
    expect(res.statusCode).toBe(200);
    const list = res.json<PushDeviceList>();
    expect(list.problem).toBeNull();
    const file = PushKeyFile.parse(JSON.parse(readFileSync(t.config.pushFile, "utf8")));
    expect(list.vapidPublicKey).toBe(file.publicKey);
    expect(statSync(t.config.pushFile).mode & 0o777).toBe(0o600);
    expect(res.body).not.toContain(file.privateKey);
  });

  it("accepts only real browser push services as endpoints", async () => {
    for (const endpoint of [
      "https://evil.example/push",
      "http://web.push.apple.com/x",
      "https://web.push.apple.com.evil.example/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pw@fcm.googleapis.com/x",
    ]) {
      const res = await call("POST", "/v1/devices", { label: "x", subscription: subscription(endpoint) });
      expect(res.statusCode, endpoint).toBe(400);
    }
    const blank = await call("POST", "/v1/devices", { label: "   ", subscription: subscription() });
    expect(blank.statusCode).toBe(400);
  });

  it("subscribes once per browser, renames on re-subscribe, never returns the endpoint, and audits it", async () => {
    const { device, sub } = await subscribe("Phone");
    expect(device).toMatchObject({ label: "Phone", service: "APPLE", status: "ACTIVE", lastSentAt: null });
    const again = await call("POST", "/v1/devices", { label: "Alfred's iPhone", subscription: sub });
    expect(again.statusCode).toBe(200);
    expect(again.json<PushDevice>()).toMatchObject({ id: device.id, label: "Alfred's iPhone" });

    const list = await call("GET", "/v1/devices");
    expect(list.json<PushDeviceList>().items.filter((d) => d.id === device.id)).toHaveLength(1);
    expect(list.body).not.toContain(sub.endpoint);
    expect(list.body).not.toContain(sub.keys.auth);

    const audits = await db.select().from(auditRecords).where(eq(auditRecords.resourceId, device.id));
    expect(audits.map((a) => a.action)).toEqual(["push_device.subscribe", "push_device.update"]);
    expect(JSON.stringify(audits)).not.toContain(sub.endpoint);
  });

  it("sends one test push per Idempotency-Key", async () => {
    const { device, sub } = await subscribe();
    const missing = await call("POST", `/v1/devices/${device.id}/test`);
    expect(missing.statusCode).toBe(400);

    const key = { "idempotency-key": `test-${randomUUID()}` };
    const first = await call("POST", `/v1/devices/${device.id}/test`, undefined, key);
    expect(first.statusCode, first.body).toBe(202);
    await vi.waitFor(() => expect(pushes.filter((p) => p.endpoint === sub.endpoint)).toHaveLength(1));
    const sentAt = async () =>
      (await call("GET", "/v1/devices")).json<PushDeviceList>().items.find((d) => d.id === device.id)!
        .lastSentAt;
    await vi.waitFor(async () => expect(await sentAt()).not.toBeNull());
    const replay = await call("POST", `/v1/devices/${device.id}/test`, undefined, key);
    expect(replay.json<TestPushResponse>()).toEqual({
      deliveryId: first.json<TestPushResponse>().deliveryId,
      status: "SENT",
    });
    await t.app.ready(); // let any stray tick run
    expect(pushes.filter((p) => p.endpoint === sub.endpoint)).toHaveLength(1);
    expect(JSON.parse(pushes.at(-1)!.payload)).toEqual({
      title: "NEXUS test push",
      body: "Push works on Alfred's iPhone. Alerts you opt into in Settings → Notifications arrive here.",
      url: "/?drawer=settings#notif",
      tag: "nexus-test",
    });
  });

  it("revokes a device (idempotent, audited); it gets no more pushes, and a decoy id is 404", async () => {
    const { device } = await subscribe();
    const res = await call("DELETE", `/v1/devices/${device.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json<PushDevice>().status).toBe("REVOKED");
    expect((await call("DELETE", `/v1/devices/${device.id}`)).json<PushDevice>().status).toBe("REVOKED");
    const test = await call("POST", `/v1/devices/${device.id}/test`, undefined, {
      "idempotency-key": randomUUID(),
    });
    expect(test.statusCode).toBe(409);
    const audits = await db.select().from(auditRecords).where(eq(auditRecords.resourceId, device.id));
    expect(audits.filter((a) => a.action === "push_device.revoke")).toHaveLength(1);

    const decoy = randomUUID();
    expect((await call("DELETE", `/v1/devices/${decoy}`)).statusCode).toBe(404);
    expect(
      (await call("POST", `/v1/devices/${decoy}/test`, undefined, { "idempotency-key": randomUUID() }))
        .statusCode,
    ).toBe(404);
  });
});

// The API serves the built web app; only meaningful once `pnpm --filter @nexus/web build` has run.
const WEB_BUILT = existsSync(fileURLToPath(new URL("../../web/dist/sw.js", import.meta.url)));
describe.skipIf(!WEB_BUILT)("installable app (built web)", () => {
  it("serves the service worker and manifest fresh, with a CSP that allows them", async () => {
    const sw = await t.app.inject({ method: "GET", url: "/sw.js" });
    expect(sw.statusCode).toBe(200);
    expect(sw.headers["content-type"]).toMatch(/javascript/);
    expect(sw.headers["cache-control"]).toBe("no-cache");
    expect(sw.headers["service-worker-allowed"]).toBe("/");
    const manifest = await t.app.inject({ method: "GET", url: "/manifest.webmanifest" });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers["content-type"]).toMatch(/^application\/manifest\+json/);
    expect(manifest.json()).toMatchObject({ display: "standalone", start_url: "/" });
    const page = await t.app.inject({ method: "GET", url: "/" });
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
    expect(page.body).toContain('rel="manifest"');
    const icon = await t.app.inject({ method: "GET", url: "/icons/apple-touch-icon.png" });
    expect(icon.headers["content-type"]).toBe("image/png");
  });
});

describe("notification preferences", () => {
  const prefs = (): NotificationPreferences => defaultNotificationPreferences("Asia/Dubai");

  it("defaults to everything on, quiet hours off, in OWNER_TIMEZONE", async () => {
    const res = await call("GET", "/v1/notification-preferences");
    expect(res.json()).toEqual(prefs());
  });

  it("refuses hiding approvals from the Inbox, a fake time zone, and an empty quiet window", async () => {
    const hide = prefs();
    hide.categories.APPROVAL_REQUIRED.inApp = false;
    const zone = prefs();
    zone.quietHours.timezone = "+04:00";
    const empty = prefs();
    empty.quietHours.end = empty.quietHours.start;
    for (const body of [hide, zone, empty])
      expect((await call("PUT", "/v1/notification-preferences", body)).statusCode).toBe(400);
  });

  it("saves them (audited) and hides switched-off categories from the Inbox list and count", async () => {
    const me = (await call("GET", "/v1/me")).json<{ id: string }>();
    await db.insert(notifications).values([
      {
        ownerId: me.id,
        projectId: null,
        category: "INFORMATIONAL",
        title: "Brief",
        body: "b",
        dedupKey: randomUUID(),
      },
      {
        ownerId: me.id,
        projectId: null,
        category: "SECURITY_CRITICAL",
        title: "Stop",
        body: "s",
        dedupKey: randomUUID(),
      },
    ]);
    const body = prefs();
    body.categories.INFORMATIONAL.inApp = false;
    body.quietHours = { ...body.quietHours, enabled: true, start: "23:00", end: "06:30" };
    const res = await call("PUT", "/v1/notification-preferences", body);
    expect(res.statusCode, res.body).toBe(200);
    expect((await call("GET", "/v1/notification-preferences")).json()).toEqual(body);

    const list = (await call("GET", "/v1/notifications")).json<NotificationList>();
    expect(list.items.map((i) => i.category)).not.toContain("INFORMATIONAL");
    expect(list.items.map((i) => i.title)).toContain("Stop");
    expect(list.unreadCount).toBe(list.items.filter((i) => i.status === "UNREAD").length);

    const [a] = await db
      .select()
      .from(auditRecords)
      .where(like(auditRecords.action, "notification_preferences.%"));
    expect(a!.metadata).toMatchObject({
      inAppOff: ["INFORMATIONAL"],
      pushOff: [],
      quietHours: "23:00-06:30",
    });
  });
});

describe("push key file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexus-push-keys-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("creates a 0600 file once and reuses it", () => {
    const file = join(dir, "nested", "push.json");
    const a = loadOrCreatePushKeys(file, "https://nexus.example.ts.net");
    expect(a.problem).toBeNull();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(a.keys!.subject).toBe("https://nexus.example.ts.net");
    const b = loadOrCreatePushKeys(file, "http://127.0.0.1:8787");
    expect(b.keys!.publicKey).toBe(a.keys!.publicKey);
    expect(b.keys!.subject).toBe("mailto:owner@nexus.invalid");
  });

  it("refuses a group-readable or malformed file without echoing it", () => {
    const file = join(dir, "push.json");
    loadOrCreatePushKeys(file, "http://127.0.0.1:8787");
    chmodSync(file, 0o640);
    expect(() => loadOrCreatePushKeys(file, "http://127.0.0.1:8787")).toThrow(/chmod 600/);
    const secret = randomBytes(32).toString("base64url");
    writeFileSync(file, JSON.stringify({ publicKey: "short", privateKey: secret }), { mode: 0o600 });
    chmodSync(file, 0o600);
    let message = "";
    try {
      loadOrCreatePushKeys(file, "http://127.0.0.1:8787");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/fields: publicKey/);
    expect(message).not.toContain(secret);
  });

  // Root ignores directory permissions, so this can only be shown as a normal user.
  it.skipIf(process.getuid?.() === 0)(
    "leaves push unavailable, with a fix, when the file can't be created",
    () => {
      // Like the Compose mount of ~/.nexus: there, but read-only.
      const readOnly = join(dir, "ro");
      mkdirSync(readOnly, { mode: 0o500 });
      const r = loadOrCreatePushKeys(join(readOnly, "push.json"), "http://127.0.0.1:8787");
      chmodSync(readOnly, 0o700);
      expect(r.keys).toBeNull();
      expect(r.problem).toMatch(/node scripts\/nexus\.mjs up/);
    },
  );
});

describe("policy", () => {
  const q = {
    enabled: true,
    start: "22:00",
    end: "07:00",
    timezone: "Europe/Vienna",
    urgentBypass: true,
    approvalsUrgent: false,
  };
  it("quiet hours wrap past midnight and follow the zone's daylight saving", () => {
    // 21:30 UTC is 22:30 in Vienna in winter (UTC+1) and 23:30 in summer (UTC+2).
    expect(isQuietAt(q, new Date("2026-01-15T21:30:00Z"))).toBe(true);
    expect(isQuietAt(q, new Date("2026-01-15T20:30:00Z"))).toBe(false);
    expect(isQuietAt(q, new Date("2026-07-15T20:30:00Z"))).toBe(true);
    expect(isQuietAt(q, new Date("2026-07-15T05:00:00Z"))).toBe(false); // 07:00 local: over
    expect(isQuietAt({ ...q, start: "13:00", end: "14:00" }, new Date("2026-01-15T12:30:00Z"))).toBe(true);
    expect(isQuietAt({ ...q, enabled: false }, new Date("2026-01-15T21:30:00Z"))).toBe(false);
  });

  it("deep-links to the drawer of the notification's subject, in its workspace", () => {
    const id = randomUUID();
    const none = {
      projectId: null,
      jobId: null,
      incidentId: null,
      planId: null,
      deepDiveId: null,
      researchRunId: null,
    };
    expect(deepLink({ ...none, incidentId: id, projectId: id }, "BUSINESS")).toBe(
      `/?ws=business&project=${id}&drawer=incident%3A${id}`,
    );
    expect(deepLink({ ...none, planId: id }, null)).toBe(`/?drawer=plan%3A${id}`);
    expect(deepLink({ ...none, deepDiveId: id }, null)).toBe(`/?drawer=research%3A${id}`);
    expect(deepLink(none, null)).toBe("/?drawer=inbox");
  });

  it("caps the digest list and keeps the rest in the Inbox", () => {
    const d = digestPayload(["a", "b", "c", "d", "e", "f", "g"], "k");
    expect(d.body.split("\n")).toEqual(["• a", "• b", "• c", "• d", "• e", "+2 more in the Inbox"]);
  });

  it("knows the push services", () => {
    expect(pushServiceOf("https://fcm.googleapis.com/fcm/send/abc")).toBe("GOOGLE");
    expect(pushServiceOf("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe("MOZILLA");
    expect(pushServiceOf("https://wns2-db5p.notify.windows.com/w/?token=x")).toBe("MICROSOFT");
    expect(pushServiceOf("https://web.push.apple.com/QF")).toBe("APPLE");
    expect(pushServiceOf("not a url")).toBeNull();
  });
});
