# P1 wave 4: alerts that reach you (phone/watch push, watch rules, passkey step-up)

Base: `main` at `07c6c75`. This wave folds in the unbuilt ops wave (`docs/ops-wave-kickoff.md`, items C and D).

Owner decisions (2026-11-03):
- **Sign-in:** keep "Sign in with GitHub", owner-only.
  - Turn on an authenticator app (e.g. Google Authenticator) or a passkey **in GitHub** for login MFA.
  - NEXUS adds its own **passkey step-up** before risky approvals.
  - No Google login provider and no in-app TOTP.
- **"Watch" means both:** *watch rules* decide **when** to alert, and *web push* delivers the alert to the phone, which mirrors it to an Apple Watch or Wear OS watch.

PRD:
- FR-NTF-03/07/09/10/11, FR-CSP-03, NFR-CNV-02/12 (push, preferences, quiet hours)
- FR-AWA-01..04 (watch rules)
- FR-ACC-04, FR-INB-03, FR-SEC-01, R3 policy in §11 (MFA step-up)
- MVP follow-ups from `docs/mvp-tracker.md`

## Feasibility (checked against the code and packages)

| Need | Verdict | Basis |
|---|---|---|
| Push to phone | ✅ | `web-push@3.6.7` (VAPID). The home host makes **outbound** calls to Apple/Google/Mozilla push services, so it needs no inbound port. |
| Push to iPhone | ✅ with conditions | iOS 16.4+ only pushes to a PWA that is **added to the Home Screen** and served over **HTTPS**. Tailscale Serve (`https://<host>.<tailnet>.ts.net`) provides both. Plain `localhost` works for desktop browsers only. |
| Alert on a watch | ✅ no watch code | iPhone mirrors notifications to Apple Watch while the phone is locked; Android mirrors Chrome notifications to Wear OS. The watch shows the redacted title and body. **Approvals stay on the phone**: they need the passkey (Face ID), and a watch can't do WebAuthn for a web app. |
| Passkey step-up | ✅ | `@better-auth/passkey@1.7.14` matches our `better-auth@1.7.14`. Its WebAuthn relying-party ID is the **origin's host**, so a passkey made on `localhost` won't work on `*.ts.net`. Register one per origin. |
| Watch rules on jobs / incidents | ✅ | Hooks exist: `notifyForJobEvents` (`apps/api/src/notifications.ts`) and incident open (`apps/api/src/monitoring/service.ts`). |
| Watch rules on business metrics | ✅ | Read-only tools exist: `getPaymentFailures`, `getRevenueSummary` (`apps/api/src/business/metrics.ts`). |
| Watch rules on CI | ✅ new code | The app has `checks: read`, but nothing reads check runs yet. Add a poller with the installation token (catalog pattern, 60 s cache). |
| "Notify me when…" in Talk | ✅ | Add an intent to the Talk router (`conversations/router.ts`). The model only **proposes** a rule draft, and the owner confirms it. |
| Alerts while the home host is down | ❌ by design | The home host is the sender. Off-host "host is down" alerts would need an external heartbeat service; that is out of scope and named here so nobody claims it. |

## Slices and order

`S0 → (A ∥ B) → C → D`, with each slice owning disjoint folders.

### S0: contracts and migration (coordinator)

- New contracts:
  - `packages/contracts/src/push.ts`: `PushDevice`, `SubscribePushRequest`, `NotificationPreferences` (per category: `inApp` / `push`, plus quiet hours with an IANA timezone and `urgentBypass`).
  - `packages/contracts/src/watch.ts`: `WatchTrigger` as a **closed discriminated union**, never a free DSL; `WatchRule`; `WatchRuleDraft`; `CreateWatchRuleRequest`.
  - `packages/contracts/src/stepup.ts`: `StepUpChallenge`, `StepUpProof`.
- One `drizzle-kit generate` migration (never hand-edited) adding these tables:
  - `push_devices`
  - `notification_preferences`
  - `push_deliveries` (unique `(notification_id, device_id)`)
  - `watch_rules`
  - `watch_fires` (unique `(rule_id, event_key)`)
  - `stepup_grants`
  - plus the passkey plugin's `passkey` table.

### A: phone push and quiet hours (`apps/api/src/push/**`, web service worker, Settings → Notifications)

- **VAPID keys:** generated on first start into `~/.nexus/push.json` (0600). Refuse to start if the file is group/world-readable, like `github-app.json`.
- **Devices:**
  - Explicit opt-in per device: a button calls `Notification.requestPermission()` and then sends the subscribe request.
  - `GET/POST /v1/devices`, `DELETE /v1/devices/:id` (revoke), audited.
  - The device label comes from the owner, not the user agent.
- **Delivery:**
  - The outbox listener sends a push for each new notification whose category the owner opted into.
  - A delivery row is the idempotency key, so a retry never pushes twice.
  - Retry with backoff (1 m, 5 m, 30 m).
  - An HTTP 404 or 410 from the push service deactivates the device.
- **Payload:**
  - The push body is the notification's already-redacted `title` + `body`, plus a deep-link path such as `/inbox?n=<id>`. It never contains customer, financial or secret data (FR-CSP-03).
  - The service worker opens the deep link, and the app requires a session.
- **Quiet hours:**
  - Use the owner's timezone (`OWNER_TIMEZONE`).
  - Pushes held during quiet hours go into one digest push when quiet hours end.
  - `SECURITY_CRITICAL`, and `APPROVAL_REQUIRED` if the owner opts in, bypass quiet hours only when `urgentBypass` is on.
- **Service worker:** a minimal hand-written `apps/web/public/sw.js` (push + notificationclick), plus `manifest.webmanifest` and icons for "Add to Home Screen". No vite-plugin-pwa unless offline caching is wanted later.
- **Web:**
  - Settings → Notifications: devices (add, test push, revoke), per-category channel toggles, quiet hours.
  - Inbox notify-policy footer.

### B: passkey step-up for risky approvals (`apps/api/src/stepup/**`, Settings → Security & devices)

- **Setup:** add `@better-auth/passkey` to `auth.ts`. In Settings → Security & devices you can register, list and remove passkeys, but only while signed in with GitHub. Passkeys are never a login method of their own.
- **Policy:**
  - `R3` approvals always need step-up.
  - `R2` (e.g. draft PRs) needs step-up only if the owner turns on "Ask for passkey on every approval".
  - Emergency-stop **release** and runner pairing need step-up as well.
- **Flow:**
  1. `POST /v1/stepup/challenge { approvalId }` returns a WebAuthn challenge bound to `approvalId + payloadHash`.
  2. The browser runs `navigator.credentials.get`.
  3. `POST /v1/stepup/verify` returns a single-use grant (5 min TTL) in `stepup_grants`.
  4. `POST /v1/approvals/:id/decision` requires the grant when policy says so. A grant for another approval, an expired grant or a reused grant gets 403. An approval whose payload changed needs a new approval (it already does).
- **No passkey registered yet:** an R3 decision returns 409 `STEP_UP_NOT_CONFIGURED` with the Settings link. It never falls back silently.
- **Audit:** step-up success and failure are audited with the approval ID, never the credential.

### C: watch rules (`apps/api/src/watch/**`, Talk intent, Inbox "Watching" tab)

- **Triggers:** a closed set, each with a Zod schema and a project scope.

  | Trigger | Parameters | Source |
  |---|---|---|
  | `JOB_FINISHED` | `jobId`, `when: ANY \| FAILED \| COMPLETED` | job terminal events (fact-based, FR-NTF-04) |
  | `INCIDENT_OPENED` | `appId?`, `minSeverity` | monitoring incident open |
  | `CI_CONCLUDED` | `repoId`, `branch`, `when: ANY \| FAILURE \| SUCCESS` | new check-runs poller (60 s) |
  | `PAYMENT_FAILURES_AT_LEAST` | `connectorId`, `count`, `windowMinutes` | `getPaymentFailures`, polled |
  | `RESEARCH_FINDING` | `watchlistId`, `minScore` | research run results |

- **Rule settings:**
  - Every rule has `expiresAt` (default 7 days, max 90), `cooldownSeconds`, `maxFires`, a category, and the rate limit from preferences.
- **Firing:**
  - Event triggers are evaluated in the same transaction as the source event.
  - Polled triggers run on one scheduler tick, using the jobs-table queue, with no new infrastructure.
  - A fire writes a `watch_fires` row (dedup on `(rule_id, event_key)`), then a notification. Slice A then pushes it.
  - Fires are facts only, with source and freshness ("3 failed payments in the last 30 min · data 2 min old").
- **Creating a rule:**
  - From the UI: an Inbox → Watching form.
  - From Talk: "notify me when…" routes to a `WATCH_RULE` intent. The model fills a `WatchRuleDraft` through one tool call validated by Zod. Talk shows a **preview card** (trigger, scope, channel, expiry), and nothing is saved until the owner clicks Confirm. Invalid model output means "I couldn't build that rule", never a partial save.
- **Follow-up actions (FR-AWA-04):** notification actions such as "show failed tests", "open run" and "retry" reuse the existing endpoints, with server-side authorization on the bound object. There is no new action surface.
- **API:** `GET/POST /v1/watch-rules`, `PATCH /v1/watch-rules/:id` (pause, extend), `DELETE /v1/watch-rules/:id`. All of them are audited and scoped by `projectId` with the decoy test.

### D: MVP follow-ups (from `docs/mvp-tracker.md`)

- `SystemControls.emergencyStop` gets an active/stopping run count, and the STOP banner uses it.
- The server-side unread count gets an `excludeCategory` option, and the Inbox badge excludes `APPROVAL_REQUIRED`.
- Budget reservation: the daily-cap check counts the unspent caps of runs still in flight.
- Log rotation for `~/.nexus/logs/*.log`.

## Acceptance (Gherkin outline, tags for playwright-bdd)

```gherkin
@NTF-G07 @FR-NTF-07
Scenario: A finished run reaches the phone once, redacted
  Given a device opted in to TASK_DONE pushes
  When job J reaches COMPLETED and the outbox is replayed twice
  Then exactly one push is sent for J's notification
  And its body has no customer, financial or secret data
  And opening it shows the run only after sign-in

@NTF-G09 @FR-NTF-09
Scenario: Quiet hours hold pushes until the digest
  Given quiet hours 22:00–07:00 Asia/Dubai and urgentBypass off
  When two TASK_FAILED notifications arrive at 23:10
  Then no push is sent before 07:00
  And one digest push lists both at 07:00

@INB-G03 @FR-INB-03
Scenario: An R3 approval needs a fresh passkey
  Given a pending R3 approval A and a registered passkey
  When the owner decides A without a step-up grant
  Then the API answers 403 and A stays PENDING
  When the owner verifies a passkey for A and decides within 5 minutes
  Then A is decided once and the grant can't be reused

@AWA-G01 @FR-AWA-01
Scenario: "Notify me when CI fails on main" is a preview, not a rule
  Given Talk in project P
  When the owner says "notify me when CI fails on main"
  Then Talk shows a CI_CONCLUDED FAILURE rule preview for P's repo, 7-day expiry
  And no watch rule exists until the owner confirms

@AWA-G02 @FR-AWA-02
Scenario: A rule fires once per event, with facts
  Given a confirmed JOB_FINISHED rule for job J
  When J fails and the event is delivered twice
  Then one watch fire and one notification exist
  And the notification states the failed step from the job's events
```

## Done means (PRD §16 + tracker checklist)

- Every input is Zod-validated. Every route is authorized server-side and scoped by `projectId`, with decoy tests.
- Every external write is idempotent and audited with a correlation ID: push sends, device subscribe, rule create, step-up.
- The UI has real empty, error, offline and stale states; is keyboard and screen-reader accessible; and never shows color without text.
- No secrets in code or logs: VAPID private key and credential IDs are never logged, and test keys are generated at runtime.
- Checks: `pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm --filter @nexus/web build`, then CI green.

## Owner prerequisites (not code)

1. GitHub → Settings → Password and authentication: turn on 2FA with an authenticator app or a passkey.
2. For the phone and watch:
   - Set up Tailscale Serve (`docs/runbooks/remote-access.md`) and set `PUBLIC_ORIGIN` to the `https://….ts.net` URL.
   - Add that URL to the GitHub App's callback URLs.
   - On the iPhone, open it in Safari, choose Share → **Add to Home Screen**, and allow notifications.
   - On Apple Watch, turn on mirroring for the NEXUS notifications (Watch app → Notifications).
3. Register a passkey once per origin (localhost for dev, ts.net for phone).

## Size

| Slice | Size | Notes |
|---|---|---|
| S0 | S | contracts + one migration |
| A | M | the biggest risk is iOS behaviour; test on a real iPhone over Tailscale |
| B | M | WebAuthn ceremony + grant binding |
| C | L | five triggers, Talk intent, poller, Inbox tab |
| D | S | four small items |

A and B can run in parallel after S0. C depends on A for delivery but can start on rules and fires in parallel.
