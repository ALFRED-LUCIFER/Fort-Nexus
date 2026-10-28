# P1 tracker — start here when resuming the P1 session

Branch `p1` in the worktree `/Volumes/Dev-Zone/Fort-Nexus-p1`. Never edit `/Volumes/Dev-Zone/Fort-Nexus` (MVP session on `main`). Push `p1` only; merge to `main` by PR after the MVP gates in `docs/mvp-tracker.md` are green.

## How we work

Same as `docs/mvp-tracker.md`: Ponytail, production-ready, PRD §16 DoD, contracts + spec first, then parallel agents (each in its own git worktree off `p1`), and the coordinator merges. Before every push: `pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm --filter @nexus/web build`, plus a secret scan. Commit as `ALFRED-LUCIFER <alfred.v.paul@gmail.com>`.

After each MVP wave lands on `main`: `git fetch origin && git rebase origin/main`, regenerate the P1 migration on top of main's latest one (delete ours, `pnpm --filter @nexus/api db:generate`), and re-run all checks.

## Wave 1 — in progress (spec: `docs/specs/p1-wave-1.md`)

| Agent | Scope | Status |
|---|---|---|
| A — Research | `apps/api/src/research/**`, Research zone + drawer | running |
| B — Business | `apps/api/src/business/**`, Business zone + drawer, connector runbook | running |
| C — Talk (text) | `apps/api/src/conversations/**`, `apps/api/src/ai.ts`, Talk drawer | running |
| D — Motion | `apps/web` animation wrappers | running |

Done first by the coordinator: contracts `research.ts` / `business.ts` / `conversations.ts`, `apps/api/src/scope.ts` (placeholder project scope, `shortcut:`), audit resource types, drizzle config schema array.

Merge step (coordinator): merge the agent branches, regenerate one combined migration, wire `BUSINESS_METRIC` / `RESEARCH_SEARCH` intents to modules A/B, run all checks, update this file.

## Deferred (named, not built)

pg-boss (window unique key covers schedules), embedding-based semantic dedupe, LLM "why it matters" in briefs, Supabase MCP (read-only role instead), FR-DATA-04 migration workflow, FR-BIZ-04..06 (refunds, products, funnel), voice (FR-CWV-02/03).
