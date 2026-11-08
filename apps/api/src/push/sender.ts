import webpush from "web-push";
import type { VapidKeys } from "./keys.ts";

/** One encrypted push to one subscription. Tests pass a fake; production uses web-push (createWebPushSender). */
export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushOptions = {
  /** Seconds the push service keeps it while the device is offline. */
  ttlSeconds: number;
  urgency: "normal" | "high";
  /** Coalescing key: a retry replaces an undelivered earlier copy instead of adding a second one. */
  topic: string;
};
/** `statusCode` null = no HTTP answer (DNS, TLS, timeout). Never carries the endpoint or the service's body. */
export type PushResult = { ok: true } | { ok: false; statusCode: number | null };
export type PushSender = (target: PushTarget, payload: string, o: PushOptions) => Promise<PushResult>;

const SEND_TIMEOUT_MS = 10_000;

export function createWebPushSender(keys: VapidKeys): PushSender {
  const vapidDetails = { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey };
  return async (target, payload, o) => {
    try {
      await webpush.sendNotification(target, payload, {
        vapidDetails,
        TTL: o.ttlSeconds,
        urgency: o.urgency,
        topic: o.topic,
        contentEncoding: "aes128gcm",
        timeout: SEND_TIMEOUT_MS,
      });
      return { ok: true };
    } catch (err) {
      // WebPushError carries the endpoint (a capability URL) and the service's body: only the status leaves here.
      const status = (err as { statusCode?: unknown }).statusCode;
      return { ok: false, statusCode: typeof status === "number" ? status : null };
    }
  };
}
