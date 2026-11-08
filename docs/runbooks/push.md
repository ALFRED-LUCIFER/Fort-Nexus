# Runbook: phone push and quiet hours

NEXUS pushes to your phone when something needs you or finishes: an approval waiting, a draft PR opened, a run that failed or needs recovery, an incident, a finished plan or deep dive, a run stopped at its budget, an emergency stop. A paired Apple Watch or Wear OS watch shows what the phone shows. Spec: `docs/specs/p1-wave-4-alerts.md` slice A.

What a push contains: the notification's title and text exactly as the Inbox shows them (already redacted: no customer, financial or secret data) and a link that opens the right drawer. Opening it asks you to sign in first if the session has expired. Approvals are still decided in the app, never on the watch.

The home machine sends pushes **outbound** to Apple's, Google's, Mozilla's or Microsoft's push service. Nothing listens for inbound traffic, and pushes stop while the home machine is off (by design: there is no off-host sender).

## 1. Prerequisites

1. Remote access over HTTPS with Tailscale Serve, and `PUBLIC_ORIGIN=https://<host>.<tailnet>.ts.net` (`docs/runbooks/remote-access.md`). Push needs a secure origin: plain `http://<LAN-IP>` never works. `http://127.0.0.1:8787` works for a desktop browser on the home machine only.
2. Tailscale installed and signed in on the phone.
3. The built app: `node scripts/nexus.mjs up`. The Vite dev server (`pnpm dev`) never registers the service worker.

## 2. Push keys (VAPID)

The API signs every push with a key pair in `~/.nexus/push.json` (mode `0600`). It is created once:

- `node scripts/nexus.mjs up` creates it on the host before starting Compose (the container mounts `~/.nexus` read-only);
- an API started on the host (`pnpm --filter @nexus/api start`) creates it on first start.

The API refuses to start if the file is group/world-readable (`chmod 600 ~/.nexus/push.json`) or malformed. If it can't be created, the API still starts and Settings → Notifications says why.

Optional: add `"subject": "mailto:you@example.com"` to the file to tell the push services whom to contact; otherwise NEXUS uses `PUBLIC_ORIGIN` when it is https.

**Never delete or replace the file casually**: every subscribed device is bound to its public key. After a new key, each device must turn push on again (Settings → Notifications), and the old subscriptions show as "gone".

The private key is never logged or returned by the API. The encrypted backup (`docs/runbooks/backup-restore.md`) includes the file like the other `~/.nexus/*.json`, so a restore keeps every device subscribed.

## 3. iPhone (iOS / iPadOS 16.4 or later)

Safari only delivers web push to a site **added to the Home Screen**.

1. On the iPhone, with Tailscale on, open `https://<host>.<tailnet>.ts.net` in **Safari** and sign in.
2. Tap **Share → Add to Home Screen → Add**.
3. Open **NEXUS from the Home Screen icon** (not from Safari) and sign in again: the installed app has its own cookies.
4. Settings → **Notifications** → name the device (e.g. "Alfred's iPhone") → **Turn on push** → **Allow**.
5. Tap **Test push** next to the device. The notification arrives within a few seconds.
6. Apple Watch: Watch app on the iPhone → Notifications → NEXUS → **Mirror iPhone Alerts**. Notifications reach the watch while the iPhone is locked.

If "Turn on push" isn't offered, the tab says why: not opened from the Home Screen, not https, or notifications blocked (iPhone Settings → Notifications → NEXUS → Allow Notifications).

## 4. Android

1. With Tailscale on, open the https URL in **Chrome** and sign in.
2. Optional but recommended: ⋮ → **Add to Home screen / Install app**.
3. Settings → **Notifications** → name the device → **Turn on push** → **Allow** → **Test push**.
4. Wear OS: notifications from Chrome (or the installed app) are bridged to the watch by default; check the watch's companion app if they don't appear.

## 5. Desktop (optional)

Chrome, Edge or Firefox at the https URL (or `http://127.0.0.1:8787` on the home machine) → Settings → Notifications → Turn on push. macOS Safari works too.

## 6. What goes where, and quiet hours

Settings → Notifications:

- **What goes where**: per category, Inbox and/or push. Approvals and security notices always stay in the Inbox.
- **Quiet hours** (e.g. 22:00–07:00, IANA time zone such as `Asia/Dubai`, default `OWNER_TIMEZONE`): pushes during that window are held and arrive as **one summary push** when it ends ("While you were in quiet hours · 3 updates").
- **Security notices still come through** (on by default): emergency stops and revoked runners push immediately even in quiet hours. **Approvals come through too** extends that to approvals.

Every change is audited (`notification_preferences.update`).

## 7. Devices

- Each browser that turned push on is a device; the name is yours. Revoke one in Settings → Notifications (audited); it gets nothing more. Revoking this browser also drops its subscription.
- A device whose push service answers 404/410 (app removed, permission withdrawn, subscription expired) is marked **gone** and gets nothing more; turn push on again on it.
- Other failures are retried after 1, 5 and 30 minutes, then given up; the device row shows the last error (an HTTP status, never the service's body).

## 8. How delivery works (for debugging)

- Every new notification gets one row per active device in `push_deliveries` (`SKIPPED` if the category's push is off, `HELD` in quiet hours, else `PENDING`). The row's unique keys are the idempotency key: a replayed event or a retried pass never pushes twice. A send interrupted by a crash is marked `FAILED`, never resent.
- The API's 5-second background pass writes those rows, folds held rows into the digest and sends what is due. A notification older than an hour when its device first sees it isn't pushed.
- Audit: `push_device.subscribe|update|reactivate|revoke|test|gone`, `push.sent`, `push.failed` (resource `push_device`, correlation id `notification:<id>` or the request id). Never an endpoint or key.

```sql
-- what was pushed to whom, newest first
select d.label, p.kind, p.status, p.attempts, p.last_error, p.created_at, p.sent_at
from push_deliveries p join push_devices d on d.id = p.device_id
order by p.id desc limit 20;
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Push needs HTTPS" | Open the `https://….ts.net` URL, not an IP. |
| "only from the Home Screen app" (iPhone) | Step 3: Add to Home Screen and open from the icon. |
| "Push isn't available on the home machine" | `~/.nexus/push.json` missing and couldn't be created: run `node scripts/nexus.mjs up`. |
| Test push never arrives, device shows `HTTP 403` | The push service refused the signature: check `subject` in `push.json` is `mailto:` or an `https://` URL (not localhost), and the key file wasn't replaced. |
| Device shows "gone" | Turn push on again on that device. |
| Nothing at night, then one summary | That is quiet hours; change them in Settings → Notifications. |
| Nothing at all while away | The home machine is off or asleep, or Tailscale is down on it. |
