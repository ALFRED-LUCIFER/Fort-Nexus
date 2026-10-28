# P1 wave 2: real project scope for wave 1, app monitoring, n8n automations

Base: `p1` with MVP waves 5 and 6 merged. Workspaces/projects are real now (`apps/api/src/workspaces.ts`, `packages/contracts/src/workspaces.ts`). The placeholder `apps/api/src/scope.ts` must disappear: after this wave, nothing imports it and the coordinator deletes it.

PRD: FR-CSP-01, FR-CXR-01, NFR-CNV-05 (scope); EPIC MON FR-MON-01/02/04/06/09, MON-G01/G02; EPIC AUTO FR-AUTO-02/03/05/07/08, AUTO-G01..G03. Contracts (binding; changes only through the coordinator): `research.ts`, `business.ts`, `conversations.ts` (each now has `projectId`), `workspaces.ts` (`ProjectFilterQuery`), `monitoring.ts`, `automations.ts`, `notifications.ts` (`subject.incidentId`).

## Scope rules (every P1 module)

- **Resolve** with `resolveProject(db, ownerId, projectId, { write?, mode? })` from `workspaces.ts`.
  - Unknown or foreign project → 404.
  - Archived project → 409 when `write` is set.
  - Wrong workspace mode → 403.
  - Store the returned `workspaceId` and `projectId` on new rows.
- **Creating:** the request body carries `projectId`, resolved with `write: true`.
- **Mutating an existing object** (PATCH, run, test, post turn, decide): load the row by id, then `resolveProject(…, row.projectId, { write: true })`. An archived project's objects are read-only.
- **Lists:** `projectId` in the query (`ProjectFilterQuery`) filters to that project, resolved without `write`. When it's omitted, the list is the read-only "All" view: rows whose `workspace_id` is in `ownerWorkspaceIds(db, ownerId)`.
- **Reads by id:** the row's `workspace_id` must be in the owner's workspaces, else 404. Never return another owner's row.
- **Background work** (research ticks, health checks) skips archived projects.
- **Audit:** keep `workspaceId`/`projectId` in the audit metadata as before.
- **Web:**
  - Use `useScope()` from `apps/web/src/board/scope.tsx`. Pass `scope.project?.id` to queries, and keep `scope.keep` in every `navigate` search.
  - In the "All" view (no project), create and run buttons are disabled with "Pick a project first", like the Code zone.
  - Business UI in a Dev project, and Dev-only actions in a Business project, show an honest state rather than an error.
- **Decoy tests (NFR-CNV-05):** use two projects, A and B, with data in A. B's lists never contain A's rows. B can't read A's objects by id through a B-scoped path, can't mutate them, and Talk in B can't see them. An archived project blocks writes, and the wrong mode gets 403.

### Cross-module signatures (pinned so the parallel changes fit)

- `apps/api/src/business/connectors.ts`: `BusinessScope = { db: Db; connectorsDir: string; actor: string; correlationId: string; ownerId: string; projectId: string }`.
  - `listConnectors(s)`, `getSalesSummary(s & { now?: Date }, query)` and `getPaymentFailures(…)` keep their names and only see `s.projectId`'s connectors.
  - A connector of another project counts as missing: `UNAVAILABLE` / `NO_CONNECTOR`.
- `apps/api/src/research/service.ts`: `searchFindings(db: Db, ownerId: string, q: FindingSearchQuery)`. `q.projectId` set means one project; unset means the "All" view.
- `apps/api/src/research/service.ts` (used by automations):
  - `getWatchlist(db: Db, ownerId: string, id: string): Promise<Watchlist>` (404 when not the owner's).
  - `createManualRun(db: Db, ctx: { ownerId: string; actor: string; correlationId: string }, watchlistId: string, idempotencyKey: string): Promise<ResearchRun>`. It resolves the watchlist's project with `write: true`.

## S1: Research scope (`apps/api/src/research/**`, `research.tsx`)

- Watchlists belong to a project of either mode.
- Findings carry `projectId` from their watchlist (DTO).
- Lists and search follow the scope rules.
- The scheduler tick skips archived projects.
- The web drawer and zone are project-scoped; create, run, pause and weights are disabled in "All".

## S2: Business scope (`apps/api/src/business/**`, `business.tsx`)

- Connectors belong to a **Business** project only: `mode: "BUSINESS"`, 403 otherwise.
- Tools follow the pinned signature.
- Web:
  - The Business zone and drawer are project-scoped.
  - In a Dev project the zone says business sources live in Business projects.
  - Replace main's Business P1 empty-state copy and update `apps/web/src/board/workspaces.test.tsx` "gives a Business project an honest P1 empty state…" to the real behaviour: an empty connector list shows "No sources connected to <project>".

## S3: Talk scope + command bar (`apps/api/src/conversations/**`, `Talk.tsx`, `CommandBar.tsx` Ask mode only)

- **Threads:** a thread belongs to the project given at creation, resolved with `write: true`. Posting a turn or deciding a proposal resolves the thread's project with `write: true`.
- **Tools see only the thread's project:**
  - `RUN_STATUS` and `LIST_RUNS` filter `jobs.project_id`, and the follow-up resolution too.
  - `BUSINESS_METRIC` uses the pinned business signature with the thread's project.
  - `RESEARCH_SEARCH` uses `searchFindings` with the thread's `projectId`.
- **`START_ISSUE_RUN`:**
  - The proposal's `CreateJobRequest` carries the thread's `projectId`. The repository must be bound to it; otherwise reply honestly and make no proposal.
  - `createJob` gets `timezone: deps.config.ownerTimezone`. Main's project, binding, budget and emergency-stop checks then apply unchanged.
- **Command bar:** Ask mode opens a Talk thread in the current project with the typed text as the first turn. It replaces the "arrives in P1" text. In "All" it says "Pick a project first".
- **Inbox:** main's notification toast has a Talk button disabled with "arrives in P1". Make it open Talk with a new thread whose subject is the notification's job, in that job's project.

## M: App monitoring (`apps/api/src/monitoring/**`, web Systems zone + `incident:<uuid>` drawer)

- **Routes:**
  - `GET/POST /v1/monitoring/apps` (`ProjectFilterQuery` / `CreateMonitoredAppRequest`)
  - `PATCH /v1/monitoring/apps/:id`
  - `POST /v1/monitoring/apps/:id/check`: manual check, rate-limited to 6/min
  - `GET /v1/monitoring/apps/:id/checks`: newest 50
  - `GET /v1/incidents` (`ListIncidentsQuery`)
  - `GET /v1/incidents/:id`
  - `POST /v1/incidents/:id/status` (`SetIncidentStatusRequest`)
  - Apps belong to a project of either mode.
- **Checker:**
  - Runs from an API interval tick, beside the reaper. Due apps run with bounded concurrency (4).
  - Request: `GET` with `redirect: "manual"` (a 3xx is a `REDIRECT` failure), the app's timeout, no cookies, no credentials, and a 64 KB body read cap.
  - Resolve DNS first and refuse loopback, private, link-local, CGNAT (100.64/10), multicast and metadata addresses as `BLOCKED_TARGET`. Connect to the vetted address, so a DNS rebind can't swap it.
  - Store every check.
- **Health:**
  - `HEALTHY`: the last check passed.
  - `DEGRADED`: failing, but under the threshold.
  - `DOWN`: the threshold has been reached.
  - `UNKNOWN`: never checked, disabled, or last check older than 2 × interval (MON-G02; the UI says checks run on the home host).
- **Incidents (MON-G01):**
  - Reaching the threshold opens one incident per fingerprint `app:<id>:<env>:http`. A partial unique index on `(fingerprint)` where status ≠ RESOLVED makes it exactly one, even when two checkers race.
  - Further failures attach as evidence.
  - A pass sets `recoveredAt`. The owner acknowledges or resolves.
  - After RESOLVED, a new failure streak opens a new incident.
  - Severity is `SEV2` for PROD, `SEV3` otherwise.
- **Notifications:**
  - Opening an incident writes one notification in the same transaction: category `BUSINESS_EXCEPTION` for Business projects, `TASK_FAILED` for Dev; `dedup_key` `incident:<id>:opened`; `subject.incidentId` set.
  - Add a nullable `incident_id` column to `notifications`, and map it in `toNotificationDto` and the web deep link.
  - Repeats add evidence, never notifications. That is the throttle policy.
- **Web:**
  - The Systems zone lists apps with health chips, color always paired with text. UNKNOWN reads "unknown, home host can't see it".
  - The `incident:<uuid>` drawer shows status, timeline, evidence and Acknowledge / Resolve.
  - App registration form (needs a project).
  - Agent triage and "create fix issue" are out of scope: show them as disabled P1Buttons with the reason.
- **Tests:** MON-G01 (three failures, one incident, three evidence; racing ticks); MON-G02 (stale check gives UNKNOWN, never HEALTHY); blocked targets incl. DNS rebinding; redirect; timeout; resolve-then-fail opens a new incident; notification once; decoy project.

## N: n8n automation bridge (`apps/api/src/automations/**`, web Settings → Automations tab)

- **Owner routes:**
  - `GET/POST /v1/automations/clients` (`ProjectFilterQuery` / `CreateAutomationClientRequest` → 201 `AutomationClientSecret`)
  - `PATCH /v1/automations/clients/:id`
  - `POST /v1/automations/clients/:id/rotate` → `AutomationClientSecret`
  - `GET /v1/automations/runs?clientId=`
- **Key:**
  - `signingKey = HKDF-SHA256(ikm = config.authSecret, salt = clientId, info = "nexus-automation-v<keyVersion>", 32 bytes)`, base64url.
  - It is derived on demand and never stored or logged.
  - Rotate bumps `keyVersion`, which invalidates the old key.
  - Document that rotating `BETTER_AUTH_SECRET` invalidates every automation key.
- **Service route `POST /v1/automations/trigger`:**
  - It lives in its own scope, outside the owner session (like runner routes), with a raw-body parser for this route only and a body limit of 64 KB.
  - Verify the client exists and isn't disabled, |now − timestamp| ≤ `AUTOMATION_MAX_SKEW_SECONDS`, and the signature over the exact raw bytes (timing-safe compare). Any failure gets 401 with one generic message and nothing enqueued (AUTO-G02); log the reason server-side without the signature.
  - Then rate-limit per client to `rateLimitPerMinute` (429).
  - Then parse `TriggerRequest`; strict, so shell or unknown fields get 400 (AUTO-G03).
  - Then check the action is allowed and targets the client's own project:
    - `jobs.create`: the job type must be in `allowedJobTypes` and `request.projectId === client.projectId`. Then call main's `createJob` unchanged, with the client's `ownerId` (stored on the client at creation), `timezone: config.ownerTimezone`, idempotency key `automation:<clientId>:<idempotencyKey>` and all its checks. The trigger's own audit record uses the actor `automation:<clientId>`.
    - `research.run`: the watchlist must be in the client's project; run it via the research module's manual-run function with the same derived key.
  - Record an `automation_runs` row: ACCEPTED, or REJECTED with the reason, for authenticated requests only. Replaying the same idempotency key returns the first result.
  - Audit everything.
  - Emergency stop and the daily budget apply through `createJob`.
- **Web:** Settings → Automations tab lists clients (project, actions, last used, disabled toggle) with Create and Rotate, showing the key once with a copy button and "it won't be shown again", plus recent runs with their reasons.
- **Docs:** `docs/runbooks/n8n.md`: Compose service or an existing n8n, with Execute Command disabled and no Docker socket; an HTTP Request node + Crypto (HMAC) node example; key rotation. Licensing note per FR-AUTO-09.
- **Tests:** AUTO-G01 (a signed trigger creates a typed job that a runner can lease; research.run creates a run); AUTO-G02 (bad signature, stale timestamp, unknown or disabled client, body tampered after signing: all 401, nothing enqueued); AUTO-G03 (shell field → 400, nothing enqueued); disallowed job type or action; wrong project; replay returns the same result; rate limit; rotation invalidates the old key; emergency stop refuses.

## Done when

All suites, typecheck, lint, `prettier --check` and the web build pass. Every Gherkin ID above has a test that names it. `grep -r "scope.ts\|P1_SCOPE\|projectScope()" apps` returns nothing in the files the agent owns.
