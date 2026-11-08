# Spec: hand an issue to Claude in the cloud

Status: approved by the owner on 2026-11-08 ("make all the changes and push"). Owner of the decision: the owner.

## Why

Today an issue runs only on the home runner: the Agent SDK in a rootless Docker sandbox. The owner also wants to send an issue to **Claude Code in Anthropic's cloud**, so work continues when the home machine is busy or off, and the result is a draft PR.

## The mechanism (verified 2026-11-08)

- **Claude Code routine with an API trigger** ([fire reference](https://platform.claude.com/docs/en/api/claude-code/routines-fire), [routines](https://code.claude.com/docs/en/routines)).
- **Call:** `POST https://api.anthropic.com/v1/claude_code/routines/trig_…/fire`.
- **Headers:** `Authorization: Bearer sk-ant-oat01-…` (a per-routine token), `anthropic-version: 2026-10-21`, and `anthropic-beta: experimental-cc-routine-2026-04-01` (optional; the endpoint accepts requests with or without it).
- **Body:** `{"text": "…"}`, at most 65,536 characters.
- **200 response:** `{type: "routine_fire", claude_code_session_id, claude_code_session_url}`. It answers once the session exists and doesn't wait for the run to finish.
- **Errors:**

  | Status | Meaning                                                       |
  | ------ | ------------------------------------------------------------- |
  | 400    | Bad version, text too long, or the routine is paused          |
  | 401    | Missing or wrong token                                        |
  | 403    | The account or organisation has no access                     |
  | 404    | The routine doesn't exist                                     |
  | 429    | Hourly fire limit reached (comes with `Retry-After`)          |
  | 500    | Server error                                                  |
  | 503    | Overloaded                                                    |

- **Limits:** 30 fires per routine per hour, 100 per account per hour.
- **No idempotency key:** every successful call is a new session.
- **Billing:** the owner's claude.ai plan (Pro, Max, Ultra, Team or Enterprise). An API key can't call this endpoint.
- **How the text arrives:** wrapped in `<routine-fire-payload>` as untrusted data. The routine's saved prompt must opt in to acting on it.
- **Branches and PRs:** runs push `claude/…` branches. PRs carry the owner's GitHub user. The Claude GitHub App must be installed on the repository.
- **Repositories:** a routine has its own repositories. NEXUS maps one routine to one repository.

## Scope

**In scope:**

1. **Configuration.** `~/.nexus/claude-cloud.json` (mode 0600, read on every call, like `ai.json`):
   ```json
   { "routines": [{ "repository": "owner/name", "fireUrl": "https://api.anthropic.com/v1/claude_code/routines/trig_…/fire", "token": "sk-ant-oat01-…" }] }
   ```
   - `fireUrl` must match exactly `^https://api\.anthropic\.com/v1/claude_code/routines/trig_[A-Za-z0-9]+/fire$`, so the token can't be sent anywhere else.
   - The repository name matches case-insensitively and appears at most once in the file.
   - The env var `NEXUS_CLAUDE_CLOUD_FILE` overrides the path.
2. **Status.** `GET /v1/repositories/:repoId/issues/:number/cloud-handoff?projectId=` returns `CloudHandoffState`: the routine status (never the token) and the issue's newest handoff in that project. It includes the PR GitHub shows for the handoff.
3. **Preview.** `POST …/cloud-handoff/preview {projectId}` returns the exact `text`, rows, `actionHash` and `expiresAt`. It lives `PROPOSAL_TTL_MS` and is stored in `cloud_handoff_previews`.
4. **Approve (R2).** `POST …/cloud-handoff {projectId, actionHash, confirmResend}` with an `Idempotency-Key` fires the routine once and answers with the `CloudHandoff`.
5. **Issue drawer.** A "Hand off to Claude (cloud)" action next to "Start run". It shows the preview card, approval, live status, the session link, the PR link, and the UNKNOWN and FAILED states.
6. **Setup checklist.** An optional `CLAUDE_CLOUD` step.
7. **Docs.** `docs/runbooks/claude-cloud.md` (setup and the routine prompt to paste) and README.

**Out of scope:**

- Creating routines from NEXUS. There's no public API for it.
- Reading session progress. No documented status API exists.
- Notifications.
- GitHub-event triggers.
- Managed Agents.
- claude-code-action.

## Rules

- **Scope.** Every call is scoped by owner, the project's workspace and `projectId`, and correlation ID (`req.id`).
  - The project must be a **DEV** project the owner can write to (`resolveProject(…, { write: true, mode: "DEV" })`; archived returns 409).
  - The repository must be **bound** to that project. Otherwise 403 `FORBIDDEN` with `field: "repositoryId"`, as in `research/opportunities/service.ts`.
- **The text** is built by the server from the current GitHub issue (`catalog.issue`) only:
  - the repository, the issue number, URL and title, and the PR rule (draft PR on a `claude/` branch; its description has the line `Fixes #<n>`);
  - the issue body, fenced so no backtick run ends the fence (same technique as `fenced()` in `issue-to-pr.ts`);
  - the extracted acceptance criteria.
  - Comments are not sent. The body is cut to keep the text ≤ 65,536 characters, and the cut is said in the text.
- **The hash** is `sha256(canonical({projectId, repositoryId, issueNumber, routineId, text}))`.
  - At approval NEXUS rebuilds the text from GitHub. If the hash differs from the approved one, the answer is 409: "The issue changed since it was shown; preview it again."
  - A missing preview gets the same message. An expired one gets 409: "This preview has expired; preview it again."
- **Approval order**, all inside one transaction:
  1. `assertNotStopped`.
  2. Owner, project and binding checks.
  3. Preview lookup and expiry.
  4. Idempotency: the same key with the same hash returns the existing row and doesn't fire. The same key with a different hash is 409 `IDEMPOTENCY_KEY_REUSED`.
  5. The issue's newest handoff:
     - STARTING with a live lease → 409: "NEXUS is starting this handoff right now."
     - STARTED or UNKNOWN (including a STARTING row whose lease has lapsed) without `confirmResend: true` → 409 with `details.needsConfirmResend = true`: "Claude is already on this issue; confirm to start another session."
  6. Insert the STARTING row with a 2-minute lease. Then call Anthropic outside the transaction.
- **Fire outcome:**

  | Answer | Row becomes | Stored | API answers |
  | --- | --- | --- | --- |
  | 200, valid body, `claude_code_session_url` is `https://claude.ai/…` | STARTED | `sessionId`, `sessionUrl` | the row |
  | 400, 401, 403, 404 | FAILED (no session exists) | owner-facing error | 409 explaining the fix |
  | 429 | FAILED | `retryAfterSeconds` | 429 `RATE_LIMITED` with `details.retryAfterSeconds` |
  | timeout (20 s), network error, 5xx, 200 with an unusable body | UNKNOWN | — | 502 `UPSTREAM` saying it may have started; check the routine's runs on claude.ai |

  Error texts for the refusals:
  - 401: "The routine rejected NEXUS's token. Generate a new token for the routine on claude.ai/code/routines and update ~/.nexus/claude-cloud.json."
  - 404: "The routine doesn't exist. Check the fire URL in ~/.nexus/claude-cloud.json."
  - 400: "Anthropic refused the request: the routine may be paused."
  - 403: "This claude.ai account can't use routines. Check the plan and that Claude Code on the web is enabled."

  NEXUS **never retries a fire on its own**.
- **The token** goes only in the `Authorization` header to the validated fire URL. It never appears in a log, audit record, error, response or the database. Upstream error bodies are not passed on.
- **Audit**, all with `workspaceId`, `projectId`, `repositoryId`, `issueNumber` and `routineId`; resource type `cloud_handoff`:
  - `cloud_handoff.preview` (with `actionHash`)
  - `cloud_handoff.approve` (with `confirmResend` and the idempotency key's row id)
  - `cloud_handoff.fire`, outcome SUCCEEDED or FAILED, with the HTTP status class and the final status
- **PR (truth ladder: "Sent · session started" → "PR opened" → "Merged").**
  - The first step comes only from Anthropic's 200. The next two come only from GitHub.
  - On a status read for a STARTED or UNKNOWN handoff, NEXUS lists the repository's PRs created at or after `createdAt − 10 min`. It picks the newest one whose head branch starts with `claude/` and whose body contains `Fixes #<n>`, `Closes #<n>` or `Resolves #<n>` (case-insensitive, not followed by a digit).
  - A GitHub error gives `pullRequestCheck: "UNAVAILABLE"`, never "no PR".
- **The UI** has loading, error, offline and stale states, as in the other drawers. Approve is disabled while the request runs. The STARTED or UNKNOWN status polls every 60 s while no merged or closed PR is known. WCAG 2.2 AA.

## Tests

**API (Vitest + Testcontainers + MSW for `api.anthropic.com`):**

- The config file: missing, bad mode, a bad fire URL host, a duplicate repository, and the routine status for a repository with no routine.
- Preview: the hash is stable, the text is fenced and truncated, and the call is refused for an unbound repo, a Business project or an archived project.
- Approval:
  - fires exactly once with the right headers and body;
  - a repeat of the same key doesn't fire;
  - a hash mismatch or an expired preview gives 409;
  - STARTED without `confirmResend` gives 409 `needsConfirmResend`, and with it fires again;
  - 401 / 404 / 429 / 500 / timeout map as in the table;
  - a lapsed STARTING row reads as UNKNOWN;
  - the token never appears in logs or audit metadata;
  - emergency stop gives 409.
- PR matching: the `claude/` prefix, the closing keyword, the created-after window, `#12` not matching `#123`, and a GitHub error giving UNAVAILABLE.

**Web (Vitest + RTL + MSW):**

- The action is hidden or explained when the routine isn't configured.
- Preview, approve and STARTED show the session link.
- The confirm-resend path.
- The FAILED, 429 and UNKNOWN messages.
- A PR found shows its link.
- An axe-clean card.
