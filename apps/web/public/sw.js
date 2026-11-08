// NEXUS service worker: phone push only (P1 wave 4 slice A). No caching, no fetch handler: the app is always loaded
// from the home machine. Hand-written on purpose; see docs/runbooks/push.md. Unit-tested in src/sw.test.ts.
//
// A push carries { title, body, url, tag }: the notification's already-redacted text and a same-origin deep link.
// Opening it focuses an open NEXUS window (or opens one) on that link; the app asks for sign-in first.

const FALLBACK_URL = "/?drawer=inbox";

/** Same-origin path + query + hash, or the Inbox: a push can never send the app somewhere else. */
function safeUrl(raw) {
  try {
    const u = new URL(typeof raw === "string" ? raw : FALLBACK_URL, self.location.origin);
    return u.origin === self.location.origin ? `${u.pathname}${u.search}${u.hash}` : FALLBACK_URL;
  } catch {
    return FALLBACK_URL;
  }
}

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "NEXUS";
  const body =
    typeof data.body === "string" && data.body ? data.body : "Something changed. Open NEXUS to see it.";
  // Every push shows a notification: iOS and Chrome revoke push for workers that stay silent.
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: typeof data.tag === "string" && data.tag ? data.tag : undefined,
      icon: "/icons/icon-192.png",
      data: { url: safeUrl(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        try {
          const focused = await open.focus();
          await (focused || open).navigate(url);
          return;
        } catch {
          // An uncontrolled window can't be navigated from here: open a fresh one instead.
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
