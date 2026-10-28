# Spike 0 — office browser → home runner, end to end

Scope: PRD Appendix B / ENG-01..03 minimum vertical slice. Prove that a job submitted from an authorized browser runs **on the home host** (not the client), streams live, survives reconnects and restarts, and is audited. Shared types live in `packages/contracts` (`@nexus/contracts`) — import from there, never redefine.

## Runtime conventions

- Node 24 runs `.ts` directly (type stripping). No build step for `apps/api` and `apps/runner`: `node src/<entry>.ts`. Use only erasable TS syntax (no `enum`, no parameter properties, no namespaces), relative imports with `.ts` extensions.
- `tsconfig.json` in each app extends `../../tsconfig.base.json` (web overrides module/lib/jsx for Vite).
- Each package exposes scripts: `dev`, `typecheck` (`tsc -p .`), `test` (`vitest run`), and `start`/`build` where relevant.
- Postgres for dev: `pnpm db:up` (compose, `postgres://nexus:nexus@127.0.0.1:5432/nexus`). Tests use Testcontainers (`@testcontainers/postgresql`, image `postgres:18-alpine`), never the dev DB.

## API surface (apps/api, Fastify, default `127.0.0.1:8787`)

Errors always use `ApiError` (`{ error: { code, message, details? }, requestId }`). Validation failures → 400 `VALIDATION_FAILED`.

### Owner endpoints (Better Auth cookie session; mutations also require `Origin` ∈ trusted origins)

| Method | Path | Body / query | Response |
|---|---|---|---|
| * | `/api/auth/*` | Better Auth (email + password, sign-up disabled) | Better Auth |
| GET | `/v1/health` | — (no auth) | `{ status: "ok" }` only |
| GET | `/v1/me` | — | `{ id, email, name }` |
| GET | `/v1/runners` | — | `{ items: Runner[] }` |
| POST | `/v1/runners/pair` | — | `PairingCodeResponse` (one-time code, 10 min) |
| POST | `/v1/runners/:id/revoke` | — | `Runner` (status `REVOKED`; its token stops working; audit kept) |
| POST | `/v1/jobs` | `CreateJobRequest`, header `Idempotency-Key` (required) | 202 `CreateJobResponse` (`streamUrl = /v1/jobs/:id/events`) |
| GET | `/v1/jobs` | `ListJobsQuery` | `JobList` (newest first, cursor pagination) |
| GET | `/v1/jobs/:id` | — | `Job` |
| GET | `/v1/jobs/:id/events` | `afterSequence` or `Last-Event-ID` | SSE stream (below) |
| POST | `/v1/jobs/:id/cancel` | — | 202 `Job` |

Idempotency: same owner + same key + same canonical body → return the original job (202, same `jobId`). Same key + different body → 409 `IDEMPOTENCY_KEY_REUSED`.

Job creation with no online runner is **accepted and stays `QUEUED`** ("held, not lost" — FR-ACC-06). The response never implies execution started.

### Runner endpoints (`Authorization: Bearer <runner token>`, except register)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/v1/runner/register` | `RunnerRegisterRequest` (uses pairing code) | `RunnerRegisterResponse` (token shown once; API stores sha-256 only) |
| POST | `/v1/runner/heartbeat` | `HeartbeatRequest` | `HeartbeatResponse` (`cancelJobIds` = owner-cancelled jobs this runner holds); extends leases of listed jobs it owns |
| POST | `/v1/runner/lease` | — | 200 `LeaseResponse` or 204 after ≤ `RUNNER_LEASE_POLL_MS` long-poll |
| POST | `/v1/runner/jobs/:id/events` | `AppendEventsRequest` | `AppendEventsResponse`; wrong/old `fencingToken` → 409 `STALE_LEASE`; illegal transition → 409 `INVALID_TRANSITION`. Events are stored in the given order, then the transition. A repeated `batchId` for the job returns current `lastSequence`/`status` and appends nothing. Runner calls use the `jobId` as correlation id. |

## Job lifecycle (server is the only writer of state)

1. `POST /v1/jobs`: one transaction → insert job `DRAFT→VALIDATING→QUEUED` (record each as `job.state.changed` events with sequences 1..n, plus `job.created`), audit record, `NOTIFY`.
2. Lease: `SELECT … WHERE status='QUEUED' … FOR UPDATE SKIP LOCKED LIMIT 1` (the jobs table **is** the queue). On claim: `PREPARING`, `runner_id`, `fencing_token = fencing_token + 1`, `lease_expires_at = now + RUNNER_LEASE_TTL_MS`.
3. Runner appends events and drives `RUNNING → VERIFYING → COMPLETED | FAILED`, or `CANCELLED` after it verified the process is gone. Every transition checked with `canTransition`, bumps `state_version`, emits `job.state.changed`.
4. Reaper (every 5 s and at startup): leased jobs (`PREPARING|RUNNING|VERIFYING`) with `lease_expires_at < now` → `RECOVERY_REQUIRED` + `job.recovery_required` event + audit. Never auto-retried.
5. Cancel: `QUEUED` → `CANCELLED` immediately. `PREPARING|RUNNING|VERIFYING` → set `cancel_requested_at`; runner learns via heartbeat and reports `CANCELLED`. Terminal → 409 `INVALID_TRANSITION`.

## SSE contract

`GET /v1/jobs/:id/events` → `text/event-stream`. Replays persisted events with `sequence > cursor` in order, then streams live ones (Postgres `LISTEN/NOTIFY` → in-process fan-out). Each message: `id: <sequence>`, `event: run-event` (`SSE_RUN_EVENT`), `data: <RunEvent JSON>`. Comment heartbeat every 15 s. After the job is terminal and fully replayed, the server sends `event: end` and closes. Reconnects must never start a second execution (GATE-04).

## Runner (apps/runner)

- `node src/main.ts pair --code <CODE> [--name home-studio]` → registers, writes token to `RUNNER_TOKEN_FILE` (default `~/.nexus/runner-token`, mode 0600).
- `node src/main.ts start` → heartbeat every `RUNNER_HEARTBEAT_INTERVAL_MS`, long-poll lease (capacity 1), execute, append events.
- Presets are a fixed allowlist mapped to argv arrays, spawned with `shell: false`, minimal env, fresh temp cwd, 60 s timeout. Never accept a command string from the API.
  - `host-info` → `uname -a`; `node-version` → `process.execPath --version`; `git-version` → `git --version`.
- Event sequence per run: transition `RUNNING` + `workspace.created { hostname, pid, cwd }` → `agent.started { engine: "diagnostic", preset, argv }` → `process.output { stream, text }` batches (redacted, total capped at 64 KB) → `tool.completed { exitCode, durationMs }` → transition `VERIFYING` → `COMPLETED` (`COMMAND_SUCCEEDED`) with `job.completed`, or `FAILED` (`COMMAND_FAILED` / `TIMED_OUT`) with `job.failed`.
- Cancel: SIGTERM, SIGKILL after 5 s, confirm exit, then `CANCELLED` + `job.cancelled { terminated: true }`.
- `STALE_LEASE` → kill the child and drop the job (the server already moved on). If heartbeats fail longer than `RUNNER_LEASE_TTL_MS`, kill the child; the server marks it `RECOVERY_REQUIRED`.
- shortcut: no container/worktree isolation yet — ENG-04 adds it before any repo code runs. Presets touch no repository.

## Web (apps/web)

Vite SPA; dev server on `:5173` proxies `/v1` and `/api/auth` to the API; production build is served by the API from `apps/web/dist`. Login → board shell per `docs/design/NEXUS-v2.dc.html` (PRD Part D) with the Systems zone showing the runner and the Code zone showing runs; Execute → structured preview → queue → run drawer with live terminal.

## Done when

`pnpm typecheck && pnpm lint && pnpm test` pass, and the manual demo works: create owner → log in → pair runner → start runner → Execute `node-version` → watch live output in the browser → refresh mid-run (no duplicate run, events replay in order) → kill runner mid-run → job shows `RECOVERY_REQUIRED`.
