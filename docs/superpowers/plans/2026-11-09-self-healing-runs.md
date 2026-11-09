# Self-Healing Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a coding job carry the full development cycle, repair its own failures for up to 3 rounds, reach push approval only on a NEXUS-verified pass, and report plainly when it is stuck.

**Architecture:** The runner gains a dependency-injected loop (`repair-loop.ts`) around today's agent → changeset → verify steps, inside one lease. The API stores the last tested changeset for every outcome and creates an approval only on a clean pass. Feedback and Keep fixing are new owner routes; the run drawer shows rounds, phases, QA, the stuck report and a feedback box.

**Tech Stack:** TypeScript strict, Node 24, Fastify 5, Zod 4, Drizzle/PostgreSQL 18, React 19, TanStack Query, Vitest, Testcontainers, Docker sandbox.

**Spec:** `docs/specs/self-healing-runs.md`

## Global Constraints

- PRD Part B and Global DoD: typed jobs only, server-side authorization, idempotency on every external write, audit + correlation ID, redaction, real loading/error/offline/stale UI states, WCAG 2.2 AA.
- Repair rounds: 3 after the first attempt. Counter "Round N of 4" for a new job, "Round N of 3" for Keep fixing.
- Feedback and notes: at most 2,000 characters. Stuck report and QA are labelled as model output, never as verified fact.
- All rounds and QA share the job's one budget. Test runs count toward wall clock.
- Work in the worktree `.claude/worktrees/self-healing` on branch `feat/self-healing-runs`. The running runner service loads from the main checkout, so never switch branches there. Merge and push only when the owner says so.
- Tests: API needs `DOCKER_HOST=unix:///Users/alfredpaul/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`. Real-Docker runner tests need `TMPDIR` under `/Volumes/Development`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Git email is `alfred.v.paul@gmail.com`.
- No test fixture may look like a real key (the gitleaks CI step fails on it).

## Review Focus

1. A repair round makes the tests worse after an earlier pass: the last passing changeset is uploaded with its original result, never the worse tree.
2. Runner dies or is cancelled mid-loop: the job ends as cancel/recovery does today, nothing partial is stored, and heartbeats never stopped during long rounds.
3. Hostile test output or QA text tries to pose as rules or forge `NEXUS_RESULT`: it stays inside the untrusted fence, and a forged result inside output has no effect.
4. A double tap on Keep fixing or on feedback: one job, one message.
5. Install writes files git would pick up (a repository that doesn't ignore `node_modules`): the worktree is cleaned and the agent proceeds without packages, so nothing leaks into the changeset.

---

### Task 1: Sandbox runs nested pnpm and yarn

**Files:** Modify `infra/sandbox/Dockerfile`, `apps/runner/src/sandbox.ts` (`SANDBOX_IMAGE`), `apps/runner/src/sandbox.test.ts`, `apps/runner/src/verify.test.ts`

- [ ] Write real-Docker test `verify: a test script that calls pnpm directly runs` in `verify.test.ts`: a fixture whose `package.json` test script is `pnpm --version` ends `status: "passed"`.
- [ ] Run it. Expected: FAIL with `pnpm: not found`.
- [ ] As root, before `USER`, add `RUN corepack enable --install-directory /usr/local/bin`. Change `SANDBOX_IMAGE` to `"nexus-sandbox:4"` and bump the build tag.
- [ ] Build: `pnpm --filter @nexus/runner sandbox:build`. Run the test. Expected: PASS.
- [ ] Commit.

### Task 2: Contracts and migration

**Files:** Modify `packages/contracts/src/{jobs,events,issue-to-pr,runners}.ts`, `index.ts`, `apps/api/src/db/schema.ts`. Create `packages/contracts/src/job-loop.ts`, migration via `pnpm --filter @nexus/api db:generate`. Test: `packages/contracts/src/contracts.test.ts`.

**Produces (exact names):**

- `JobOutcome` adds `ENVIRONMENT_BLOCKED`, `ALREADY_FAILING`, `NEEDS_INFO`. `JOB_TRANSITIONS.VERIFYING` adds `RUNNING`.
- `RunEventType` adds `phase.completed`, `loop.round.started`, `loop.round.completed`, `loop.stopped`, `qa.completed`, `feedback.delivered`.
- `Verification` adds optional `failureKind: "test_failed" | "test_timeout" | "environment" | "install_failed" | "needs_dependency" | "not_configured"`. Optional so stored approvals still parse.
- `job-loop.ts`: `REPAIR_ROUNDS = 3`; `FEEDBACK_MAX = 2000`; `QaDefect {severity: "blocking"|"minor", file: string|null, evidence: string}`; `QaReview {status: "reviewed"|"could_not_run", verdict: "pass"|"defects"|null, defects: QaDefect[] (max 20), reason: string|null}`; `StuckReport {rounds: {round:int, tried:string, result:string}[], stillFailing:string, rootCauseGuess:string|null, nextStep:string}`; `JobFeedbackRequest {text}`; `JobFeedback {id, jobId, text, createdAt, deliveredRound:int|null}`; `JobFeedbackList {items}`; `KeepFixingRequest {note?: string}`; `ClaimFeedbackRequest {fencingToken, round}`; `ClaimFeedbackResponse {items: {id, text}[]}`.
- `UploadChangesetRequest` adds optional `qa: QaReview`, `integrity: {clean: boolean, problems: string[]}`, `report: StuckReport`, `terminalOutcome: "FAILED_TESTS"|"ENVIRONMENT_BLOCKED"|"ALREADY_FAILING"`.
- `PushDraftPrAction` adds optional `qa: QaReview`, `testFilesChanged: string[]`.
- `IssueToPrTask` adds optional `continuation: {files: ChangesetFile[], note: string|null}` and `model: string`.
- Schema: `changesets.verification jsonb`; `jobs.continues_changeset boolean not null default false`; `jobs.owner_note text`; new table `job_feedback (id, job_id, owner_id, text, idempotency_key, delivered_round, created_at)` with a unique index on `(owner_id, idempotency_key)`.

- [ ] Test: `QaReview` caps defects at 20; `JobFeedbackRequest` rejects 2,001 characters; `canTransition("VERIFYING","RUNNING")` is true; a stored `Verification` without `failureKind` still parses.
- [ ] Run. Expected: FAIL. Implement. Generate the migration. Run. Expected: PASS. Commit.

### Task 3: The push gate

**Files:** Modify `apps/api/src/issue-to-pr.ts`, `apps/api/src/routes/runner.ts`. Test: `apps/api/test/issue-to-pr.test.ts`.

- [ ] Tests: upload with `failed` creates no approval, stores the changeset and verification, ends `FAILED`/`FAILED_TESTS`, and `job.failed` carries `report`; upload with `passed` and `integrity.clean: false` creates no approval; `terminalOutcome` is honoured; `passed` + clean creates an approval whose action carries `qa` and `testFilesChanged`; `decideApproval` approve on stored verification `failed` is 409 with a message naming the reason, while deny still works; the same upload retried returns the same result for both paths.
- [ ] Run. Expected: FAIL. Implement in `uploadChangeset` and `decideApproval`. Retried upload with no approval returns `{approvalId: null, actionHash: null}`, so make `UploadChangesetResponse` fields nullable. Run. Expected: PASS. Commit.

### Task 4: Failure classification and test integrity

**Files:** Create `apps/runner/src/repair/classify.ts`, `repair/integrity.ts`, tests beside them.

**Produces:** `classifyFailure(v: Verification, changedPaths: string[]): "repair"|"environment"|"needs_dependency"|"not_configured"`; `fingerprint(outputTail: string): string` (strips ANSI, durations, absolute paths, numbers, then sha256); `checkIntegrity(files: ChangesetFile[], base: (path) => Promise<string|null>): Promise<{clean, problems, testFilesChanged}>`.

- [ ] Tests: `sh: pnpm: not found` → environment; `getaddrinfo ENOTFOUND` → environment; a timed-out test → repair; install failed with `package.json` changed → needs_dependency; same failure with different timings → same fingerprint; deleted `a.test.ts` is a problem; changed `scripts.test` is a problem while a changed `dependencies` block isn't; added `it.only`, `.skip`, `xit`, `fdescribe`, `@Ignore`, `pytest.mark.skip` are problems; a marker that already existed at base isn't; `.nexus.json` and `vitest.config.ts` changes are problems.
- [ ] Run. Expected: FAIL. Implement as pure functions. Run. Expected: PASS. Commit.

### Task 5: Verification extras

**Files:** Modify `apps/runner/src/verify.ts`, `verify.test.ts`. Create `apps/runner/src/prepare-deps.ts`, `prepare-deps.test.ts`.

**Produces:** `runVerification` sets `failureKind` and takes optional `only: "base" | "red"` labels for events; `treeWithTestsOnly(gitDir, baseSha, testPaths): Promise<string>` (base tree plus only the listed files); `prepareDeps({jobId, gitDir, baseSha, worktreePath, cacheDir, image, runnerLabel, signal}): Promise<{ok: boolean, reason: string|null}>`, which installs using the base commit's `VerifyPlan` in a separate container with the plan's egress.

- [ ] Real-Docker tests: timed-out test reports `failureKind: "test_timeout"`; `treeWithTestsOnly` has the new test and not the source change; `prepareDeps` populates `node_modules` so a later container with no network runs tests; a repository not ignoring `node_modules` is cleaned, returns `ok: false`, and `buildChangeset` afterwards is empty.
- [ ] Run. Expected: FAIL. Implement. Run. Expected: PASS. Commit.

### Task 6: Lifecycle prompts, result parsing and QA

**Files:** Modify `apps/runner/src/issue-prompt.ts`, `apps/runner/src/claude.ts` (optional `model`, optional `depsCache` mounted at `/workspace/cache`, `COREPACK_HOME` set). Create `apps/runner/src/agent-result.ts`, `apps/runner/src/qa.ts`, tests. Add `apps/runner/src/repair-prompt.ts`.

**Produces:** `issuePrompt(issue, {canRunTests, note})`; `repairPrompt({issue, round, evidence, note, canRunTests})`; `parsePhaseLine(text): {phase, text}|null` for lines `NEXUS_PHASE {json}`; `parseResult(finalText): {status:"done"}|{status:"needs_info", questions:string[]}|{status:"qa", verdict, defects}|null` for the last line `NEXUS_RESULT {json}`; `runQaReview(opts): Promise<QaReview>`.

The phases and rules are the spec's §6, in order. Phase text is display only and never authority.

- [ ] Tests: prompt contains the six phases in order and the ladder from "does it need to exist"; the fixed rules come before any fenced data; repair evidence uses a fresh random fence; a forged `NEXUS_RESULT` inside the fence isn't the last line and is ignored; a note appears labelled as owner guidance after the fixed rules; `runQaReview` returns `could_not_run` for a missing result, and when the tree changed.
- [ ] Run. Expected: FAIL. Implement. Run. Expected: PASS. Commit.

### Task 7: The repair loop

**Files:** Create `apps/runner/src/repair-loop.ts`, `repair-loop.test.ts`.

**Consumes:** Tasks 4–6.

**Produces:** `runRepairLoop(deps: LoopDeps, input: LoopInput): Promise<LoopResult>`.

- `LoopDeps`: `runAgent(prompt, budgetLeft)`, `buildChangeset()`, `verify(tree, label?)`, `checkIntegrity(files)`, `runQa(tree, budgetLeft)`, `claimFeedback(round)`, `event(type, payload)`, `signal`, `now()`.
- `LoopInput`: `issue`, `budget`, `rounds`, `continuation`, `canRunTests`.
- `LoopResult`: `{kind:"upload", changeset, verification, qa, integrity, report, terminalOutcome?}` | `{kind:"failed", reason, details, outcome?, report}` | `{kind:"needs_info", questions}` | `{kind:"stopped"}` | `{kind:"no_changes"}`.
- Constants: `MIN_ROUND_COST_USD = 0.25`, `MIN_ROUND_MS = 120_000`, `MIN_ROUND_TURNS = 5`.

- [ ] Tests with fakes, one per path: pass first time, QA clean → upload, one agent run; fail then pass → 2 runs; 3 repairs all fail → upload with `FAILED_TESTS` and a report; environment failure → no repair; first failure with base failing → `ALREADY_FAILING`, and base run happens once; base-failure check skipped when a note says to fix them; identical fingerprint twice → stop; no change in a repair round → stop; budget below minimums → stop with a report; integrity problem → repair, and upload not clean if it remains; red check finds tests pass on base → repair; code change with no test → repair; docs-only exempt; QA blocking defect → repair from the same limit; QA repair breaks tests → last passing changeset uploaded with its verification and open defects; QA `could_not_run` → upload; feedback waiting after a pass → another round; feedback with no rounds left → reported unused; `needs_info` → no changeset; Keep fixing starts with verify and no agent run, and a pass goes straight to QA; abort at each await → `stopped`; agent run dies with budget exceeded after an earlier tested tree → that tree is uploaded.
- [ ] Run. Expected: FAIL. Implement as a loop with these deps only. Run. Expected: PASS. Commit.

### Task 8: Wire the loop into the runner

**Files:** Modify `apps/runner/src/run.ts`, `apps/runner/src/api.ts`, `apps/runner/src/test-support.ts`, `apps/runner/src/issue-job.test.ts`.

**Consumes:** `runRepairLoop`, `ClaimFeedbackResponse`. **Produces:** `api.claimFeedback(jobId, {fencingToken, round})`.

- [ ] Real-Docker tests in `issue-job.test.ts` with the fake in-container agent: failing tests repaired on round 2 reach approval with both rounds evented; persistent failure uploads with `FAILED_TESTS`; `continuation` applies stored files and verifies before any agent start; cancel during round 2 removes the container and ends cancelled.
- [ ] Run. Expected: FAIL. Replace the single agent/verify section of `runIssueToPr`. Transitions go VERIFYING → RUNNING per round. Secret-leak failures upload nothing. Run the full runner suite. Expected: PASS. Commit.

### Task 9: Keep fixing, feedback and the Developer profile

**Files:** Modify `apps/api/src/jobs.ts`, `routes/owner.ts`, `routes/runner.ts`, `issue-to-pr.ts` (lease). Create `apps/api/src/job-feedback.ts`, `apps/api/test/keep-fixing.test.ts`, `apps/api/test/feedback.test.ts`.

**Produces:** `POST /v1/jobs/:id/keep-fixing` (202, `CreateJobResponse`), `POST /v1/jobs/:id/feedback` (201, `JobFeedback`), `GET /v1/jobs/:id/feedback` (200, `JobFeedbackList`), `POST /v1/runner/jobs/:id/feedback/claim`.

- [ ] Tests, Keep fixing: 404 other owner; eligible with unpassed stored changeset; pending approval withdrawn (`medvya #213` shape); refused for `not_configured` and for `passed`/pushed; `NEEDS_INFO` accepted with a note and no files; same base and snapshot; note carried; lease includes `continuation`; idempotent replay; stop and budget block; audited.
- [ ] Tests, feedback: only on an issue job of the owner; 2,001 characters refused; idempotent; claim is atomic and returns the same items on retry for the same round, rejects a stale fencing token; a finished job refuses feedback with a message pointing to Keep fixing.
- [ ] Test: a direct issue job's budget is capped by the Developer's effective profile and the lease carries its `model`.
- [ ] Run. Expected: FAIL. Implement. Run. Expected: PASS. Commit.

### Task 10: Web

**Files:** Create `apps/web/src/board/JobLoop.tsx` (rounds, phases, QA, stuck report), `apps/web/src/board/JobFeedback.tsx` (prompt box), tests `jobLoop.test.tsx`, `jobFeedback.test.tsx`. Modify `RunDrawer.tsx`, `RunAgain.tsx` (add Keep fixing beside Run again), `jobs.tsx`, `approval.tsx`, `lib/api.ts`, `apps/api/src/notifications.ts` (stuck report in the notification).

- [ ] Tests: "Round 2 of 4" derives from events, "of 3" on Keep fixing; each round's result and the stop reason are shown in words; phases show under "What the agent understood"; QA and stuck-report guess are labelled as model output; approval lists test files changed and QA defects first; Approve is absent when verification isn't passed and the reason is one sentence; Keep fixing shows only when eligible and a double click sends one key; feedback shows "Waiting for the next round" then "Delivered to round N"; a finished job's box becomes the Keep fixing note; `NEEDS_INFO` shows questions and the answer box; offline and error states; `Enter` submits and the box has a label.
- [ ] Run. Expected: FAIL. Implement. Run. Expected: PASS. Commit.

### Task 11: Docs and whole-branch check

**Files:** `docs/handoff.md`, `docs/p1-tracker.md`, `docs/runbooks/` (sandbox build note), `README.md` if it describes runs.

- [ ] Update the docs. Build the image if not built.
- [ ] Run typecheck, lint, Prettier, the web build and all four test suites with the environment in Global Constraints. Expected: all pass. Commit.
