# ADR-0002: PostgreSQL-only queueing (jobs table now, pg-boss for schedules)

- Status: Accepted (2026-10-28) · PRD: Part A, C-02, DEC-16

## Context
v1.0 picked Redis/BullMQ, but also requires minimal home dependencies, exactly-once external effects and a durable state machine in Postgres.

## Decision
- The `jobs` table is the dispatch queue: runners lease with `SELECT … FOR UPDATE SKIP LOCKED`, every lease bumps a fencing token, expired leases go to `RECOVERY_REQUIRED`.
- Job creation, its state events and audit record commit in one transaction; `LISTEN/NOTIFY` wakes waiting runners and SSE streams.
- pg-boss (also Postgres-only) is added in P1 for cron schedules and retried background work.

## Consequences
- No Redis to run, secure or back up; one source of truth for job state.
- Throughput ceiling is far above P0–P2 needs (1–few concurrent runs). Revisit with measured load.

## Amendment (2026-10-28, P1 wave 1)
Research brief schedules don't need pg-boss: a unique `(watchlist_id, window_date)` key on `research_runs`, filled by an API interval tick with `on conflict do nothing`, gives exactly-once per window (RES-G01). Add pg-boss only when retried background work actually needs it.
