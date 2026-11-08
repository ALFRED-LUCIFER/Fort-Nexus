# Run again: start a finished job again

PRD: FR-RUN-06 "retry safely", §API table `POST /v1/jobs/:id/retry`.

## Why

- The owner cancels jobs and had no way to start one again.
- A rerun must not repeat the old run's side effects by accident, or double-start on a double tap.

## What

A finished job can be run again. The rerun is a **new job** linked by `retryOfJobId`. The original is never changed.

- **Which jobs:** terminal statuses only (`isTerminal`): COMPLETED, FAILED, CANCELLED, REJECTED, EXPIRED.
  - Any other status is a 409.
  - RECOVERY_REQUIRED is not terminal and stays refused: it must be reconciled first (FR-RUN-10).
- **Agent:** kept from the original. There is no agent picker: `job.agent` is an attribution label and the runner never sees it.
- **Checks:** a rerun goes through `createJob`, so everything a new job faces applies: project allowed and not archived, emergency stop, budget.
- **Issue runs:** the issue is pinned fresh from GitHub, so the rerun sees the current issue text and base commit, not the old snapshot.
- **Runner pin:** kept if the runner is still live. If it has been revoked, the pin is dropped and any runner may lease the job.
- **Work branch:** new, because it is derived from the job id. Pushing still needs its own approval.

## API

`POST /v1/jobs/:id/retry`: no body, `Idempotency-Key` required, answers 202 with `CreateJobResponse`.

| Case | Answer |
| --- | --- |
| Unknown job, or another owner's | 404 `NOT_FOUND` |
| Not finished, or RECOVERY_REQUIRED | 409 `CONFLICT` |
| Same key, same original | 202 with the same new job, nothing else happens |
| Same key, another original or a normal create | 409 `IDEMPOTENCY_KEY_REUSED` |
| Emergency stop, budget, archived project | the same refusal as a new job |

- **Idempotency:** a rerun's request hash is the original job id, not its body. The body is derived on each call, so a runner revoked between two calls can't turn a replay into a key conflict.
- **Audit:** action `job.retry`, with `retryOfJobId` in the metadata and the request's correlation ID. A normal create stays `job.create`. The new job's `job.created` event also carries `retryOfJobId`.

## Web

`apps/web/src/board/RunAgain.tsx`, used in the run drawer and on each finished row of the Jobs page.

- **Key:** one Idempotency-Key per mounted control. A double tap or a retry after a failed request sends the same key.
- **Wording:** "Run again", then "Queueing…". It never says the run has happened: the new job is queued until a runner picks it up.
- **PR_CREATED:** a confirmation first, saying plainly that it opens a second pull request once that run's push is approved. Errors show inside it, and the key is reused.
- **Disabled, with the visible reason:**
  - The scope forbids it (`scope.blocked`).
  - The job belongs to another project.
  - The browser is offline. The request is never paused for later: a paid run doesn't start by itself after a reconnect.
  - On the Jobs page the scope reason is the list's one line (each row points at it); offline is a short line per row.
- **Pending and errors:** the button is disabled while sending; the server's message shows on failure.
- **On success:** the job lists refresh and `drawer=run:<new id>` opens.
- **On a rerun:** the drawer links "Rerun of <id>" to the original.

## Acceptance

- A cancelled job can be run again and the new job opens, queued, linking back to the original.
- A running or RECOVERY_REQUIRED job shows no control, and the API refuses it.
- A double tap starts one job.
- A failed request (emergency stop, budget) shows the server's message; trying again uses the same key.
- A job that opened a PR asks first.
- In All, an archived project or another project's job, the control is disabled and says why.
- Tests: `apps/api/test/run-again.test.ts`, the rerun case in `issue-to-pr.test.ts`, `apps/web/src/board/runAgain.test.tsx`.
