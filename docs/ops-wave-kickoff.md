# Ops wave kickoff — independent work, separate session

Four items that need only what is already on `main` (MVP waves 1–6). They run in their **own git worktree and branch** (`ops`) so they never collide with the MVP session (`main`, `/Volumes/Dev-Zone/Fort-Nexus`) or the P1 session (`p1`, `../Fort-Nexus-p1`).

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
FIRST, then run the four items below as parallel agents with disjoint folders, then integrate, run all checks
(pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm --filter @nexus/web build &&
node --test scripts/ops.test.mjs), push, open a PR ops -> main, and keep docs/ops-tracker.md as the resume file.

Everything is scoped by projectId (main's workspaces/projects: apps/api/src/workspaces.ts, web useScope in
apps/web/src/board/scope.tsx). Every external write is idempotent + audited; truth hierarchy (PRD §15.3) applies.

A. App monitoring + incidents (EPIC MON, FR-MON-01..07 + 09, MON-G01/G02):
   - application registry per project (app -> environment -> base URL, health path, repo binding)
   - scheduled HTTP health checks with bounded timeout and failure thresholds (in-process scheduler with a
     per-window unique key, like the research schedules on p1; no pg-boss yet)
   - incidents with severity, evidence links and dedup fingerprint; one active incident per fingerprint
   - "observer shares the home host's failure domain" label: when the home host was down, status is UNKNOWN,
     never healthy
   - "Create fix issue" via the GitHub App (draft text shown first, created only after the owner confirms)
   - incident events go through writeEvents so main's notifications apply
   - Systems zone + incident drawer per docs/design/NEXUS-v2.dc.html (dInc)
   - Owns: apps/api/src/monitoring/**, packages/contracts/src/monitoring.ts, web Systems zone + incident drawer

B. n8n bridge (EPIC AUTO, FR-AUTO-01..05/07/08, AUTO-G01..G03):
   - an automation service identity: signed HMAC requests with timestamp + replay window + per-source rate limit
   - POST /v1/automations/trigger accepts ONLY a typed job request for an allowlisted job type and project, and
     goes through the normal job validation, budget and emergency-stop guards
   - forged, stale and shell-text payloads are rejected (tests)
   - workflow catalog (name, trigger, schedule, project, last result) with versioned, audited edits
   - n8n added to infra/compose (pinned image, Execute Command disabled via NODES_EXCLUDE, encrypted credentials,
     loopback only, no Docker socket); docs/runbooks/n8n.md with one example workflow (exported without
     credentials)
   - Automations zone + drawer (dAuto)
   - Owns: apps/api/src/automations/**, packages/contracts/src/automations.ts, infra/compose n8n service,
     infra/n8n/**, web Automations zone

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
- Don't start email, voice, agent team or memory here: they depend on P1 (Talk/research) and come after PR #1
  merges.
```

## 3. What stays elsewhere

- **MVP session (`main`)**: real run + gate review, merging PR #1 (p1) and later the ops PR.
- **P1 session (`p1`)**: finishing PR #1 (merge main, real project scope, push).
