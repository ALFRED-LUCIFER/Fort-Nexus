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

## Wave 2 — done on `p1` (spec: `docs/specs/p1-wave-2.md`)

`main` (MVP waves 5 + 6) merged into `p1` (merge, not rebase). All P1 tables are one migration `0006_p1.sql` after main's 0005; the conversation triggers are hand-appended at its end — keep them whenever it is regenerated.

| Agent | Delivered | Tests |
|---|---|---|
| S1 — Research scope | watchlists/findings/runs in real projects; scheduler skips archived projects; `searchFindings(db, ownerId, q)`, `getWatchlist`, `createManualRun` | decoy B, other owner, archived 409 |
| S2 — Business scope | connectors only in Business projects (403 otherwise); tools see only their project; Dev/All honest states | decoy B, mode 403, archived 409 |
| S3 — Talk scope | every tool confined to the thread's project; proposals only for repos bound to it; command bar Ask → Talk; toast Talk opens a thread about the run | decoy B, RES-G03 wording, archived 409 |
| M — Monitoring | apps, SSRF-safe probe (vetted IP, no redirects, 64 KB), one incident per fingerprint, notification once, UNKNOWN when unobserved; Systems zone + `incident:` drawer | MON-G01, MON-G02, SSRF + DNS rebinding |
| N — Automations | n8n clients (HKDF-derived keys, never stored), signed typed triggers, per-client rate limit, run history; Settings → Automations; `docs/runbooks/n8n.md` | AUTO-G01..G03 |

Coordinator: `resolveProject` / `ownerWorkspaceIds`, contracts, adapters removed, `scope.ts` deleted, migration squashed.
Checks on the merged tree: typecheck, lint, prettier, tests (api 215, web 114, runner 165+1 skipped, contracts 16), web build.

## Wave 3 — in progress (spec: `docs/specs/p1-wave-3.md`)

| Agent | Scope | Status |
|---|---|---|
| A — Agent registry | roster, append-only versioned profiles (project > workspace > default), global ceiling, Agents grouping + drawer, Talk pins Chief of Staff version | running |
| B — Plans | goal → typed step plan, owner approves exact hash, one-step-at-a-time executor, success only from source records, Plans & queue zone, command bar Plan | running |
| C — AI explanations | finding "why it matters", incident triage: cache-once, citations checked, labelled AI inference | running |
| D — Revenue + products | gross/refunds/net with exact formula, top products (masked), Talk answers | running |

Coordinator first: contracts `agents.ts`, `plans.ts`, explanation/triage/revenue/top-products, `Thread.profileVersionId`.
Merge step: delete `agent-profile-adapter.ts` files, re-squash P1 migration (keep conversation + agent-profile triggers), all checks, push, update PR #1.

## Next

- Owner check: one live Talk turn on Anthropic and on Foundry.
- Owner check: one real n8n workflow against `/v1/automations/trigger` (runbook untested against live n8n).
- Wave 3 candidates: agent registry + orchestrator (V1C), LLM "why it matters" in briefs and incident triage, FR-BIZ-04..06, voice (FR-CWV-02/03), code-split the web bundle (892 kB).

## Deferred (named, not built)

pg-boss (window unique key covers schedules), embedding-based semantic dedupe, LLM "why it matters" in briefs, Supabase MCP (read-only role instead), FR-DATA-04 migration workflow, FR-BIZ-04..06 (refunds, products, funnel), voice (FR-CWV-02/03), node reflow animation inside zones.
