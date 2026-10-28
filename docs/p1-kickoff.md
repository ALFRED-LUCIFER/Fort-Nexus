# P1 kickoff — parallel session

The MVP (P0) is being finished in the main working tree on `main` (see `docs/mvp-tracker.md`). P1 starts **in parallel** in its own git worktree and branch, so the two sessions never edit the same files.

## 1. Create the P1 worktree (once)

```bash
cd /Volumes/Dev-Zone/Fort-Nexus
git worktree add ../Fort-Nexus-p1 -b p1
cd ../Fort-Nexus-p1
pnpm install --frozen-lockfile
```

Open the new Claude Code session **in `/Volumes/Dev-Zone/Fort-Nexus-p1`** and paste the prompt below.

## 2. Prompt for the new session

```text
You are continuing the NEXUS project in the P1 worktree (/Volumes/Dev-Zone/Fort-Nexus-p1, branch p1).
Another session is finishing the MVP on main in /Volumes/Dev-Zone/Fort-Nexus — never edit that folder.

Read first: CLAUDE.md, docs/mvp-tracker.md, docs/p1-kickoff.md (this file), docs/PRD.md (Part A–D, §6 scope, §9 epics,
§19 roadmap), docs/specs/*, docs/adr/*. Use the ponytail skill for every task; production-ready code; PRD §16 DoD.
Commit as ALFRED-LUCIFER <alfred.v.paul@gmail.com> (set it with git config in this worktree). Push branch p1 only;
never push to main. Use multiple parallel agents per wave, contracts + spec first, like the MVP session does.

P1 wave 1 (independent of the MVP's remaining work — new modules only):
  A. V1B Research pipeline (EPIC RES, FR-RES-01..12): watchlists, source connectors (RSS, GitHub releases, official
     release notes), canonical-URL + semantic dedupe, primary-source verification labels, user-tunable scoring
     weights, daily brief per timezone exactly once per window (RES-G01..G04), searchable history. New module
     apps/api/src/research/** + contracts file packages/contracts/src/research.ts + web Research zone/drawer.
  B. V1A Business read-only connectors (EPIC CON + DATA + BIZ, FR-CON-01..06, FR-DATA-01..09, FR-BIZ-01..07):
     connector registry with credential refs, Supabase/PostgreSQL read-only role with statement timeouts and schema
     allowlist, metric dictionary, typed metric tools (get_sales_summary etc.) with provenance + freshness + partial-day
     labels, never inventing numbers (DATA-G01..G04, BIZ-G01). New module apps/api/src/business/** + contracts file
     packages/contracts/src/business.ts + web Business zone/drawer.
  C. Conversational text foundation (EPIC CWV/CXR text-only, FR-CWV-01/04/05/07, FR-CXR-01..07): threads + turns,
     typed intent router (Claude via the Anthropic SDK / Foundry per ADR-0003) producing ActionProposals, never shell
     text, source-linked answers. New module apps/api/src/conversations/** + contracts file
     packages/contracts/src/conversations.ts + web Talk drawer.

  D. UI motion polish (PRD Part A "Motion"): add `motion` (formerly Framer Motion, pinned exact version) to apps/web;
     MotionConfig reducedMotion="user" at the root; layout animations for the board (Domains <-> Agents regrouping,
     node reflow), drawer enter/exit + staggered content, inspector/toast/brief springs as in
     docs/design/NEXUS-v2.dc.html. Replace the hand-written WAAPI/CSS where Motion is clearly better, keep CSS for
     simple keyframes, keep bundle growth small (lazy-load where possible), test reduced-motion behaviour. Coordinate:
     only touch animation wrappers, not board data logic.

Rules to avoid conflicts with the MVP session:
- Only add NEW files/modules; touch shared files (app.ts route registration, contracts index.ts, Board.tsx zone
  wiring, router search params) with minimal one-line additions and expect to rebase.
- Scope everything by workspaceId + projectId from day one, but the workspace model itself lands on main in MVP
  wave 6 — until then use a placeholder project id behind a single helper, marked `shortcut:`.
- Rebase p1 onto main after each MVP wave (git fetch origin && git rebase origin/main), re-run all checks.
- Merge to main only after the MVP gates in docs/mvp-tracker.md are green, via a PR from p1.
Keep docs/p1-tracker.md (create it) as this session's resume file, like docs/mvp-tracker.md.
```

## 3. What stays on the MVP session (don't start these in P1)

Wave 5 (verify, safety, deploy) and wave 6 (workspaces, notifications), the MVP gate review and the real run.
