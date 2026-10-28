# MVP tracker — start here when resuming

Single source of truth for delivery progress. Update it at the end of every wave (gate table + "Now"). Any session (new or resumed) reads this first, then `CLAUDE.md`, then the spec of the item it works on.

## How we work (unchanged)

- Ponytail on every task (`ponytail:ponytail`), production-ready code, PRD §16 DoD. No lisec-ai agents here.
- Parallel agents per wave, each owning disjoint folders. The coordinator writes **contracts first** (`packages/contracts`) and a **spec** (`docs/specs/`), then launches agents, then integrates.
- Dependencies only via `node scripts/with-lock.mjs pnpm --filter <pkg> add <name>@<exact-version>`.
- Before every push: `pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm --filter @nexus/web build`, a scan for secret-shaped literals (generate test secrets at runtime), then commit to `main` as `ALFRED-LUCIFER <alfred.v.paul@gmail.com>` (repo-local git config — never the work email) and watch CI (`gh run watch`).

## MVP go/no-go gates (PRD §16.3 + CR-001 items 1, 2, 8)

| Gate | Status | Where |
|---|---|---|
| 01 Private UI; no access without a valid session | ✅ GitHub sign-in, session list/revoke, Tailscale runbook (owner applies it) | `docs/runbooks/remote-access.md` |
| 02 Repos/issues match the GitHub App install | ✅ (stubbed GitHub) | ENG-06 |
| 03 Issue runs Claude on the home host, not the client | ✅ (real model not run yet) | ENG-05/07 |
| 04 Live stream; reconnect replays, no second run | ✅ verified by hand | Spike 0 |
| 05 Isolated workspace; tests captured; draft PR only if allowed | ✅ NEXUS runs the repo's tests in the sandbox (config from the base commit); result is part of the approved hash and the PR | `apps/runner/src/verify.ts` |
| 06 Protected branch / paid ops need authorization | ✅ | ENG-07 |
| 07 Restart / power loss → reconciled, no duplicate PRs | ✅ tested + by-hand crash test | reaper, ledger |
| 08 Cancel stops work; audit kept | ✅ | |
| 09 Daily + per-job budgets enforced | ✅ daily cap (owner timezone) + per-job; lease clamps to remaining; shortcut: in-flight runs can overshoot with >1 parallel run | `apps/api/src/system.ts` |
| 10 Encrypted off-host backup + restore drill + bootstrap runbook | ✅ AES-256-GCM backup, restore drill passed on a disposable stack; owner installs the schedule (`node scripts/runner-service.mjs install`) | `scripts/backup.mjs`, `docs/runbooks/` |
| CR-001 #1 Workspaces/projects, zero cross-project access | ✅ decoy-tested (repo bound to A unusable from B; lists never leak; archived blocks) | `apps/api/src/workspaces.ts` |
| CR-001 #2 Job done/failed → inbox alert → contextual summary | ✅ exactly-once, fact-based notifications + toasts + deep links | `apps/api/src/notifications.ts` |
| CR-001 #8 Host offline → no false execution claim | ✅ | |
| Real run: one real issue → draft PR on a test repo | ❌ needs owner setup (below) | |

## Done (on `main`)

Spike 0 · GitHub sign-in + `github:setup` · ENG-04 sandbox · ENG-05 Claude engine (egress proxy, Anthropic/Foundry) · ENG-06 repo/issue catalog · ENG-07 issue → approved draft PR · **wave 5**: FR-DEV-05 test verification, emergency stop + daily budget + sessions/runners revoke (Settings drawer), Compose deploy + runner/backup services + encrypted backups + restore drill + runbooks. Specs: `docs/specs/`. ADRs: `docs/adr/`. Runbooks: `docs/runbooks/` (start with `bootstrap.md`).

## Now — MVP gate review + real run

Waves 1–6 are on `main` (wave 6: workspaces/projects with decoy-tested isolation, notifications, client-IP rate limiting, `Verification.reason`). Remaining:

1. Gate review on a running stack (`node scripts/nexus.mjs up`), walking every row above; record evidence (commands, screenshots in `docs/design/screens/`).
2. The real run (needs owner setup below): one real issue on a test repo → Claude at home → tests verified → approve → draft PR on GitHub.
3. Known small follow-ups: active-run count in `SystemControls`, server-side unread count excluding approval notices, budget reservation for >1 parallel run, log rotation.

## Owner setup still needed for the real run

1. `pnpm --filter @nexus/api github:setup` → Create on GitHub → install the app on one test repo with a small issue (`docs/runbooks/github-setup.md`).
2. `~/.nexus/ai.json` (mode 600) — Anthropic key or Foundry (`docs/runbooks/ai-provider.md`, personal Azure only).
3. `pnpm --filter @nexus/runner sandbox:build`, start API + runner, sign in with GitHub, pair the runner.

## Parallel P1 session

P1 runs in a **separate git worktree and branch** so it never edits this tree: see `docs/p1-kickoff.md`.
