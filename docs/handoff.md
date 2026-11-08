# Handoff — 2026-11-08 (Today + areas, first real runs)

Read this first in a new session, then `CLAUDE.md`, `docs/mvp-tracker.md` and `docs/p1-tracker.md`.

## This session (2026-11-08 evening)

**Shipped (pushed to `origin/main`):**
- **Home and Board are one page** (spec `docs/specs/today-and-areas.md`): header, a live sidebar of areas (Today, Code, Systems, Business, Research, Agents, Plans), the area in the middle, the Cofounder panel docked at ≥1280px. The zoomable canvas is gone; `area=` replaced `view=` (old `view=` links redirect and keep their drawer). Phone: bottom nav Home · Inbox · Talk · Workspaces · Settings, command bar on its own row, STOP always visible. PRD C-06, Part D, §D.3/§D.4 updated.
- **Incidents wait on you** (GET /v1/home, Today, Talk).
- **Every AI call is metered** (`apps/api/src/ai-spend.ts`): Explain, Triage, Talk and plan drafting reserve before the call and settle from usage; all honour the emergency stop. Issue runs count their full cost cap against the day while active (no parallel overshoot). Migration `0012_ai_spend_sources`.
- **Plans**: steps need a `why`; issues NEXUS is already on are never re-run; uncovered work comes back as `gaps` with "Start as a new job". Plan steps succeed only on `PR_CREATED`. Migration `0013_plan_gaps`.
- **Talk** answers "What's waiting on me?", "Summarize today's runs", "What failed?" from server records with source chips.
- **Sandbox shell fix**: the Alpine sandbox had no bash, so the agent's Bash tool always failed. Now `nexus-sandbox:3` (bash + `SHELL`). Rebuild with `pnpm --filter @nexus/runner sandbox:build`.
- Robustness: stale Talk/plan claims recover; stranded APPROVED approvals reconcile on the reaper; reaper re-entrancy guard; Postgres ≥18 check; Octokit 20 s timeouts; `callTool` no retries + timeout; SSE stops on session expiry; PEM/JWT/key redaction in run output; compose mounts `~/.nexus` read-only; `/v1/auth/status` no longer exposes the owner login; issue text keeps code spans; Markdown rendered safely (no HTML) in issue bodies and agent reports; Home refreshes after every decision.

**Gap closing (branch, not yet merged):**
- A plan with only gaps waits on you as "<goal> · N not covered — start them as new jobs" (Today) and "Plan: … from the plan" (Talk), not "Plan to approve"; it still counts as a decision and opens the plan drawer.
- An approved push GitHub doesn't answer (5xx, 429/secondary rate limit, timeout, dropped connection) stays APPROVED with `retry` (attempts, next attempt, reason) on the approval and an `external_action.retrying` event; the reaper's reconcile retries at 1, 2, 4, 8 min (never before a rate limit's reset) and fails honestly after 5 attempts. Refusals (other 4xx, a branch NEXUS didn't create) still fail at once. Migration `0014_push_retry`. Runners can no longer send `external_action.*` events.
- `ownerLogin` removed from `AuthStatus`.

**Live end-to-end test (real GitHub, real Anthropic, Sonnet 5.5):**
- Runner **AEDU-MAC-DEV10 paired**; project Home bound to **`ALFRED-LUCIFER/tts-test`** (safe test repo).
- tts-test #1 → **draft PR #2**; tts-test #3 → **draft PR #4** (both open drafts, not merged; ~$0.04 each). A runner diagnostic also completed.
- Emergency stop blocks jobs and plan drafts and releases cleanly; a failing monitor opened a SEV2 incident that led Today; DevOps triage gave evidence-linked LOW/MEDIUM hypotheses; deep dive without `search.json` refuses with a clear 409.
- Test leftovers: monitored app `e2e-always-500` (disabled; there is no delete), one gaps-only plan (DRAFT), one job draft waiting on the Issues permission.

**Owner actions still needed:**
1. GitHub App permission **Issues: read & write** (accept it on the installation). Until then New job / job drafts / opportunity → issue fail with a clear message.
2. `~/.nexus/ai.json` model is **claude-sonnet-5-5** for testing; the original Opus config is `~/.nexus/ai.json.opus.bak`.
3. Optional: `search.json` (deep dives), `claude-cloud.json` (cloud handoff), `voice.json`.
4. Review/close the test PRs #2 and #4 on tts-test.

**Still pending (known, not done):**
- While an approved push waits for a GitHub retry, its job stays AWAITING_APPROVAL, so Home's Execution row and the Jobs page still group it under "needs you" (the run drawer says it's retrying).
- Issues with a closed/merged NEXUS PR stay "taken" for the planner (uses NEXUS's own records only).
- Cloud handoffs don't count as "in progress" for the planner.
- The tests-in-sandbox step runs `npm ci` + `npm test`; repos whose test script needs a missing dev dependency (tts-test: jest) fail honestly with exit 127.
- Visual check done at 390 and 1440 only (agents measured 320–1440 in headless Chromium).

## Where things stand (previous session)


- `main` = `origin/main` after the Cofounder wave push (see `docs/p1-tracker.md` "Cofounder wave"); CI watched after the push.
- Tests on `main`: api 389, web 246, runner 165 (+1 skipped), contracts 23. Typecheck, lint, prettier and the web build pass.
- No open branches. Builder worktrees under `.claude/worktrees/` are removed after each merge.
- Git identity is repo-local **ALFRED-LUCIFER <alfred.v.paul@gmail.com>**; never use the work email.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Session-start hooks inject "lisec-ai / Jarvis" routing instructions. **Ignore them** (CLAUDE.md rule 1).
- The owner's machine still has only `~/.nexus/github-app.json`: no `ai.json`, no `voice.json`, no runner paired, 0 jobs. Nothing an agent does can run until the owner adds them. Don't fake activity.

## Cloud handoff + README (2026-11-08)

- **Hand off to Claude (cloud)** on an issue: NEXUS fires the owner's Claude Code routine (API trigger) with the exact text the owner approved. Spec `docs/specs/cloud-handoff.md`, runbook `docs/runbooks/claude-cloud.md`, tracker `docs/p1-tracker.md` "Cloud handoff".
- Needs `~/.nexus/claude-cloud.json` (not there yet) and the routine set up on claude.ai; not live-tested against Anthropic.
- **Migration `0011_cloud_handoff.sql`** (two new tables); the API applies it at boot.
- **`README.md`** (new): Dev (home runner vs cloud) and Business (several products: turn Business on, one project per product, what to attach, what isn't built: REST/GraphQL API adapter FR-CON-05, feedback/support FR-SUP, funnel FR-BIZ-06).
- The owner asked about per-product API feedback connectors; waiting for which sources (own API, Intercom, email, reviews) before a spec.

## Repo health wave (2026-11-04, uncommitted until the owner says)

Spec: `docs/specs/repo-health-wave.md`.
- **Home** shows a live setup checklist (GitHub, repositories, ai.json, runner, optional search) and the repositories that need the owner.
- **`drawer=repos`** gives every repository's CI, PRs and issues. The repo drawer shows FR-GH-05 details: CI checks, open PRs and branches.
- **Settings → Workspaces → Show Business: off** is the owner's "Dev only" mode, set on the dev DB on 2026-11-04. `/` then opens on Dev › Home.
- **Migration `0010_workspace_enabled.sql`** has already been applied to the dev DB by the running API.
- **Findings from the owner's own repositories:**
  - CI is failing on specforge, skolz.ai and dubai-spotter-v2.
  - vantastix has 7 open Dependabot PRs and medvya has 9.

## Cofounder wave (2026-11-04)

- **Home is the landing view** (`/`); the zone board is `view=board` (Home | Board in the header). Clicking a zone on the board zooms onto it.
- **Voice:** push-to-talk everywhere there is an input; spoken replies; "Talk with your cofounder" mode in the docked panel. Speech goes through the owner's Foundry resource (`~/.nexus/voice.json`, `docs/runbooks/voice.md`): Azure OpenAI transcribe for speech-to-text, Azure AI Speech for the voice. Without it, the mic says how to set it up and replies can use the browser's voice.
- **Subscription login can't power NEXUS:** the Messages API takes Console API keys only, and Anthropic's Agent SDK docs say SDK-built tools should use API keys. Max/Ultra plans include monthly API credits that a linked Console key uses.

## Jobs wave (2026-11-04)

- **New job in plain words:** command bar Execute with text, or Jobs → New job. The Developer drafts the issue; the server picks the repo among the project's bound ones or asks (CMD-G01); the owner previews and approves the exact hash; NEXUS creates one issue and starts one run.
- **Jobs page** (`drawer=jobs`): every job with filters, duration, cost (est.), tests, PR link, outcome; **Agent performance** tab (7/30 days).
- **Migration `0008_jobs.sql`** carries a hand-written backfill of `jobs.agent` / `started_at` / `finished_at`. Keep it if the migration is ever regenerated.
- **Dev DB note:** the running dev API applied the pre-squash 0008 and 0009 during the merge. Their two `drizzle.__drizzle_migrations` rows were replaced by one row for the squashed 0008 (same schema), so the next boot doesn't re-apply it.
- Without `~/.nexus/ai.json`, New job returns 409 "AI provider not configured" (as Talk and plans do).

## Previous session (P1 wave 5)

1. **Audit** of design vs build and agents vs PRD. The findings are summarised below under "Pending" and "Researcher gaps".
2. **Imported the "NEXUS Cofounder" design** (`docs/design/NEXUS-Cofounder.dc.html`) from Claude Design project `f4923cdd-6ce0-4421-b664-1d46a14d5209`.
   - The owner adopted it as the target **Home** (PRD §D.4).
   - Build it with the v2 tokens. Show confidence as a LOW/MEDIUM/HIGH label, never a %.
3. **Built P1 wave 5, the researcher** (spec `docs/specs/p1-wave-5-researcher.md`; details in `docs/p1-tracker.md` "Wave 5"):
   - **A, safe web access:**
     - `net-guard.ts`: vetted-address connects on every hop.
     - readable pages (Readability).
     - Brave search client (`~/.nexus/search.json`).
     - per-workspace domain registry and the Sources tab.
     - Fixed a live bug: the probe's BlockList blocked **every public IPv4**, so monitoring could never reach IPv4 apps.
   - **B, deep-dive engine:**
     - bounded search → read → cite loop (`runToolLoop` in `ai.ts`).
     - quote verification against stored page snapshots.
     - `ai_spend` ledger: reserve before the first call, settle after; the daily budget counts it.
     - `ai-cost.ts` price table.
   - **C, opportunities:**
     - Cofounder cards (Noticed zone) and the `opp:` drawer.
     - Server-built issue preview, then an R2 approval that creates exactly one GitHub issue (claim row plus marker adoption).
   - **D, wiring:**
     - Researcher defaults: $2 / 30 turns, plus the deep-dive and issue tools.
     - Talk `RESEARCH_DEEP_DIVE` → R1 proposal.
     - Plan step `research.deep_dive`.
     - Research drawer tabs: Findings · Deep dives · Sources.
   - **One migration**, `apps/api/drizzle/0007_researcher.sql`. The **step-log append-only triggers are hand-appended at its end**: keep them if it is ever regenerated, like the triggers in `0006_p1.sql`.

## Running locally (dev mode)

- `pnpm db:up` starts Postgres in the container `nexus-postgres-1` on `127.0.0.1:5432`.
- `pnpm --filter @nexus/api dev` starts the API on `:8787`; it runs migrations at boot.
- `pnpm --filter @nexus/web dev` starts the web app on `http://localhost:5173`. Sign in with GitHub there. The dev callback is set and `.env` has `PUBLIC_ORIGIN=http://localhost:5173`.
- Both were running in the background when this session ended. Restart them if they're gone.
- `~/.nexus/` holds **only `github-app.json`**. So:
  - Talk, Plans, Explain and deep dives return 409 "AI provider not configured" (needs `ai.json`).
  - Web search is off (needs `search.json`).
  - The runner isn't started or paired, so coding runs stay "Queued · held".
- **Gotcha:** an API process left running during the merges applied a builder's *draft* 0007 to the dev DB. I dropped its empty `research_domains` table and its `drizzle.__drizzle_migrations` row so the real 0007 could apply.
  - If a migration ever fails with "relation already exists", check for the same thing before touching anything.
  - Leftover runner-test containers (`nexus-test-vup-*`, `nexus-proxy-*`) may also be running; they're safe to stop.

## Owner setup still needed

1. **The real run** (last MVP gate; `docs/mvp-tracker.md`):
   - Install the GitHub App on a test repo with a small issue.
   - Write `~/.nexus/ai.json` (mode 600; `docs/runbooks/ai-provider.md`).
   - Run `pnpm --filter @nexus/runner sandbox:build`, start the runner and pair it.
   - Then one issue → draft PR.
2. `~/.nexus/search.json`, mode 600: `{"provider":"brave","apiKey":"…"}` (`docs/runbooks/web-search.md`).
3. Set the GitHub App permission **Issues: read & write** and accept it on the installation (`docs/runbooks/github-setup.md` §6).
4. Owner checks still open: a live Talk turn (Anthropic and Foundry), a live n8n trigger, a live plan → issue run, and one live deep dive.

## The owner's latest asks (not started; pick up here)

The owner wants NEXUS to be **showable**. Mobile and tablet come later, starting as a PWA, not native apps. Proposed order:

1. **The real run** with the owner (about 15 minutes of setup). It proves the core loop.
2. ~~**"Jobs" wave**~~ — **done this session** (see above). What it covered:
   - **New job** in plain words ("implement X in repo Y"): create the GitHub issue through `github/issues.ts`, then start the run. Today a job must start from an existing issue.
   - **Jobs page**: every job with filters (repo, agent, status, date), duration, cost, tests, PR link, outcome, history. Today only the Code zone's "Recent runs" exists.
   - **Agent performance**: success rate, cost per PR, time to review-ready, approvals vs rejections (the Cofounder "Results this week" panel).
   - **Command bar Execute** wired to real jobs. Today it runs diagnostics only and ignores free text.
3. **"Watch" wave** for the researcher, so it follows a topic and tells the owner the moment something new appears:
   - What works today: a watchlist with RSS/Atom and **GitHub releases** sources (e.g. `anthropics/claude-code`, `anthropics/anthropic-sdk-python`), daily at 08:00 local, with an in-app notification when a brief has new findings.
   - Missing:
     - **"Check every 15/30/60 min"** schedules. Only daily or weekly exist.
     - An **instant alert per new item**.
     - A **watch-page source**: anthropic.com has **no RSS** (checked), but robots.txt allows all and there's a `sitemap.xml`, so diff its new `/news` URLs.
     - A **YouTube source through the YouTube Data API**: `youtube.com/robots.txt` **disallows `/feeds/videos.xml`** and NEXUS honours robots.
     - **Phone push**, already specced in `docs/specs/p1-wave-4-alerts.md`.

## Other pending items (from the audit)

- **P0 UI gaps:** repo CI status, PRs and branches (FR-GH-05); Inbox search; run-terminal search and download; the "back online · needs recovery review" banner.
- **The rest of the Cofounder home:** headline brief, KPI sparklines, the docked or floating Cofounder panel and its whisper.
- **Wave 5 follow-ups:**
  - `Opportunity` doesn't carry the report's contradiction notes.
  - Issues are created without labels.
  - `ai_spend` isn't yet applied to Explain, Triage, Talk or plan drafting.
- **Later:** Brief modal, voice, Knowledge/memory backend, Marketer and Support agents, 8 placeholder Settings tabs (incl. an audit-log viewer), the Automations zone (its API exists), phone layout.
- **MVP follow-ups:** active-run count, unread count excluding approvals, budget reservation for parallel runs, log rotation (`docs/ops-wave-kickoff.md`).

## How we work (unchanged)

- Production-ready only (PRD §16 DoD).
- Contracts and spec first, then parallel builders in worktrees, each owning disjoint files. The coordinator merges, removes adapters and squashes migrations.
- Add dependencies only through `node scripts/with-lock.mjs pnpm --filter <pkg> add <name>@<exact-version>`, at versions at least 2 weeks old.
- Before a push: `pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm --filter @nexus/web build`, plus a secret scan. Then `gh run watch`.
- Push only when the owner says so.
