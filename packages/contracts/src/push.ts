import { z } from "zod";
import { NotificationCategory } from "./notifications.ts";

// P1 wave 4 slice A (FR-NTF-03/07/09/10/11, FR-CSP-03, NFR-CNV-02/12): web push to the owner's phone (and its watch,
// which mirrors the phone), per-category channels and quiet hours. The home host sends outbound to the browser's push
// service; a push carries the notification's already-redacted title and body plus a deep link, nothing else.

// The push services browsers subscribe through. The API POSTs to the subscription's endpoint, so it only ever accepts
// these hosts (an arbitrary endpoint would make NEXUS a request forwarder).
export const PUSH_SERVICES = {
  APPLE: ["push.apple.com"],
  GOOGLE: ["fcm.googleapis.com"],
  MOZILLA: ["push.services.mozilla.com"],
  MICROSOFT: ["notify.windows.com"],
} as const;
export const PushService = z.enum(["APPLE", "GOOGLE", "MOZILLA", "MICROSOFT"]);
export type PushService = z.infer<typeof PushService>;

/** The push service an endpoint belongs to: its host is one of PUSH_SERVICES or a subdomain of one; else null. */
export function pushServiceOf(endpoint: string): PushService | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  for (const service of PushService.options)
    if (PUSH_SERVICES[service].some((h) => host === h || host.endsWith(`.${h}`))) return service;
  return null;
}

const base64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/);

// POST /v1/devices: the browser's PushSubscription.toJSON(), plus the owner's own name for the device.
export const SubscribePushRequest = z.strictObject({
  // From the owner, never the user agent ("Alfred's iPhone").
  label: z.string().trim().min(1).max(60),
  subscription: z.object({
    endpoint: z
      .string()
      .max(2048)
      .refine((e) => pushServiceOf(e) !== null, "Not a known browser push service"),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({
      // Uncompressed P-256 point (65 bytes) and the 16-byte auth secret, base64url.
      p256dh: base64url(80, 100),
      auth: base64url(16, 32),
    }),
  }),
});
export type SubscribePushRequest = z.infer<typeof SubscribePushRequest>;

export const PushDeviceStatus = z.enum([
  "ACTIVE",
  // The owner revoked it here.
  "REVOKED",
  // Its push service answered 404/410: the browser dropped the subscription (uninstalled, permission removed).
  "GONE",
]);
export type PushDeviceStatus = z.infer<typeof PushDeviceStatus>;

export const PushDevice = z.object({
  id: z.uuid(),
  label: z.string(),
  service: PushService,
  status: PushDeviceStatus,
  // First 16 hex chars of SHA-256(endpoint): lets a browser recognise its own device without the endpoint (a secret
  // capability URL) ever leaving the server.
  endpointHash: z.string().regex(/^[0-9a-f]{16}$/),
  createdAt: z.iso.datetime(),
  lastSentAt: z.iso.datetime().nullable(),
  lastFailureAt: z.iso.datetime().nullable(),
  // Owner-safe: an HTTP status or "network error", never the push service's body.
  lastError: z.string().max(200).nullable(),
});
export type PushDevice = z.infer<typeof PushDevice>;

// GET /v1/devices
export const PushDeviceList = z.object({
  // Null when push isn't available on the home machine; `problem` then says why and how to fix it.
  vapidPublicKey: z.string().nullable(),
  problem: z.string().max(400).nullable(),
  items: z.array(PushDevice),
});
export type PushDeviceList = z.infer<typeof PushDeviceList>;

// POST /v1/devices/:id/test (Idempotency-Key header): one test push, queued now.
export const TestPushResponse = z.object({
  deliveryId: z.uuid(),
  status: z.enum(["PENDING", "SENDING", "SENT", "FAILED"]),
});
export type TestPushResponse = z.infer<typeof TestPushResponse>;

// ── Preferences ──

export const CategoryChannels = z.object({
  inApp: z.boolean(),
  push: z.boolean(),
});
export type CategoryChannels = z.infer<typeof CategoryChannels>;

// Always in the Inbox: nobody may hide a pending approval or a security notice from themselves.
export const ALWAYS_IN_APP: readonly NotificationCategory[] = ["APPROVAL_REQUIRED", "SECURITY_CRITICAL"];

const isIanaZone = (tz: string) => {
  if (!/^[A-Za-z][A-Za-z_]*(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");

export const QuietHours = z
  .object({
    enabled: z.boolean(),
    start: HHMM,
    end: HHMM,
    // IANA name, e.g. Asia/Dubai: offsets like "+04:00" ignore daylight saving.
    timezone: z.string().max(64).refine(isIanaZone, "Use an IANA time zone name, e.g. Asia/Dubai"),
    // SECURITY_CRITICAL (and APPROVAL_REQUIRED when `approvalsUrgent`) still push during quiet hours.
    urgentBypass: z.boolean(),
    approvalsUrgent: z.boolean(),
  })
  .refine((q) => q.start !== q.end, {
    message: "Quiet hours must start and end at different times",
    path: ["end"],
  });
export type QuietHours = z.infer<typeof QuietHours>;

export const NotificationPreferences = z
  .object({
    categories: z.record(NotificationCategory, CategoryChannels),
    quietHours: QuietHours,
  })
  .refine((p) => ALWAYS_IN_APP.every((c) => p.categories[c].inApp), {
    message: "Approvals and security notices always show in the Inbox",
    path: ["categories"],
  });
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;

/** Until the owner saves their own: everything in the Inbox and on opted-in devices; quiet hours off. */
export const defaultNotificationPreferences = (timezone: string): NotificationPreferences => ({
  categories: Object.fromEntries(
    NotificationCategory.options.map((c) => [c, { inApp: true, push: true }]),
  ) as NotificationPreferences["categories"],
  quietHours: {
    enabled: false,
    start: "22:00",
    end: "07:00",
    timezone,
    urgentBypass: true,
    approvalsUrgent: false,
  },
});

// PUT /v1/notification-preferences: the whole document (it is small and always edited as a whole).
export const UpdateNotificationPreferencesRequest = NotificationPreferences;
export type UpdateNotificationPreferencesRequest = NotificationPreferences;

// The JSON the service worker receives (apps/web/public/sw.js reads exactly these fields).
export const PushPayload = z.object({
  title: z.string().max(200),
  body: z.string().max(1000),
  // Same-origin path into the app, e.g. "/?drawer=run:<uuid>"; the app asks for sign-in first.
  url: z.string().regex(/^\/(?!\/)/),
  // Replaces an earlier push with the same tag on the device.
  tag: z.string().max(64),
});
export type PushPayload = z.infer<typeof PushPayload>;
