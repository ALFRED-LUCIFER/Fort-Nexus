# Ops wave kickoff — independent work, separate session

Two items (C, D) that need only what is already on `main`. Items A (monitoring) and B (n8n bridge) were delivered by P1 wave 2 and merged via PR #1. They run in their **own git worktree and branch** (`ops`) so they never collide with the MVP session (`main`, `/Volumes/Dev-Zone/Fort-Nexus`) or the P1 session (`p1`, `../Fort-Nexus-p1`).

## 1. Create the worktree (once)

```bash
cd /Volumes/Dev-Zone/Fort-Nexus
git fetch origin
git worktree add ../Fort-Nexus-ops -b ops origin/main
cd ../Fort-Nexus-ops
git config user.name "ALFRED-LUCIFER" && git config user.email "alfred.v.paul@gmail.com"
pnpm install --frozen-lockfile
```

Open a new Claude Code session **in `/Volumes/Dev-Zone/Fort-Nexus-ops`** and paste the prompt below.

## 2. Prompt for the new session

```text
You are working on NEXUS in the ops worktree (/Volumes/Dev-Zone/Fort-Nexus-ops, branch ops).
Two other sessions are active: the MVP session on main (/Volumes/Dev-Zone/Fort-Nexus) and the P1 session on
branch p1 (/Volumes/Dev-Zone/Fort-Nexus-p1). Never edit those folders or .claude/worktrees/*.

Read first: CLAUDE.md, docs/mvp-tracker.md, docs/ops-wave-kickoff.md (this file), docs/PRD.md (Part A–D, §9 epics
named below, §13 API conventions, §16 DoD), docs/specs/* and docs/adr/*. Use the ponytail skill for every task;
production-ready code only. Commit as ALFRED-LUCIFER <alfred.v.paul@gmail.com>. Push branch ops only; never push to
main. Work like the MVP session: write contracts (packages/contracts, NEW files) + a spec (docs/specs/ops-wave.md)
FIRST, then run items C and D below as parallel agents with disjoint folders, then integrate, run all checks
(pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm --filter @nexus/web build &&
node --test scripts/ops.test.mjs), push, open a PR ops -> main, and keep docs/ops-tracker.md as the resume file.

Everything is scoped by projectId (main's workspaces/projects: apps/api/src/workspaces.ts, web useScope in
apps/web/src/board/scope.tsx). Every external write is idempotent + audited; truth hierarchy (PRD §15.3) applies.

(A. monitoring + incidents and B. n8n bridge were DELIVERED by P1 wave 2 and are on main — do not rebuild them;
 see docs/p1-tracker.md. Build only C and D.)

C. Phone push + quiet hours (FR-NTF-03/07/09/11, FR-CSP-03, NFR-CNV-02/12):
   - web push (VAPID keys generated on first run into ~/.nexus/push.json, 0600) with explicit opt-in per device;
     devices table with revoke
   - push body is always redacted (no customer, financial or secret data)
   - deep link to the authenticated run or approval
   - per-category channel preferences, quiet hours in the owner timezone (deferred to digest, urgent categories
     bypass only if configured)
   - delivery retries with backoff; an expired endpoint deactivates the device
   - service worker via vite-plugin-pwa (or a minimal hand-written sw if smaller)
   - Settings -> Notifications tab
   - Owns: apps/api/src/push/**, packages/contracts/src/push.ts, apps/web service worker + Settings
     Notifications tab

D. MVP follow-ups (small, from docs/mvp-tracker.md):
   - active/stopping run count in SystemControls.emergencyStop (STOP banner uses it instead of three list
     queries)
   - server-side unread count that excludes APPROVAL_REQUIRED (an excludeCategory query option); the Inbox badge
     uses it
   - budget reservation: the daily-cap check counts the unspent caps of runs still in flight, so parallel runs
     can't overshoot
   - log rotation for ~/.nexus/logs/*.log
   - Owns: apps/api/src/system.ts, apps/api/src/notifications.ts (count only), scripts/ log rotation, the related
     web bits

Rules:
- Only add new modules/files; shared files (apps/api/src/app.ts route registration, audit resource types,
  contracts index.ts, Board.tsx zone wiring, router.tsx, lib/api.ts) get minimal one-line additions.
- New DB migrations are generated with drizzle-kit (never hand-edit snapshots/journal). P1 adds 0006_p1_wave1; if
  PR #1 (p1) merges to main first, rebase ops and regenerate your migration after it.
- After main changes: git fetch origin && git merge origin/main (no force-push), re-run all checks.
- P1 (research, business, Talk, monitoring, n8n, agents, plans) is already on main; reuse it. Don't start email or
  voice here — they belong to the P1 session's wave 4.
```

## 3. What stays elsewhere

- **MVP session (`main`)**: real run + gate review, merging PR #1 (p1) and later the ops PR.
- **P1 session (`p1`)**: waves 1–3 merged to main (PR #1); wave 4 candidates in `docs/p1-tracker.md`.
