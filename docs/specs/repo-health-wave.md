# Repo health wave: repositories at a glance, setup checklist, "Dev only"

The owner asked (2026-11-04) what NEXUS is missing as a dev-only command center, apart from the AI keys. A walkthrough
of the running app found:
- 30 installed repositories, but no way to see which one needs work (FR-GH-05, a P0 gap).
- No sign of what is still missing before NEXUS can run anything.
- No real "Dev only" mode: the workspace lived only in the URL, and Business was faded, not hidden.

PRD: FR-GH-05 (repository details: branches, issues, PRs, CI summary), FR-WKS-01 (mode switch), FR-RUN-01, FR-ACC.

## Contracts

- `github.ts`:
  - Types: `CiState`, `CiSummary`, `RepositoryHealth`, `RepositoryHealthList`, `PullRequestSummary`, `BranchSummary`, `CheckRunSummary`, `RepositoryDetails`.
  - Constant: `REPO_LIST_CAP = 100`.
- `workspaces.ts`: `Workspace.enabled` and `UpdateWorkspaceRequest`.
- `setup.ts`: `SetupStepKey`, `SetupStep`, `SetupQuery` and `SetupStatus`.

## API

- **`GET /v1/repositories/health?projectId=`** returns the project's bound repositories, or every installed one without `projectId`.
  - Per repository: open PRs (drafts counted), open issues (GitHub's count minus PRs), and CI from the check runs on the default branch's head.
  - Two GitHub calls per repository, 4 at a time, each answer cached for 3 minutes.
  - A repository GitHub refuses carries its own `error`; the others still show.
  - A project with nothing bound asks GitHub nothing.
- **`GET /v1/repositories/:repoId/details`** (FR-GH-05) returns:
  - open PRs, flagged when opened from a NEXUS work branch
  - branches: default first, then protected, then by name
  - checks: failing first
- **Commit statuses aren't counted.** They need `statuses:read`, which the app doesn't request; the UI says so.
- **`PATCH /v1/workspaces/:id {enabled}`** shows or hides a workspace.
  - It's a display preference: projects and records stay.
  - The owner's workspace rows are locked together. Hiding the last shown one → 409.
  - Setting the current value is a no-op.
  - Audited as `workspace.hide` / `workspace.show`.
  - Migration `0010_workspace_enabled.sql`.
- **`GET /v1/setup?projectId=`** runs live checks:
  - GitHub App installed.
  - Repositories bound (in the project, or in any Dev project).
  - `ai.json` usable.
  - A runner online.
  - `search.json` (optional).

  Details are owner-safe 409 messages; no file content ever appears.

## Web

- **Home**:
  - "Before NEXUS can work" checklist while required steps are open. It has Bind repositories (opens Settings → Workspaces), Pair a runner, the install link and runbook paths.
  - "Repositories" section: the five that need the owner, then "All N repositories".
- **`drawer=repos`**: every repository, sorted by attention.
  - Order: failing CI, then unreadable, then PRs to review, then CI running, then latest push. Archived ones go last.
  - Summary line, a "Needs you / All" filter and search.
- **Repo drawer**: CI with failing checks first and log links, open PRs, branches. The long list is replaced by "← All repositories".
- **Settings → Workspaces**:
  - "Show Dev / Show Business" switches.
  - A repository filter once more than 8 are installed.
  - A loading state instead of "Install the app" while the list loads.
  - Any tab opens from the hash (`#ws`, `#auto`, …).
- **Dev only (Business hidden)**:
  - A URL without `ws` (or with the hidden one) shows Dev.
  - The workspace switch, the Business zone and Business agents (Financial analyst) are hidden.
  - The scope menu offers "All projects".
  - One Dev project → the board opens on it and can act.
- **Copy**:
  - "arrives in P1" placeholders now say what exists today.
  - Drawers say "Close" (they open over Home too).
  - The Automations zone links to Settings → Automations.

## Tests

- API: `test/repository-health.test.ts` covers health, details, cache, project scope, rate limit and setup. `test/workspaces.test.ts` covers show/hide.
- Web: `src/board/repos.test.tsx`, plus updates in the github, home, workspaces, safety and Board tests.
