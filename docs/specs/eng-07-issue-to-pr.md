# ENG-07 — GitHub issue → draft PR (MVP core)

PRD: EPIC DEV (FR-DEV-01..08), FR-GH-09, FR-INB-01..03, FR-SEC-06/07, §10.3 approval tiers, §17.3 DEV-G01..G08, §17.4 SEC-G01/G04/G05, §18.4 invariants. Contracts: `packages/contracts/src/issue-to-pr.ts`, `jobs.ts` (`DEV_ISSUE_TO_PR`), `runners.ts` (`LeaseResponse.task`). Import them — never redefine.

## Trust model (non-negotiable)

- The **runner** gets only a short-lived installation token restricted to the one repository with `contents: read`, used host-side for `git fetch`. It never enters the sandbox and is never logged.
- The **sandbox** (ENG-05) has network access to the model provider only. No GitHub access from inside.
- The **API** alone holds write capability. It pushes and opens the PR **only** after the owner approves the exact `actionHash` (server-computed sha256 of the canonical `PushDraftPrAction` JSON). Any change to the action → new hash → new decision (SEC-G04).
- NEXUS never merges, never pushes to the base/default branch, and always opens **draft** PRs. Work branches are `nexus/issue-<n>-<last 8 hex of jobId>` (uuidv7's leading digits are a timestamp shared by jobs created within ~1 min; the tail is random). The API computes it and sends it as `IssueToPrTask.workBranch`.
- Issue text, repo content and agent output are untrusted data. They can't change tools, scopes, budgets or approvals (SEC-G01). The agent's summary is shown labelled as "agent report".

## Flow

1. **Create** — `POST /v1/jobs` with `CreateJobRequest` `DEV_ISSUE_TO_PR` (Idempotency-Key as before). API validates: GitHub configured, repo in an installation, installation has `contents: write` + `pull_requests: write`, issue exists and is not a PR, base branch exists (default = repo default branch). API pins an `IssueSnapshot` (incl. `baseSha` of the base branch now) on the job, risk tier `R1`, and queues it. Missing acceptance criteria are allowed but recorded on `job.created` (`missingAcceptanceCriteria: true`) — FR-DEV-01 asks, it doesn't block.
2. **Lease** — for `DEV_ISSUE_TO_PR` the lease response includes `task: IssueToPrTask` with a freshly minted read-only, single-repo token (≤ 1 h). Runner capacity is still 1.
3. **Run (runner)** — `RUNNING`:
   1. Host-side fetch into the bare mirror (`workspace.ts`), token via env-only git config (`GIT_CONFIG_COUNT`/`http.extraHeader`), never argv or on disk; verify `baseSha` exists.
   2. `prepareWorktree` on `workBranch` from `baseSha`.
   3. `runClaudeTask` with a prompt built by the runner: role + rules, then the issue title/body/AC inside clearly delimited untrusted-data fences, instructions to implement the smallest change that satisfies the AC, run the project's tests if they can run offline, and **not** to commit or push. Budget from the job request.
   4. → `VERIFYING`. Build the changeset host-side from the worktree vs `baseSha` (including untracked files, excluding `.git`, applying `CHANGESET_MAX_FILES/BYTES`, symlinks as mode `120000`). Leak scan already ran in ENG-05.
   5. No changes → transition `COMPLETED` outcome `COMPLETED_NO_CHANGES`. Changes → **verification** (FR-DEV-05, below), `test.completed` event, then `POST /v1/runner/jobs/:id/changeset` (`UploadChangesetRequest` incl. `verification`). The API stores it, transitions the job `VERIFYING → AWAITING_APPROVAL`, emits `approval.requested`, and **releases the lease** (the runner is done; the reaper ignores `AWAITING_APPROVAL`).
   6. Clean up the worktree.
   - Engine failures map to `FAILED` with the ENG-05 reason in `job.failed`; budget stops → outcome `BUDGET_EXCEEDED` / `TIMED_OUT`. Cancel / shutdown / stale lease follow ENG-04.
4. **Approve** — `GET /v1/approvals?status=PENDING|jobId=` → `ApprovalList`; `POST /v1/approvals/:id/decision` (`ApprovalDecisionRequest`, owner session + Origin check). Stale/mismatched hash → 409 `CONFLICT`. Expired (`APPROVAL_TTL_MS`) → `EXPIRED` and job `EXPIRED`. Deny → approval `DENIED`, job `COMPLETED` outcome `APPROVAL_DENIED`. Every decision is audited (actor, hash, decision).
5. **Execute (API, on approve)** — record an `external_actions` ledger row (idempotency key `jobId:push_draft_pr`) **before** calling GitHub. Using an installation token with `contents: write` + `pull_requests: write` for that repo only:
   - Git Data API: blobs → tree (`base_tree` = the tree of `baseSha`, deletions as `sha: null`) → commit (parent `baseSha`, author "NEXUS", message `"#<n>: <title>"` + `Refs #<n>`) → create ref `refs/heads/<workBranch>` (never update an existing ref you didn't create).
   - Create a **draft** PR `head=workBranch base=baseBranch`. Body: link to the issue (`Refs #n`, no auto-close), changed files + stats, the agent summary labelled "Agent report (unverified)", the "Tests" section from `action.verification` (status, commands, exit code, duration, output tail in a fence), and "Opened by NEXUS — human review required, never auto-merged".
   - Success → approval `EXECUTED` with `result` from the GitHub response, ledger outcome stored, `external_action.completed` event, job `COMPLETED` outcome `PR_CREATED`.
   - Failure → approval `FAILED` with a safe error message, job `FAILED`.
   - **Retry/crash safety (DEV-G08)**: before creating anything, check the ledger and GitHub for an existing ref/PR for `workBranch`. If they exist, adopt them instead of creating duplicates.
6. **Web** — issue drawer "Start run on <runner>" opens a preview (repo, issue, base branch, work branch pattern, budget fields with the contract's caps, "runs at home in a sandbox; push + PR always ask you first") → `POST /v1/jobs`. The run drawer for issue jobs shows the agent timeline (`agent.message`, `tool.requested/completed`, `tool.denied` egress), the changeset summary, and the **approval gate** per design (exact repo / base / head branch / files / stats / hash prefix, "Never merges. <base> is protected.", Approve push · Deny). After execution it shows the PR link (from `Approval.result`). Inbox button enabled: drawer listing pending approvals with Approve / Deny (FR-INB-01, design `dInbox`), count from `GET /v1/approvals?status=PENDING`.

## Verification (FR-DEV-05)

NEXUS runs the repo's tests itself after the agent; the agent's own claim stays "Agent report (unverified)" (truth hierarchy §15.3). Runner: `apps/runner/src/verify.ts`.

- **What runs** is read from the **base commit** (`git ls-tree`/`cat-file` on the trusted git dir, regular files only), never from the agent's worktree: an agent edit to `.nexus.json` ships in the changeset for review but never changes what runs.
  - `.nexus.json` (`NexusRepoConfig`): `verify.install?`, `verify.test`, `verify.egress`, `verify.timeoutMinutes`. No `verify` key = explicit opt-out. Invalid JSON/schema or an egress host on GitHub (`github.com`, `githubusercontent.com`, `ghcr.io`) or a model provider (`anthropic.com`, `claude.ai/.com`, Foundry/Azure OpenAI domains) → `error`.
  - Else auto-detect at the root: `package.json` with a non-empty `scripts.test` + a lockfile. `pnpm-lock.yaml` → `corepack pnpm install --frozen-lockfile` / `corepack pnpm test`; `yarn.lock` → `corepack yarn install --frozen-lockfile` / `corepack yarn test` (egress + `registry.yarnpkg.com`, `repo.yarnpkg.com`); `package-lock.json` → `npm ci` / `npm test`. Egress `registry.npmjs.org`, timeout 15 min. pnpm/yarn go through corepack: the image ships only npm.
  - Otherwise `not_configured`.
- **Where**: a disposable checkout of the changeset's git tree (base + changes, exactly what would be pushed) in a fresh sandbox container per command (argv, no shell; install then test, one shared deadline). The changeset is built first, so install artifacts (`node_modules`, caches) can never reach it, whatever the repo ignores. Network: none, or the job's egress proxy allowing only the configured hosts. Env: proxy, `CI=true`, cache/tmp dirs under the disposable workspace — no provider key, no GitHub token.
- **Result** (`Verification`): `passed` (exit 0), `failed` (non-zero), `error` (couldn't run: config invalid, Docker/image missing, install failed, `docker run` exit 125, timeout — the reason is the last `[nexus] …` line of `outputTail`), `not_configured`. `outputTail` = redacted, last ≤ 8000 chars of install + test output. Denied egress → `tool.denied { kind: "egress", phase: "verify" }`.
- A failed or errored verification **does not block** the upload: it becomes part of `PushDraftPrAction` (so of the approved hash) and the PR body, and the approval gate shows an amber warning. A cancel during verification stops the container and reports `CANCELLED`; nothing is uploaded.
- The test commands are the repo's own: an agent can change test files or `package.json` scripts. Those edits are in the diff the owner approves; NEXUS verifies the code it pushes, not the agent's honesty.

## Done when

All package suites + typecheck + lint + prettier pass, plus API tests with GitHub mocked covering create-validation, lease token restriction (single repo, contents:read), changeset upload + transition + lease release, hash-mismatch rejection, deny, expiry, execute (tree/commit/ref/draft PR calls), and duplicate-safe retry. Runner tests with a fake API + fake Claude covering changeset building (added/modified/deleted/symlink/limits) and the transitions. Web tests for preview → POST, approval gate → decision with the shown hash, PR link, and inbox.
