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

## Next

- Rebase onto `main` after MVP wave 5/6 lands; then swap `scope.ts` to the real workspace/project model and add decoy cross-project tests (NFR-CNV-05).
- Wave 2 candidates: LLM "why it matters" in briefs, FR-BIZ-04..06, Talk in the command bar (Ask mode), voice (FR-CWV-02/03), Agents view regrouping animation.
- Owner check: one live Talk turn on Anthropic and on Foundry (router uses `tool_choice: auto` — forced tool choice was rejected by the default model).

## Deferred (named, not built)

pg-boss (window unique key covers schedules), embedding-based semantic dedupe, LLM "why it matters" in briefs, Supabase MCP (read-only role instead), FR-DATA-04 migration workflow, FR-BIZ-04..06 (refunds, products, funnel), voice (FR-CWV-02/03), node reflow animation inside zones.
