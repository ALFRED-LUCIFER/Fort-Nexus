# Wave 6 — workspaces + notifications (last MVP feature wave)

Contracts (binding, read-only for agents): `packages/contracts/src/workspaces.ts`, `notifications.ts`, `projectId` on `CreateJobRequest` / `Job` / `Approval` / `ListJobsQuery` / `ListApprovalsQuery` / `RepositoryQuery`, `Verification.reason`.

## A. Workspaces and projects (FR-WKS-01..03, FR-CSP-01, FR-CXR-01, NFR-CNV-05, CR-001 gate 1)

- Exactly one `DEV` and one `BUSINESS` workspace per owner, created on first use. Projects belong to one workspace. On migration, existing jobs/approvals move into a default Dev project `home` (slug `home`) bound to every repository already used by those jobs.
- **Every** job and approval row carries `project_id` (NOT NULL, FK). Creating a job requires an existing, non-archived project; a `DEV_ISSUE_TO_PR` job requires the repository to be **bound** to that project, and the project must be in the `DEV` workspace — otherwise 403 `FORBIDDEN` ("repository isn't bound to this project"). No implicit fallback to another project, ever.
- Lists filter by `projectId` when given; without it they return the owner-wide aggregate (read-only "All" view). Single-object reads (`GET /v1/jobs/:id`, SSE, approvals) stay owner-scoped but return `projectId` so the UI can bind context; deciding an approval checks the approval's project still exists and isn't archived.
- Endpoints: `GET /v1/workspaces` → `WorkspaceList`; `POST /v1/workspaces/:id/projects` (`CreateProjectRequest`, unique slug per workspace → 409); `PATCH /v1/projects/:id` (`UpdateProjectRequest`, archive keeps history, blocks new jobs); `PUT|DELETE /v1/projects/:id/repositories/:repoId` (repo must be in an installation; unbinding doesn't touch existing jobs). All audited.
- `GET /v1/repositories?projectId=` returns only bound repositories.
- Web: the workspace switch (All | Dev | Business) and the SCOPE breadcrumb project menu become real (`ws` + `project` in the URL). Switching shows "switching re-binds connectors and agent profile · the other project's data leaves this session" as in the design. Code zone, runs, approvals and repositories are filtered by the selected project. **All** is read-only: Execute / Start run / Approve are disabled with "pick a project first". Business projects show honest P1 empty states. Settings → Workspaces tab: create/rename/archive projects, bind/unbind repositories.
- Tests with **decoy data** (NFR-CNV-05): two projects A and B; a repo bound only to A can't start a job from B; B's job list never contains A's jobs; approvals of A aren't listed under B; archived project blocks creation; unbound repo → 403; migration assigns legacy rows to `home`.

## B. Notifications (FR-NTF-01/02/04/05/06, FR-INB-01, CR-001 gate 2)

- Write notifications **in the same transaction** as the triggering event (one call from the place `job.*` / `approval.*` events are written — keep it a one-line hook), deduplicated by a unique `dedup_key` (e.g. `job:<id>:<terminal-state>`, `approval:<id>:<status>`), so retries/replays never create a second one.
- Triggers and fact-based text (never agent narration): job COMPLETED (`TASK_DONE`; for issue jobs say whether tests passed/failed/not verified and whether a PR exists — "ready for review" vs "draft PR #n opened" only from `Approval.result`), FAILED / TIMED_OUT / RECOVERY_REQUIRED / BUDGET_EXCEEDED (`TASK_FAILED`, with the reason and next step), approval requested (`APPROVAL_REQUIRED`), approval expired (`INFORMATIONAL`), emergency stop engaged/released and runner revoked (`SECURITY_CRITICAL`, `projectId: null`). CANCELLED by the owner → no notification.
- Endpoints: `GET /v1/notifications` (`ListNotificationsQuery` → `NotificationList` with `unreadCount`), `POST /v1/notifications/:id/status` (READ / ACKNOWLEDGED). Owner-scoped, project filter honoured.
- Web: Inbox tabs become real (All, Approvals, Failures, Done & notices from notifications; Business/Security/Connections/Blocked honest where empty); unread count on the Inbox button (approvals + unread); opening a notification marks it READ and deep-links to the exact run drawer (and its approval). New notifications show a toast per design (Later / Open; Talk disabled "arrives in P1"), polite live region, deduped across polls, respecting reduced motion.
- Tests: one notification per terminal event even when the event is replayed/retried; correct category/text per outcome (tests passed vs failed vs not verified, PR exists only after EXECUTED); project filter; status changes; owner-cancel → none; web toast + deep link + unread count.

## Small fixes (agent B)

- Rate limiting behind Docker/Tailscale: trust the proxy hop correctly (`trustProxy` for the container gateway / Tailscale Serve) so clients don't share one bucket; test it.
- Runner fills `Verification.reason` (status `error` → why; else null); web shows it.
