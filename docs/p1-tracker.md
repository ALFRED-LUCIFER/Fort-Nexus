# P1 tracker — start here when resuming the P1 session

> **Merged to `main` (2026-10-28):** PR #1 (P1 waves 1–3) at `87bbc5f`, plus test follow-ups PR #2 (`96ffa2b`, ordered audit lookups, web test timeout, test Postgres `max_connections`) and PR #3 (`13b0c8f`, runner verify-tail ordering). `main` CI green on `13b0c8f`. Next P1 work branches from `main` again.

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

## Wave 3 — done on `p1` (spec: `docs/specs/p1-wave-3.md`)

| Agent | Delivered | Tests |
|---|---|---|
| A — Agent registry | 7 agents, append-only versioned profiles (project > workspace > default), global ceiling (AUTONOMOUS only with R0/R1 tools, coding engine only Developer/QA, cost/turn caps), Agents grouping + drawer + Settings tab, Talk pins the Chief of Staff version | resolution, ceiling, append-only, pinning, decoy |
| B — Plans | goal → typed steps (model drafts, server blocks/hashes), owner approves exact hash, one step at a time, success only from source records, restart-safe idempotency keys, notifications, Plans zone + drawer, command bar Plan | FR-AGT-01/09, executor races + crash, narrowing, emergency stop, decoy |
| C — AI explanations | finding "why it matters" + incident triage: cache-once claim rows, citations limited to own evidence, labelled AI inference | cache-once incl. concurrency, citation rejection, decoy |
| D — Revenue + products | gross/refunds/net (refund-day), top products masked in SQL, Talk answers | cross-midnight cents, masking, NOT_DEFINED, decoy |

Coordinator: contracts first; adapters removed (real `resolveAgentProfile` everywhere); agent records count plan steps; plan issue-run budgets narrowed to the agent's caps before hashing (and re-checked before running); Developer default caps $5 / 60 turns; return lines → NOT_DEFINED; shortcut comments for known limits; one squashed `0006_p1.sql` with the conversation and agent-profile triggers re-appended.
Checks on the merged tree: typecheck, lint, prettier, tests (api 258, web 141, runner 165+1 skipped, contracts 19), web build.

## Wave 5 — the researcher (done on `main`, not pushed; spec: `docs/specs/p1-wave-5-researcher.md`)

Owner decisions (2026-11-03): web search = **Brave Search API** (NEXUS calls and audits it itself); the **NEXUS Cofounder** design (`docs/design/NEXUS-Cofounder.dc.html`, PRD §D.4) is the target Home, so opportunities render as Cofounder cards.

| Builder | Delivered | Tests |
|---|---|---|
| A — Safe web access | `net-guard.ts` (vetted-address dispatcher on every hop, robots and Brave included), charset, `readPage` (Readability + linkedom), Brave client + `~/.nexus/search.json`, per-workspace domain registry + Sources tab, `docs/runbooks/web-search.md`. **Fixed a live bug:** `BLOCKED` refused every public IPv4 (`::ffff:0:0/96` in a BlockList), so monitoring probes could never reach an IPv4 app | RES-G05, rebind, charset, Brave mapping, decoy |
| B — Deep-dive engine | `ai_spend` ledger (reserve before the first call, settle after; budget counts it), `ai-cost.ts` (claude-api skill prices), `runToolLoop` (cached, fenced, cost/turn/time/stop limits), `research/deep/**` (≤2 running, reconcile at boot, quote verification, labels, notifications) | RES-G06..G11, restart, decoy |
| C — Opportunities + issue | `research/opportunities/**`, server-built issue preview (mentions/links neutralised, marker), R2 create with a claim row + marker adoption (no duplicates), `github/issues.ts`, `issues: write` in `github:setup`, Noticed zone + `opp:` drawer | RES-G12, hash/permission/decoy |
| D — UI, Talk, plans, agents | AI researcher defaults ($2 / 30 turns, deep-dive + issue tools), Talk `RESEARCH_DEEP_DIVE` → R1 proposal, plan step succeeds only on COMPLETED, Research drawer tabs (Findings · Deep dives · Sources) with live dives and reports | Talk/plans/web a11y |

Coordinator: adapters removed and modules wired; `DeepDive.opportunityId` (set in the completing transaction) replaces the list lookup; FK `research_opportunities.deep_dive_id → research_deep_dives`; Sources calls moved into `lib/api.ts`; one migration `0007_researcher.sql` with the step-log append-only triggers appended by hand (keep them when regenerating); Brave error-mapping test de-flaked.
Checks on the merged tree: typecheck, lint, prettier, tests (api 332, web 172, runner 165+1 skipped, contracts 23), web build, secret scan.

Owner setup: `~/.nexus/search.json` (`{"provider":"brave","apiKey":"…"}`, mode 600, `docs/runbooks/web-search.md`); GitHub App permission **Issues: read & write**, accepted on the installation (`docs/runbooks/github-setup.md` §6). Then one live deep dive (owner check).

Known follow-ups: `Opportunity` doesn't carry the report's contradiction notes (drawer flags CONTESTED only); issues are created without labels (GitHub drops them for apps without push); ai_spend not yet applied to Explain/Triage/Talk/plan drafting; single-process assumptions in the diver (marked `shortcut:`).

## Jobs wave (done on `main`, not pushed; spec: `docs/specs/jobs-wave.md`)

The owner wants NEXUS showable (`docs/handoff.md`). This wave lets a job start from plain words and shows every job and how agents perform.

| Builder | Delivered | Tests |
|---|---|---|
| A — Jobs history + performance API | `job-history.ts`: `GET /v1/jobs/history` (repo, agent, status-group and local-date filters; duration, cost, tests from NEXUS's own verification, PR only from an EXECUTED approval; one query per page), `GET /v1/agents/performance` (7/30 local days, every agent, success rate, PRs, cost incl. ai_spend, cost per PR, median time to review-ready, approval decisions) | filters incl. a UTC+5:30 day boundary, paging, numbers, decoy project/owner |
| B — Job drafts API | `job-drafts/**`: plain words → one Developer model call (spend reserved $0.25, settled) → READY / NEEDS_REPO (CMD-G01: the server resolves the repo among bound ones, never guesses) / UNSUPPORTED; edit, preview (R2 new issue / R1 existing), approve on the exact hash: claim before GitHub, marker adoption, `createJob` under `job-draft:<id>`; FAILED keeps the issue and resumes. `github/issue-text.ts` (shared neutralisers), `callTool` returns `usage`, Developer gets `github.issues.create` | CMD-G01, unbound repo, UNSUPPORTED, invalid output, budget/stop before the call, concurrency, hash binding, one issue + one job under retries and crashes, decoy |
| C — Jobs page | `jobs.tsx`: Jobs drawer (`drawer=jobs`) with All jobs (filters, rows, load more, honest states, New job) and Agent performance (7/30 toggle, per-agent cards, estimates note); Code zone "All jobs" link | filters, PR link only when present, states, keyboard, performance "—" cases |
| D — New job + Execute | `newJob.tsx`: New job (`drawer=newjob`) and the job-draft drawer (`drawer=jobdraft:<id>`: choose repo, AI-drafted editable issue, budget, runner, preview → approve, Created #n only from GitHub, FAILED retry, discard); command bar Execute with text drafts a job, without text keeps the diagnostic preview | draft states, retry keys, approve only after preview, a11y |

Coordinator: contracts first (`job-history.ts`, `job-drafts.ts`, `AgentKey` moved to `agent-key.ts` to avoid an import cycle, `Job.agent/startedAt/finishedAt`); one migration `0008_jobs.sql` with a **hand-written backfill** (job agent from its plan step or job type; start/finish from its state events; keep it when regenerating); preview accepted on FAILED drafts; a failed approve now drops its stale preview (the hash changes once the issue exists); one shared web agent-label table (`agentLabels.ts`).
Checks on the merged tree: typecheck, lint, prettier, tests (api 362, web 210, runner 165+1 skipped, contracts 23), web build, secret scan (no literals; gitleaks runs in CI).

Owner checks: one live draft → issue → run (needs `ai.json` and Issues: read & write), and the Jobs page on real runs.

Known follow-ups: the preview of a new issue checks the issues permission only, not contents/pull requests (the run then fails FAILED and resumes once fixed); Recent drafts shows the newest 20 without load more; "Rewrite" passes the text through the query cache (no router param); the Cofounder "Results · this week" panel can now be built on `GET /v1/agents/performance`.

## Cofounder wave (on `main`; spec: `docs/specs/cofounder-wave.md`)

The owner asked (2026-11-04) for the Cofounder home and "calling": talking with the Cofounder by voice, done the best way for Microsoft Foundry.

| Builder | Delivered | Tests |
|---|---|---|
| A — Home summary API | `home.ts`: `GET /v1/home` — deterministic headline (no model call), decisions waiting (+ top 5), 4 KPIs with 7-day series and previous week (review-ready median, NEXUS test pass rate, runs today, waiting on you), per-agent activity with server-built "doing" and cost today, execution with the latest run stage, results for 7 days | KPIs incl. null days and a UTC+5:30 boundary, agent states, headline variants, decoy project/owner |
| B — Voice gateway API | `voice/**`: `~/.nexus/voice.json` (Foundry resource + key; transcribe deployment; Azure AI Speech region/voice), `GET /v1/voice/status` (provider + retention disclosure), settings (mic and spoken replies off by default), `POST /v1/voice/transcribe` (raw webm/mp4/ogg/wav/mpeg ≤ 10 MB / 120 s → Azure OpenAI transcribe), `POST /v1/voice/speak` (escaped SSML → Azure AI Speech mp3), usage counters, per-owner rate limit, owner-safe provider errors; `docs/runbooks/voice.md` | exact request shapes against a fake provider, every error mapping, limits, SSML escaping, no text/keys in audit, decoy |
| C — Cofounder home | `home.tsx`: Home is the landing view (`view=board` for the zone board): brief, KPI cards (eased numbers, drawn sparklines, worded deltas), Waiting on you, Noticed, Agent activity, Execution stage bars, Results · this week, docked Cofounder panel; Motion, reduced motion respected | every section, Business variant, All view, drawers, states, a11y |
| D — Cofounder panel + voice | `cofounder.tsx`, `voice.tsx`: push-to-talk (command bar, panel, Talk drawer; mic only on a press, every track stopped; transcript fills the input, never sent by itself), voice HUD with captions and End, spoken replies (Azure voice, browser voice fallback, replay), "Talk with your cofounder" conversation mode, Settings → Voice & consent | mic lifecycle, permission denied, not set up, mic off, fallback voice, conversation mode, a11y |

Coordinator: contracts first (`home.ts`, `voice.ts`, `NEXUS_VOICE_FILE`), `view=home|board` with the default view in the router context (tests default to the board), the three provider-key file readers folded into `secret-file.ts`, the unused APPROVAL home ref dropped, one microphone at a time across the page. Migration `0009_jazzy_vertigo.sql` (voice tables) keeps the builder's generated name: the running dev API had already applied it.
Checks on the merged tree: typecheck, lint, prettier, tests (api 389, web 246, runner 165+1 skipped, contracts 23), web build, secret scan.

Owner setup for voice: deploy a transcribe model (e.g. `gpt-4o-mini-transcribe`) on the Foundry resource, write `~/.nexus/voice.json` (mode 600, `docs/runbooks/voice.md`), then turn the mic on in Settings → Voice & consent.

Known follow-ups: phone calls (PSTN) and realtime voice with barge-in are later phases; WAITING_ON_YOU has no history yet (drafts and opportunities keep no status history); issue/PR result dates use row `updated_at` / `decidedAt`; Business KPIs reuse the Business zone tiles.

## Next

- Owner check: one live Talk turn on Anthropic and on Foundry.
- Owner check: one real n8n workflow against `/v1/automations/trigger` (runbook untested against live n8n).
- Owner check: one live plan (Anthropic/Foundry) from goal to an issue run, and one Explain/Triage call.
- Wave 4 candidates: code-split the web bundle (946 kB, lazy drawers), voice push-to-talk + TTS (FR-CWV-02/03, P1C), FR-BIZ-06 funnel, plan editing before approval, parallel plan steps (FR-AGT-08, P2).

## Deferred (named, not built)

pg-boss (window unique key covers schedules), embedding-based semantic dedupe, LLM "why it matters" in briefs, Supabase MCP (read-only role instead), FR-DATA-04 migration workflow, FR-BIZ-04..06 (refunds, products, funnel), voice (FR-CWV-02/03), node reflow animation inside zones.
