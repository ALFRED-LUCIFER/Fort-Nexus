# P1 wave 1 — Research, Business, Talk (text), Motion

PRD: EPIC RES (FR-RES-01..12, RES-G01..G04), EPIC CON + DATA + BIZ (FR-CON-01..06, FR-DATA-01..09, FR-BIZ-01..07, DATA-G01..G04, BIZ-G01), EPIC CWV/CXR text-only (FR-CWV-01/04/05/07, FR-CXR-01..07), Part A "Motion". Contracts: `packages/contracts/src/research.ts`, `business.ts`, `conversations.ts`. Import them and don't redefine them. Contract changes go through the coordinator.

## Rules for every module

- **Scope:** every new table has `workspace_id uuid not null` + `project_id uuid not null`. Every query filters on both, and every audit record carries both plus the request id as the correlation id. Take them from `projectScope()` in `apps/api/src/scope.ts` (a placeholder until MVP wave 6). Don't add another scope source.
- **Routes:** register inside the owner scope in `app.ts`, next to `githubRoutes`. That gives you the session plus the trusted-Origin check on mutations. Use Zod schemas for params, query, body and response. Errors go through `HttpError`.
- **Audit:** use `audit()` from `apps/api/src/audit.ts` for every mutation (resource types are already added). Metadata holds ids and enums only.
- **Tables:** put each module's Drizzle tables in `apps/api/src/<module>/schema.ts` and add that file to `schema` in `apps/api/drizzle.config.ts` (an array). Generate one migration with `pnpm --filter @nexus/api db:generate`. The coordinator regenerates the combined migration on merge, so don't hand-edit other modules' migrations.
- **Dependencies:** `node scripts/with-lock.mjs pnpm --filter <pkg> add <name>@<exact-version>`, only when the platform or installed packages can't do the job.
- **Web:** add a zone body (`zones.tsx` pattern) and a drawer (`Drawer`/`DrawerHeader`/`DrawerState`). Add the drawer key to the `BoardSearch` regex in `router.tsx` and render it in `Board.tsx`, making one-line additions to shared files. Replace the matching `P1Button` only where your feature now really works. Loading, error, empty and stale states are required, and so is keyboard/screen-reader access. Labels must follow the truth hierarchy.
- **Tests:** API tests go in `apps/api/test/<module>.test.ts` (Testcontainers Postgres via the existing global setup, with external HTTP stubbed). Web tests sit next to the component. There is no live network in tests.

## A — Research (`apps/api/src/research/**`, web Research zone + `research` drawer)

- **Watchlists:** CRUD at `GET/POST /v1/research/watchlists` and `PATCH/DELETE /v1/research/watchlists/:id` (DELETE archives the watchlist; its history stays searchable). `nextRunAt` is computed from `schedule` in the watchlist's time zone, DST-correct.
- **Schedule, exactly once (RES-G01):** a `research_runs` row with a unique `(watchlist_id, window_date)` for `SCHEDULED` runs. An API interval tick (beside the reaper in `app.ts`) inserts due windows with `on conflict do nothing` and runs only the rows it inserted. A restart mid-run marks stale `RUNNING` runs `FAILED` (with the reason) on the next tick. Each window runs once and is never redone. `POST /v1/research/watchlists/:id/run` requires an Idempotency-Key and creates a `MANUAL` run (replaying the same key returns the same run). The run is no-op-safe and runs asynchronously. Decision: the window key replaces pg-boss for this (ADR-0002 note).
- **Fetch policy (FR-RES-12, RES-G04):** https only, no credentials, no cookies. Before a host's first fetch in a run, read its `robots.txt` with a NEXUS user agent and skip disallowed paths with `ROBOTS_DISALLOWED`. 401/403 is `AUTH_REQUIRED` and is never retried. Other limits: 1 request/second per host, 10 s timeout, 2 MB body cap (`TOO_LARGE`), redirects only to https. Every skip is recorded on the run with its reason.
- **Connectors:** RSS 2.0 and Atom (`FEED`) plus `GITHUB_RELEASES` (= `https://github.com/<repo>/releases.atom`). Strip markup to plain text and cap the excerpt at 1000 chars.
- **Dedupe (RES-G02):** canonical URL (lower-case host, drop fragment, `utm_*`/`ref`/`fbclid`/`gclid`, trailing slash, sorted query). Then lexical near-duplicate clustering of titles against findings of the same watchlist from the last 14 days, using `shortcut:` until embeddings exist. A match adds a `finding_sources` row to the existing finding instead of creating a new one.
- **Label (RES-G03):** `PRIMARY` if any source is tier PRIMARY. `CORROBORATED` if there are ≥ 2 distinct publishers. Otherwise `UNVERIFIED`. Recompute the label when a source is added. The UI shows "unverified" findings as claims, never as fact.
- **Score:** each criterion is in [0,1]. Credibility comes from the best tier, relevance from the keyword match ratio, novelty from age and first-seen, impact and opportunity from small fixed keyword lists (release/breaking/deprecat/security… and problem/pain/alternative/pricing…). The weighted mean uses the watchlist weights × 100 and is labelled a triage aid.
- **Brief and history:** `GET /v1/research/runs?watchlistId=`, `GET /v1/research/runs/:id` → `ResearchBrief`, `GET /v1/research/findings` (`FindingSearchQuery`; Postgres full-text on title+excerpt; uuidv7 cursor), `POST /v1/research/findings/:id/read`.
- **Web:** Research zone (top findings with label chips, next run). The `research` drawer has watchlists with their next run, run now, a pause toggle, weight sliders (saved with PATCH), the latest brief, search with filters, and skipped sources with reasons. A create-watchlist form covers feeds and GitHub repos.

## B — Business (`apps/api/src/business/**`, web Business zone + `business` drawer)

- **Registry:** `GET/POST /v1/business/connectors`, `PATCH /v1/business/connectors/:id`, `POST /v1/business/connectors/:id/test` → `ConnectionTestResult`, and `GET/PUT /v1/business/connectors/:id/dictionary`.
- **Credentials:** `~/.nexus/connectors/<credentialRef>.json` holds `{ "connectionString": "postgres://…" }`. The file must be mode 0600, owned by the API user, and a regular file (same checks as the runner's `ai-config.ts`). The directory is configurable via the env var `NEXUS_CONNECTORS_DIR` (default `~/.nexus/connectors`, added to `config.ts`). Error messages name the file and never echo its content or the connection string. Add a runbook at `docs/runbooks/business-connector.md` that covers creating the read-only role (SQL), the file, and test.
- **Read-only gateway (FR-DATA-01, DATA-G01/G04):** each tool call opens a short-lived `pg.Client` and runs `BEGIN READ ONLY`, `SET LOCAL statement_timeout`, `SET LOCAL search_path` limited to the allowlist, one parameterized aggregate query, then `COMMIT`. Identifiers come only from the validated dictionary, are checked against `schemaAllowlist` and are quoted. There is no generic SQL entry point and nothing that returns rows. The connection test fails `read_only` if `has_table_privilege(…, 'INSERT,UPDATE,DELETE,TRUNCATE')` is true for any table in the allowlisted schemas. A `PROD` connector can't be used by tools until a test passes.
- **Tools (FR-DATA-05, FR-BIZ-02/03/07):** `getSalesSummary(scope, query)` and `getPaymentFailures(scope, query)` are exported for the conversations module and exposed as `GET /v1/business/metrics/sales-summary` and `GET /v1/business/metrics/payment-failures` (`MetricQuery`).
  - Day windows run `[local 00:00, next local 00:00)` in `reportingTimezone`. `today` ends at now and is `partial: true`.
  - `compare` uses the previous day over the same local clock window.
  - Provenance comes with every value.
  - Money is handled in exact decimal (do it in SQL `numeric`, return text).
  - Missing, disabled, failing or undefined sources give `Unavailable`, never 0 (DATA-G02).
  - Payment reasons are masked (emails, digit runs ≥ 6) and capped at 20 groups (DATA-G03).
- **Audit (FR-CON-06):** one audit record per tool call: connector, tool, environment, duration, outcome, row-free metadata.
- **Web:** the Business zone shows KPI cards (paid orders, gross sales, failed payments) with partial/stale/unavailable badges. The `business` drawer has the tiles, today vs yesterday (same window, both windows' start/end shown), failed payments by reason, a source/freshness footer, and a connector list with register/test and a dictionary form. Copy says plainly "no data" when a value is unavailable.
- **Tests:** a second Testcontainers Postgres acts as the business source, with a read-only role and seeded orders/payments across a time-zone boundary. Cover DATA-G01, G02, G03, BIZ-G01, the write-capable role failing its test, a timeout, and an identifier outside the allowlist.

## C — Talk, text (`apps/api/src/conversations/**`, web `talk` drawer)

- **Threads and turns:** `GET/POST /v1/conversations`, `GET /v1/conversations/:id` → `ThreadDetail`, and `POST /v1/conversations/:id/turns` (Idempotency-Key required; `PostTurnRequest` → `PostTurnResponse`). Replaying the same key returns the stored turns without calling the model again. Turns are append-only.
- **Model:** `apps/api/src/ai.ts` reads the same `~/.nexus/ai.json` format as `apps/runner/src/ai-config.ts` (env `NEXUS_AI_FILE` overrides the path). It builds `Anthropic` or `AnthropicFoundry` per ADR-0003, and the model ID comes from that file. Mark it `shortcut:` (duplicates the runner schema; move to a shared package after P1 merges). Without a config, `POST …/turns` returns 409 with the runbook path, and the drawer explains how to set it up.
- **Router (FR-CXR-03):** the model gets the user text, the thread subject and the last few turns as delimited untrusted data. Its only output is a forced tool call whose input schema is `Intent`, validated with Zod; invalid output becomes `UNSUPPORTED`. The model never writes the answer text about facts.
- **Answers (FR-CWV-07, FR-CXR-04):** the server builds the reply from tool results: job rows, run events, approvals and PR URLs from `Approval.result`. Each reply carries `sources` and `basis`. Without a source event, the reply never says done, sent, merged, opened or deployed.
- **Follow-ups (FR-CWV-04, FR-CXR-07):** `RUN_STATUS` without a `jobId` resolves to the thread subject, or to exactly one job of the owner that is active or failed in the last 24 h. Otherwise it asks via `CLARIFY`.
- **Wave-1 tools:** `RUN_STATUS` and `LIST_RUNS` (read `jobs.ts`), and `START_ISSUE_RUN`. `BUSINESS_METRIC` and `RESEARCH_SEARCH` answer "not connected in this build" until the coordinator wires modules A/B at merge.
- **Proposals (FR-CWV-05, FR-CXR-05):** `START_ISSUE_RUN` resolves the repo through the GitHub catalog and stores an `ActionProposal` (`jobs.create`, risk R1, server-side `actionHash` = sha256 of canonical JSON, TTL `PROPOSAL_TTL_MS`, status `AWAITING_APPROVAL`). `POST /v1/conversations/proposals/:id/decision` (`ProposalDecisionRequest`) checks the hash (stale → 409) and expiry. On approve it calls the existing `createJob` with idempotency key `proposal:<id>`. The proposal moves to `EXECUTED` with `result.jobId` from the created job, and the thread subject becomes that job. Deny → `DENIED`. Every decision is audited.
- **Web:** Talk button → `talk` drawer (`drawer=talk` lists threads; `drawer=talk:<uuid>` opens one). Turns show source chips (links to run drawers and PRs) and a basis badge. The proposal card shows the server preview, the hash prefix, and Not now / Confirm. The text input has Send. Show sending, error, offline and not-configured states.
- **Tests:** stub the provider with MSW or an injected fake client. Cover the tool-call → Intent validation, invalid model output, idempotent replay, clarification on ambiguity, the no-done-without-source rule, approve → job created once (double approve), hash mismatch, expiry, and deny.

## D — Motion (`apps/web` animation wrappers only)

- Add `motion` (pinned exact) and wrap the app in `MotionConfig reducedMotion="user"`.
- Add drawer enter/exit (spring, from the design), staggered drawer content at 50 ms, and layout animation for board zone/node reflow. Animate the inspector, toast and brief only where those components exist.
- Use `LazyMotion` + `m` with async-loaded `domAnimation` to keep the initial bundle growth small. Report the before/after `vite build` sizes.
- Keep CSS for simple keyframes and remove hand-written WAAPI/CSS where Motion replaces it.
- Don't touch data logic. Test that reduced motion renders without transforms and that drawers still open and close, keep focus and close on Esc.

## Done when

All package suites, typecheck, lint, `prettier --check` and the web build pass, and every Gherkin ID above has a test that names it.
