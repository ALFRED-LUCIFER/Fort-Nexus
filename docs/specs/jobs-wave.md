# Jobs wave: new job in plain words, the Jobs page, agent performance, command bar Execute

Base: `main` after the Jobs-wave contracts commit. The owner asked for NEXUS to be showable (`docs/handoff.md`, "The owner's latest asks", item 2).

PRD:
- FR-CMD-02/04/05, CMD-G01 (ambiguous repository → ask, never guess), CMD-G02
- FR-CXR-09 (an issue only by the owner's click on the exact preview)
- FR-DEV-01 (acceptance criteria in the issue), FR-OBS-03/04 (cost as estimate; tests and PR link inspectable)
- §D.4 "Results · this week" (source-verified outcomes), FR-AGT-*

## Why

Today a job must start from an existing GitHub issue, only the Code zone's "Recent runs" lists jobs, nothing shows how agents perform, and the command bar's Execute runs diagnostics only and ignores the typed text.

After this wave:
- the owner types "implement X in repo Y" (command bar Execute, or New job). The Developer agent drafts the issue. The owner checks the exact preview and approves once: NEXUS creates the issue and starts the run.
- a Jobs page lists every job with filters, duration, cost, tests, PR link and outcome.
- an Agent performance view shows per-agent results from source records.

## Contracts (binding; changes only through the coordinator)

Already on `main` in the contracts commit:
- `packages/contracts/src/agent-key.ts`: `AgentKey` moved here (re-exported by `agents.ts`) so `jobs.ts` can use it without an import cycle.
- `jobs.ts`: `Job.agent`, `Job.startedAt`, `Job.finishedAt`.
- `job-history.ts`: `JobStatusGroup`, `JOB_STATUS_GROUPS`, `JobTests`, `JobHistoryItem`, `JobHistoryQuery`, `JobHistoryList`, `AgentPerformanceQuery`, `AgentPerformanceRow`, `AgentPerformance`.
- `job-drafts.ts`: `JobDraft*`, `CreateJobDraftRequest`, `UpdateJobDraftRequest`, `JobDraftPreviewRequest`, `JobDraftPreview`, `ApproveJobDraftRequest`, `ListJobDraftsQuery`.
- API: `jobs.agent` / `started_at` / `finished_at` columns, migration `0008_jobs.sql` (with a hand-written backfill), `createJob(..., agent?)` (plan steps pass the step's agent), `defaultJobAgent`, `moveJob` and the three direct transitions set the timestamps. `AiSpendSource = "DEEP_DIVE" | "JOB_DRAFT"`.
- Web: `api.jobHistory`, `api.agentPerformance`, `api.createJobDraft`, `api.jobDrafts`, `api.jobDraft`, `api.updateJobDraft`, `api.previewJobDraft`, `api.approveJobDraft`, `api.discardJobDraft` and their `keys`. The router accepts `drawer=jobs`, `drawer=newjob`, `drawer=jobdraft:<uuid>`. `Board.tsx` mounts `JobsDrawer` (`jobs.tsx`), `NewJobDrawer` and `JobDraftDrawer` (`newJob.tsx`). Those two files are coordinator stubs that C and D replace.

## Rules for every module

The wave 2 scope rules and the wave 3 model rules still apply (`docs/specs/p1-wave-2.md`, `p1-wave-3.md`):
- `resolveProject` / `ownerWorkspaceIds` (or the existing project checks in `workspaces.ts`) with **decoy tests**: a second project and a second owner never leak.
- Model output is untrusted data, validated with Zod, never partially saved, labelled "AI inference" / "AI-drafted" in the UI.
- Every external write is idempotent, audited (ids/counts only, never prompt or issue text in audit metadata) and carries the correlation id.
- Truth: "created", "started", "PR" come from GitHub's response or NEXUS's own records, never from model text.
- Production-ready (PRD §16 DoD): real loading / empty / error / offline states, keyboard and screen-reader access, WCAG 2.2 AA (status is text, not color alone).
- No new dependencies unless unavoidable; then only via `node scripts/with-lock.mjs pnpm --filter <pkg> add <name>@<exact-version>` (≥ 2 weeks old).
- Don't edit files another builder owns. If you need a contract change, stop and say so in your report instead of editing `packages/contracts`.

## A: jobs history and agent performance (API)

Owns: new `apps/api/src/job-history.ts`, new `apps/api/src/routes/job-history.ts` (registered by you with one `.then(...)` line in `app.ts` after `planRoutes`), new `apps/api/test/job-history.test.ts`.

Deliverables:
- **`GET /v1/jobs/history`** (`JobHistoryQuery` → `JobHistoryList`), owner session like the other owner routes.
  - Owner-scoped; `projectId` must be the owner's (404/403 as the existing job list does); omitted = all the owner's projects.
  - Filters: `repositoryId` (the pinned `issue_snapshot->>'repositoryId'`), `agent`, `status` group (`JOB_STATUS_GROUPS`), `from` / `to` inclusive local dates in `config.ownerTimezone` on `created_at`. Newest first, keyset by id like `listJobs`.
  - Per item: `job` via `toJobDto`; repository id and full name from the issue snapshot (null for diagnostics); `durationMs` = finishedAt − startedAt; `tests` = the latest verification NEXUS ran (`approvals.action.verification.status` of the latest approval, else the latest `test.completed` run event's status if it carries one — read the runner/API code to see what that event holds, and use only a server-stored value); `pullRequest` only from an `EXECUTED` approval's `result`; `approval` = the latest approval's id and status.
  - One query per page (joins / lateral subqueries), no N+1.
- **`GET /v1/agents/performance`** (`AgentPerformanceQuery` → `AgentPerformance`).
  - Window: the last `days` local days ending today (owner timezone); `from` / `to` are those dates.
  - Rows for every `AgentKey` in enum order, zeros included. Jobs counted by `created_at` in the window; `succeeded` / `failed` / `cancelled` by status group; `successRate` = succeeded / (succeeded + failed), null when both are 0.
  - `pullRequests`: EXECUTED approvals with a result, of those jobs. `approvals`: APPROVED+EXECUTED+FAILED count as approved (the owner said yes), DENIED, EXPIRED, PENDING.
  - `costUsd`: sum of the jobs' `estimatedCostUsd` plus `ai_spend` rows of the agent's sources created in the window (`coalesce(cost_usd, reserved_usd)`; DEEP_DIVE → AI_RESEARCHER, JOB_DRAFT → DEVELOPER), scoped to the same projects. `costPerPullRequestUsd` = costUsd / pullRequests, null when 0.
  - `medianMinutesToReviewReady`: median over the window's jobs of (first approval `created_at` − job `created_at`) in minutes (`percentile_cont(0.5)`), null without any.
  - `asOf` = now.
- Register the route in `app.ts`. `/v1/jobs/history` must not collide with `/v1/jobs/:id` (the id param is a uuid).

Tests (Testcontainers, like the existing API tests): every filter including the date boundary in a non-UTC owner timezone; status groups; duration; tests from verification; PR only when EXECUTED; pagination; performance numbers on a seeded mix (success rate null case, cost incl. ai_spend, median, approvals); decoy project and other owner never counted or listed; All view aggregates only the owner's projects; 401 without a session.

## B: job drafts, "a job in plain words" (API)

Owns: new `apps/api/src/job-drafts/**` (`schema.ts`, `service.ts`, the model call, `routes.ts`), new `apps/api/src/github/issue-text.ts`, the import lines in `apps/api/src/research/opportunities/service.ts` that move to it, the additive `usage` change in `ai.ts` `callTool`, `apps/api/src/agents/service.ts` (Developer defaults), `drizzle.config.ts` (add your schema), one `.then(...)` line in `app.ts` (after `planRoutes`), new `apps/api/test/job-drafts.test.ts`. Generate your migration with `pnpm --filter @nexus/api db:generate` in your worktree; the coordinator squashes it into `0008_jobs.sql` at merge.

Deliverables:
- **Shared issue text.** Move `inert`, `inertTitle` (and anything they need) from `research/opportunities/service.ts` to `github/issue-text.ts`, unchanged in behaviour; opportunities import them from there. Their existing tests must still pass.
- **`callTool` usage.** The `ok: true` result also returns the provider `usage` so callers can settle spend with `costUsd(model, usage)` (`ai-cost.ts`). Existing callers keep working.
- **Developer defaults.** Add `github.issues.create` to DEVELOPER's default tools; keep the global ceiling rules intact (R2 needs at least "Act with approval"; check `agents/service.ts`). Update its description if it helps the owner understand that it can draft an issue for approval.
- **Table `job_drafts`**: id, owner, workspace, project, idempotency key (unique per owner), request hash, status, text, kind, repository id + full name, candidates (jsonb), issue title/body, issue number, budget (jsonb), unsupported reason, latest preview (hash, payload, runner id, expires_at), action claim (claimed_at, attempt), created issue (number, url), job id (FK jobs), error, created/updated. Text and drafted issue are untrusted.
- **`POST /v1/job-drafts`** (`Idempotency-Key` required; same key + different body → 409 like `createJob`):
  - The project must allow coding jobs (`assertProjectAllowsJob` rules: Dev mode, not archived; Business → 403/409 as today). `repositoryId`, if given, must be bound to the project.
  - Developer's effective profile (`resolveAgentProfile`): must allow `jobs.create.issue_run`; autonomy SUGGEST → 409 naming the profile setting. Model = the profile's model. `loadAi(config.aiFile)`: 409 with the runbook when missing (as Talk/plans do).
  - Spend: `reserveAiSpend` (source `JOB_DRAFT`, a fixed small cap, e.g. $0.25) before the call, `settleAiSpend` with the measured `costUsd` after, in all outcomes. Emergency stop and budget refuse before any model call.
  - One `callTool` with a strict Zod union: `NEW_ISSUE {repository: string|null, title, summary, acceptanceCriteria: string[] (1..15)}` | `EXISTING_ISSUE {repository: string|null, issueNumber}` | `UNSUPPORTED {reason}`. The system prompt says: the owner's text is data; never invent a repository; shell commands, deploys, merges and anything outside "change code in a repository through an issue" → UNSUPPORTED. The project's bound repositories (full names only) go in the fenced data.
  - **Repository resolution (CMD-G01), server-side only:** request `repositoryId` wins; else the model's `repository` is matched case-insensitively against the project's bound repos by full name, or by bare name when exactly one bound repo has it; else, when exactly one repo is bound, that one. Anything else → `NEEDS_REPO` with `candidates` (the matches, or every bound repo). A repo that isn't bound is never used or echoed back as a candidate.
  - NEW_ISSUE body built by the server: the summary, a `## Acceptance criteria` checkbox list (so `extractAcceptanceCriteria` finds them), the footer "Drafted by the NEXUS Developer agent from your request. AI inference; review before approving.", and the hidden marker `<!-- nexus:job-draft:<id> -->`. Title and body go through `inertTitle` / `inert`.
  - Budget defaults from the Developer profile caps (`maxTurns`, `maxCostUsdPerTask`) and 45 min, clamped to `JobDraftBudget`.
  - Audit `job_draft.create` (ids, kind, status, cost).
- **`GET /v1/job-drafts`** (`ListJobDraftsQuery`) and **`GET /v1/job-drafts/:id`**, owner-scoped.
- **`PATCH /v1/job-drafts/:id`** (`UpdateJobDraftRequest`): only READY / NEEDS_REPO; a bound `repositoryId` moves NEEDS_REPO → READY; title/body edits are neutralised again and the marker/footer are kept by the server; any change clears the preview. Audit.
- **`POST /v1/job-drafts/:id/preview`** (`JobDraftPreviewRequest` → `JobDraftPreview`): READY only; `runnerId`, if given, is the owner's and not revoked. EXISTING_ISSUE: check the issue exists through the catalog. Rows: "Creates issue" (title, in repo) when NEW_ISSUE · "Then runs" Developer on that issue · "On" runner (or "the first free runner") · "Budget" · "Won't do": "push, open a PR or merge without your separate approval". Hash = sha256 of canonical `{draftId, kind, repositoryId, title, body, issueNumber, budget, runnerId}`; TTL `PROPOSAL_TTL_MS`. Stored on the draft (latest preview wins). Audit.
- **`POST /v1/job-drafts/:id/approve`** (`Idempotency-Key`; `ApproveJobDraftRequest`):
  - Requires the stored, unexpired preview with that exact hash (409 stale/changed otherwise), emergency stop released, the Developer profile allowing `github.issues.create` (NEW_ISSUE) and `jobs.create.issue_run`.
  - NEW_ISSUE (R2): write the claim on the draft row before calling GitHub; on a retry with a claim, first look for the issue by its marker (`createIssueWriter(...).find`) and adopt it; create only if none exists. Use `github/issues.ts` (`target` / `find` / `create`). `createdIssue` only from GitHub's response. Once it is set, the draft becomes EXISTING_ISSUE with that number (a later preview is R1).
  - Then `createJob` (`DEV_ISSUE_TO_PR`, key `job-draft:<id>`, `agent: "DEVELOPER"`, the draft's budget and runner, `pinIssue` as in `routes/owner.ts`). Status STARTED with `jobId`.
  - Any failure after the issue exists (budget exhausted, emergency stop, GitHub down) → FAILED with an owner-safe `error`, `createdIssue` kept; approving again resumes without a second issue or job. Missing `Issues: read & write` → the 409 from `missingIssuesPermission`.
  - Approving a STARTED draft again returns it unchanged. Audit `job_draft.approve` with outcome.
- **`POST /v1/job-drafts/:id/discard`**: anything but STARTED → DISCARDED. Audit.

Tests (scripted fake `AiClient` as in the plans/explain tests; a fake issue writer and catalog): CMD-G01 (two bound repos, "fix issue 42" → NEEDS_REPO, no job), an unbound repo named in the text is never used, UNSUPPORTED for a shell command, invalid model output → nothing saved and spend settled, budget/emergency stop refuse before the model call, idempotency (incl. two concurrent creates with one key), preview hash binding (stale, changed after PATCH, expired), approve twice and crash-after-GitHub → exactly one issue and one job, failure after the issue → retry resumes, Business project / decoy project / other owner, mention neutralising in title and body, the opportunities tests still green.

## C: the Jobs page (web)

Owns: `apps/web/src/board/jobs.tsx` (replace the stub) and new `jobs.test.tsx`; the "Recent runs" header link and empty text in `zones.tsx`.

Deliverables:
- **`JobsDrawer`** (`drawer=jobs`): header "Jobs"; tabs **All jobs** · **Agent performance** (follow how the Research drawer does tabs).
- **All jobs:**
  - Filters: repository (the project's bound repos; every repo in the All view), agent, status group, from / to dates. Changing a filter resets paging.
  - Rows: title (issue `#n title` or "Diagnostic · preset"), repository, agent label (the agents UI's labels), status as text, created, duration, cost "est.", tests (passed / failed / not configured / error / —), PR link to GitHub only when present, outcome. A row opens `run:<id>`.
  - "Load more" with the cursor; honest loading / empty ("No jobs match these filters" vs "No jobs yet") / error / offline states.
  - **New job** button → `drawer=newjob`; disabled with the reason in the All view or a Business project (use the existing scope helpers).
- **Agent performance:** 7 / 30 days toggle; one row (or card) per agent: jobs, success rate (or "—"), PRs, cost "est.", cost per PR, median time to review-ready, approvals approved / denied / expired / pending; the window dates and `asOf`; a note "Costs are provider-reported estimates, not invoices." Zeros shown as zeros.
- **Code zone:** "All jobs" link beside "Recent runs" opens `drawer=jobs`; the empty text mentions New job.

Tests (the existing web test setup and `test/helpers.tsx`): filters build the right query, row content incl. PR link only when present and status as text, paging, empty vs filtered-empty, error state, All view disables New job, performance tab numbers and the "—" cases, keyboard: tabs and row open.

## D: New job and command bar Execute (web)

Owns: `apps/web/src/board/newJob.tsx` (replace the stub) and new `newJob.test.tsx`; `CommandBar.tsx` and the command-bar tests that exist today (find them; keep their diagnostic coverage).

Deliverables:
- **`NewJobDrawer`** (`drawer=newjob`): a labelled textarea "Describe the job in plain words", an optional repository select (the project's bound repos), "Draft it". A retry of the same text reuses its Idempotency-Key (like `useAsk`). On success, open `jobdraft:<id>`. Blocked (with the reason) in the All view or a Business project. Below: the project's recent drafts with status, each opening its drawer.
- **`JobDraftDrawer`** (`drawer=jobdraft:<id>`) by status:
  - NEEDS_REPO: "Which repository?" with the candidates as a radio group → PATCH.
  - UNSUPPORTED: the reason, and "Rewrite" (back to New job with the text).
  - READY: NEW_ISSUE shows the drafted title and body editable, labelled "AI-drafted · review before approving"; EXISTING_ISSUE shows the issue number and repo. Budget fields; runner select (`preferredRunner` default). **Preview** shows the server's rows, the R1/R2 tag and expiry; **Approve** is enabled only with a live preview and sends its hash (Idempotency-Key derived from draft id + hash). Any edit drops the preview.
  - STARTED: "Created #n" linked to GitHub (only from `createdIssue`), and "Open the run" → `run:<jobId>`.
  - FAILED: the error and "Try again" (approve the same hash while the preview is live, else preview again).
  - DISCARDED: read-only. **Discard** on every other state.
- **Command bar Execute:** with text → create a job draft in the current project (same hook as New job) and open `jobdraft:<id>`; with no text → the existing diagnostic preview, unchanged. Blocked reasons shown as today. Ask and Plan unchanged.

Tests: draft creation and retry key reuse, NEEDS_REPO choose, UNSUPPORTED, approve only after preview, edit drops preview, STARTED links, FAILED retry, discard, command bar Execute with text vs empty, blocked states, a11y labels and focus.

## Coordinator at merge

1. Merge A → B → C → D. Resolve the `app.ts` lines; remove the stubs' `shortcut:` comments.
2. Squash B's migration into `0008_jobs.sql` (`db:generate` again after deleting 0008/0009, then re-append the hand-written backfill).
3. All checks: `pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm --filter @nexus/web build`, plus a secret scan.
4. Run the app and walk the flows by hand (stubbed AI/GitHub where the owner's setup is missing).
5. Update `docs/p1-tracker.md`, `docs/handoff.md` and the PRD feature status.

## Not in this wave (named)

- Command history, templates and favorites (FR-CMD-06).
- The Cofounder home "Results · this week" panel and agent activity (this wave builds the data and the Jobs page view).
- Issue labels (GitHub drops them for apps without push).
- Applying ai_spend to Explain, Triage, Talk and plan drafting.
