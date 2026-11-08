import type { SubscribePushRequest } from "@nexus/contracts";

// The browser half of phone push: whether this browser can take pushes (and in plain words why not), the service
// worker registration, and this device's subscription. The API holds the VAPID key pair and sends the pushes.

/** What the environment looks like; a parameter so tests (and the Settings tab) can describe any device. */
export type PushEnv = {
  production: boolean;
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  permission: NotificationPermission | null;
  ios: boolean;
  standalone: boolean;
};

export function pushEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    production: import.meta.env.PROD,
    secure: window.isSecureContext,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notification: "Notification" in window,
    permission: "Notification" in window ? Notification.permission : null,
    // iPadOS reports itself as a Mac with touch.
    ios:
      /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    standalone: nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true,
  };
}

/** null = this browser can turn push on; otherwise the owner-facing reason and what to do. */
export function pushUnavailable(e: PushEnv): string | null {
  if (!e.secure)
    return "Push needs HTTPS. Open NEXUS at its Tailscale address (https://<host>.<tailnet>.ts.net), not plain http.";
  if (!e.production)
    return "Push works in the built app (node scripts/nexus.mjs up), not in the Vite dev server.";
  if (e.ios && !e.standalone)
    return "On iPhone and iPad, push works only from the Home Screen app: tap Share → Add to Home Screen, open NEXUS from there, then turn push on.";
  if (!e.serviceWorker || !e.pushManager || !e.notification)
    return "This browser can't receive web push. Use Safari on iOS 16.4 or later (from the Home Screen), or Chrome, Edge or Firefox.";
  if (e.permission === "denied")
    return "Notifications are blocked for NEXUS. Allow them in this browser's site settings (on iPhone: Settings → Notifications → NEXUS), then come back.";
  return null;
}

/** Registers /sw.js in production builds on secure origins; elsewhere push stays off and Settings says why. */
export function registerServiceWorker(e: PushEnv = pushEnv()) {
  if (!e.production || !e.secure || !e.serviceWorker) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
    // Settings → Notifications shows push as unavailable on this device; nothing else depends on it.
  });
}

const fromBase64Url = (s: string) => {
  const b64 = s
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) =>
  !!a && a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === b[i]);

const READY_TIMEOUT_MS = 10_000;
async function registration(): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("The NEXUS service worker didn't start. Reload the page and try again.")),
      READY_TIMEOUT_MS,
    ),
  );
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

/**
 * Asks for notification permission (must run from a click) and subscribes this browser with the API's VAPID key.
 * A subscription made with another key (the keys were regenerated) is replaced.
 */
export async function subscribeThisBrowser(
  vapidPublicKey: string,
): Promise<SubscribePushRequest["subscription"]> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked for NEXUS. Allow them in this browser's site settings, then try again."
        : "Push stays off until you allow notifications.",
    );
  const reg = await registration();
  const key = fromBase64Url(vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  return {
    endpoint: json.endpoint ?? sub.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  };
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** First 16 hex chars of SHA-256(endpoint) of this browser's subscription (PushDevice.endpointHash), or null. */
export async function thisBrowserEndpointHash(): Promise<string | null> {
  const sub = await currentSubscription();
  if (!sub) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sub.endpoint));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** Drops this browser's own subscription (after the owner revoked this device). */
export async function unsubscribeThisBrowser(): Promise<void> {
  await (await currentSubscription())?.unsubscribe();
}
