# P1 tracker — start here when resuming the P1 session

Branch `p1` in the worktree `/Volumes/Dev-Zone/Fort-Nexus-p1`. Never edit `/Volumes/Dev-Zone/Fort-Nexus` (MVP session on `main`). Push `p1` only; merge to `main` by PR after the MVP gates in `docs/mvp-tracker.md` are green.

## How we work

Same as `docs/mvp-tracker.md`: Ponytail, production-ready, PRD §16 DoD, contracts + spec first, then parallel agents (each in its own git worktree off `p1`), and the coordinator merges. Before every push: `pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm --filter @nexus/web build`, plus a secret scan. Commit as `ALFRED-LUCIFER <alfred.v.paul@gmail.com>`.

After each MVP wave lands on `main`: `git fetch origin && git rebase origin/main`, regenerate the P1 migration on top of main's latest one (delete ours, `pnpm --filter @nexus/api db:generate`), and re-run all checks.

## Wave 1 — done on `p1` (spec: `docs/specs/p1-wave-1.md`)

| Agent | Delivered | Gherkin tests |
|---|---|---|
| A — Research | `apps/api/src/research/**`: watchlists, feeds + GitHub releases, robots/auth/size/rate policy, canonical URL + title near-dupe, PRIMARY/CORROBORATED/UNVERIFIED labels, weighted score, one run per local window, full-text history; Research zone + drawer (Brief button opens it) | RES-G01..G04 |
| B — Business | `apps/api/src/business/**`: connector registry (0600 credential files), read-only gateway (READ ONLY tx, statement timeout, allowlist, masked aggregates only), metric dictionary, `getSalesSummary`/`getPaymentFailures` with provenance + partial-day; Business zone + drawer; `docs/runbooks/business-connector.md` | DATA-G01..G04, BIZ-G01 |
| C — Talk (text) | `apps/api/src/conversations/**`, `ai.ts`: threads/turns (append-only, idempotent), intent router (validated tool call), source-linked replies with basis, server-hashed proposals → `createJob` once; Talk drawer | FR-CWV-01/04/05/07, FR-CXR-03..05/07 |
| D — Motion | `motion@14.7.1`, `MotionConfig reducedMotion="user"` + `LazyMotion`, drawer spring enter/exit, zone moves; focus returns to the opener | reduced-motion + focus tests |

Coordinator: one combined migration `0003_p1_wave1.sql` (conversation triggers hand-appended at the end — keep them when regenerating), Talk wired to business metrics and research search, `ResearchRun.error`.

Checks on the merged tree: typecheck, lint, prettier, tests (api 126, web 69, runner 136+1 skipped, contracts 13), web build.

## Wave 2 — in progress (spec: `docs/specs/p1-wave-2.md`)

`main` (MVP waves 5 + 6) merged into `p1` at `58007e0` (merge, not rebase: one conflict resolution, no force-push). P1 migration is now `0006_p1_wave1` after main's 0003–0005.

| Agent | Scope | Status |
|---|---|---|
| S1 — Research scope | real projects, decoy tests, pinned `searchFindings` / `getWatchlist` / `createManualRun` | running |
| S2 — Business scope | Business-mode projects, pinned `BusinessScope`, main's Business empty-state test | running |
| S3 — Talk scope | thread project confines every tool; proposals carry `projectId`; command bar Ask → Talk; toast Talk button | running |
| M — Monitoring | apps, SSRF-safe health checks, one incident per fingerprint, UNKNOWN when unobserved | running |
| N — Automations | n8n clients (HKDF-derived keys), signed typed triggers, runs history, runbook | running |

Coordinator first: `resolveProject` / `ownerWorkspaceIds` in `workspaces.ts` (tested), `projectId` on P1 contracts, `monitoring.ts` / `automations.ts` contracts, `subject.incidentId` on notifications.
Merge step: remove adapters, delete `scope.ts`, re-squash P1 migration (keep conversation triggers), end-to-end Talk tests per project, all checks, push, update PR #1.

## Next

- Owner check: one live Talk turn on Anthropic and on Foundry.
- Wave 3 candidates: agent registry + orchestrator (V1C), LLM "why it matters" in briefs, FR-BIZ-04..06, voice (FR-CWV-02/03).

## Deferred (named, not built)

pg-boss (window unique key covers schedules), embedding-based semantic dedupe, LLM "why it matters" in briefs, Supabase MCP (read-only role instead), FR-DATA-04 migration workflow, FR-BIZ-04..06 (refunds, products, funnel), voice (FR-CWV-02/03), node reflow animation inside zones.
