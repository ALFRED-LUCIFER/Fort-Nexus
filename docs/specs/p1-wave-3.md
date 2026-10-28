# P1 wave 3: agent team (V1C) and AI-assisted insight

Base: `p1` after wave 2. PRD:
- EPIC AGT FR-AGT-01/06/07/09
- FR-WKS-04/05
- Part C C-04 (autonomy dial)
- §11.7 / §11.16
- FR-RES-08 ("why it matters"), FR-MON-07 (triage)
- FR-BIZ-04/05

Contracts (binding; changes only through the coordinator):
- new: `agents.ts`, `plans.ts`
- `research.ts`: `AiConfidence`, `FindingExplanation`
- `monitoring.ts`: `IncidentTriage`
- `business.ts`: `orders.idColumn`, `refunds`, `orderItems`, `RevenueSummary*`, `TopProducts*`
- `conversations.ts`: `Thread.profileVersionId`, `BUSINESS_METRIC` metrics `REVENUE` / `TOP_PRODUCTS`

## Rules for every module

- **Wave 2 scope rules hold** (`docs/specs/p1-wave-2.md`). Use `resolveProject` / `ownerWorkspaceIds`, with tests showing a decoy project can't see or change another's data.
- **Model output is untrusted data.** Each model call is a tool call whose input schema is the contract type, validated with Zod; invalid output means "the model couldn't produce one", never a partial save. The prompt puts finding/incident/goal text inside clearly delimited untrusted-data fences.
- **Model text never authorizes anything or claims an outcome.** Anything AI-written is labelled in the UI as "AI inference: unverified" with its confidence label, and cites only ids/URLs from its input; the server checks that.
- **Every model call** uses `loadAi(config.aiFile)` from `apps/api/src/ai.ts`. The model comes from the agent's effective profile (`settings.model ?? ai.model`). Calls are capped with `max_tokens` and audited (`metadata`: agent, profile version, model, outcome; never prompt or response text). Without `ai.json`, return 409 with the runbook path, as Talk does.
- **Creation is idempotent.** POST that calls a model needs an Idempotency-Key or is cache-once per object, so a retry never pays twice.
- **Web:** zone/drawer patterns, honest loading/empty/error/offline states, the "All" view read-only, keyboard/screen-reader access, and color always paired with text.

## Cross-module signatures (pinned so the parallel work fits)

- `apps/api/src/agents/service.ts` (agent A):
  - `resolveAgentProfile(db: Db, ownerId: string, projectId: string, agent: AgentKey): Promise<EffectiveAgentProfile>` resolves the project read-only, then applies project > workspace > built-in default and the global ceiling.
  - `DEFAULT_AGENT_SETTINGS: Record<AgentKey, AgentProfileSettings>` exports the built-in defaults.
- Agents B, C and D code against `resolveAgentProfile`.
  - Until A merges, they use one tiny adapter file in their own module, `<module>/agent-profile-adapter.ts`, with the same signature. It returns a built-in default (`engine: "MESSAGES_API"`, `autonomy: "ACT_WITH_APPROVAL"`, all tools, `maxCostUsdPerTask: 1`, `maxTurns: 10`, `responseDetail: "STANDARD"`, no `model`, `versionId: null`, `level: "DEFAULT"`, `version: 0`, `ceilingApplied: []`).
  - Its comment says the coordinator deletes it at merge.

## A: agent registry and versioned profiles (`apps/api/src/agents/**`, web Agents drawer + Settings → Agent profiles)

- **Built-in roster:** the 7 `AgentKey`s, each with a label and one-line description, and per-agent default settings with conservative tools:
  - Chief of Staff: all tools, `ACT_WITH_APPROVAL`
  - Developer: `jobs.read`, `jobs.create.issue_run`, `github.read`
  - QA: `jobs.read`, `github.read`, `jobs.create.diagnostic`
  - DevOps: `monitoring.read`, `jobs.read`, `jobs.create.diagnostic`
  - Product: `github.read`, `research.search`
  - AI researcher: `research.search`, `research.run`
  - Financial analyst: `business.metrics`
  - Default autonomy: `ACT_WITH_APPROVAL`, except Product, which is `DRAFT`.
- **Storage:** `agent_profile_versions` is append-only (DB trigger, like `run_events`). Each row has `(workspace_id, project_id NULL for workspace level, agent, version)`, and a unique `(agent, workspace_id, project_id, version)`.
- **Setting a profile:** `PUT /v1/agents/:agent/profile` (`SetAgentProfileRequest`).
  - The workspace must be the owner's. A project level needs `resolveProject(write)`.
  - It appends version n+1 and records an audit entry.
  - The ceiling is applied at **resolution**, not at save: stored settings keep what the owner asked for, and the effective profile shows `ceilingApplied`.
- **Reading:**
  - `GET /v1/agents?projectId=` (required) returns `AgentList`, with the `record` counted from plan steps (0 until agent B merges; keep that count in one function).
  - `GET /v1/agents/:agent/versions?projectId=` returns history.
- **Global ceiling (server constants):**
  - `AUTONOMOUS` is kept only if every allowed tool is R0/R1 (`TOOL_RISK`); otherwise it is capped to `ACT_WITH_APPROVAL`.
  - `maxCostUsdPerTask` ≤ 50 and `maxTurns` ≤ 200 (already in the schema).
  - Engine `CLAUDE_AGENT_SDK` only for DEVELOPER / QA (they're the runner's coding engine); anything else is capped to `MESSAGES_API`.
  - Unit-test each rule.
- **Talk pinning (FR-WKS-05):**
  - Creating a thread stores the CHIEF_OF_STAFF effective `versionId` (`profile_version_id`, nullable) and returns it.
  - Talk uses that pinned version's model for routing: the built-in default if null, else that exact stored version, even if a newer one exists.
  - This is a small, additive edit in `apps/api/src/conversations/**`, which you own for this wave.
- **Web:**
  - Board grouping `Agents` (replace the `P1Button` "Agents view arrives in P1"): a swim-lane per agent listing the agent card and its effective autonomy/tools. Plan steps join this when B merges.
  - Agent drawer `agent:<KEY>`: autonomy dial (Suggest / Draft / Act with approval / Autonomous, with what each means, and the ceiling note), allowed tools as checkboxes with their risk tier, limits, version history, Save (needs a project; the level choice is "this project" or "whole workspace").
  - The Talk drawer shows the pinned profile version ("Chief of Staff v3" / "default").
- **Tests:** resolution order, append-only, ceiling caps, Talk pins and keeps the old version after an update, decoy project, workspace/project level authorization.

## B: Chief of Staff plans (`apps/api/src/plans/**`, web Plans & queue zone + `plan:<uuid>` drawer)

- **Drafting:** `POST /v1/plans` (Idempotency-Key; `CreatePlanRequest`).
  - Resolve the project (write) and the CHIEF_OF_STAFF profile; store its `versionId`.
  - The model gets the goal plus a compact catalog of what it may target in that project: bound repositories with open issue numbers (up to 20), watchlists, business connectors with a dictionary, and the tool catalog. It returns `{ steps: [{ title, agent, action, dependsOn }] }` via one tool call, validated against `PlanStepAction` / `AgentKey`, ≤ `MAX_PLAN_STEPS`, with `dependsOn` only earlier indices.
  - The server then sets `blockedReason` per step:
    - the target is unknown or outside the project
    - the agent's effective profile lacks `toolForAction(action)`
    - the agent's autonomy is `SUGGEST` or `DRAFT`
    - a `DEV_ISSUE_TO_PR` repo isn't bound
  - It computes `planHash` and stores the plan as `DRAFT`.
  - A deterministic catalog read is fine for the target catalog; reuse the existing module functions.
- **Deciding:** `POST /v1/plans/:id/decision` (`PlanDecisionRequest`) is owner-only and checks the hash.
  - Stale hash → 409. Any blocked step → 409 "can't approve a plan with blocked steps".
  - Deny → `DENIED`. Approve → `APPROVED`.
  - Audit both.
- **Cancelling:** `POST /v1/plans/:id/cancel`. Running steps' jobs are cancelled through the existing cancel path; pending steps become `CANCELLED`.
- **Executor:** an API interval tick (beside the reaper) advances `APPROVED` / `RUNNING` plans, one step at a time (FR-AGT-08 parallelism is P2).
  - **Before each step, re-check** the agent's current effective profile still allows the tool, and that emergency stop is not engaged (`system.ts`). If not, the step FAILS with the reason. Settings never expand an already-approved plan's permissions.
  - **Starting a step:**
    - `jobs.create`: `createJob` with idempotency key `plan:<planId>:<index>`, the owner and `ownerTimezone`. All of main's checks apply, and an issue run's push still waits for its own approval in the Inbox.
    - `research.run`: `createManualRun` + `research.start`.
    - `business.sales_summary`: `getSalesSummary` with the project's scope; it completes immediately.
  - **Completion comes only from the source record:**
    - Job: `COMPLETED` → SUCCEEDED, with an artifact citing the job and its terminal event. FAILED/CANCELLED/EXPIRED/REJECTED → FAILED.
    - Research run: COMPLETED/PARTIAL → SUCCEEDED; FAILED → FAILED.
    - Metric: `AVAILABLE` → SUCCEEDED with a METRIC source; `UNAVAILABLE` → FAILED with the reason.
  - A failed step makes its dependents `SKIPPED` and the plan `FAILED`. All succeeded → `COMPLETED`.
  - Write a notification when a plan finishes: COMPLETED is `TASK_DONE`, FAILED is `TASK_FAILED`, dedup key `plan:<id>:<status>`. The notification subject has no plan field, so the body names the plan and the web deep link is the `plan:` drawer opened via the Inbox's "Open". Add `subject.planId` only if you truly need it, and report it as a contract change.
- **Lists:** `GET /v1/plans?projectId=` and `GET /v1/plans/:id`.
- **Web:**
  - The Plans & queue zone shows the newest plans with their status.
  - The `plan:<uuid>` drawer shows goal; steps with agent, action summary, dependencies, status and blocked reasons; artifacts as source chips (run drawer links); and Approve (showing the hash prefix) / Deny / Cancel.
  - Create a plan from a goal textarea (needs a project).
  - The command bar's Plan mode creates a plan from the typed goal and opens its drawer (replacing "Plan isn't available yet"; "All" → "Pick a project first").
- **Tests:**
  - Invalid model output → no plan; a cycle or forward dependency is rejected; blocked reasons; hash mismatch; approve with blocked → 409.
  - Executor: one step at a time; dependency-skip; success only from the job's terminal state (a job whose agent output claims success but is FAILED → step FAILED); idempotent restart (tick twice → one job).
  - A profile narrowed after approval fails the step; emergency stop; decoy project; notification once.

## C: AI explanations (`apps/api/src/research/explain.ts` + `apps/api/src/monitoring/triage.ts`, their routes, web buttons)

- **Research:** `POST /v1/research/findings/:id/explain` creates once and caches it in `research_finding_explanations` (unique `finding_id`). A second POST returns the cached one (200) without calling the model; `GET …/explanation` returns it or 404.
  - It uses the AI_RESEARCHER profile of the finding's project. Without `research.search` in that profile → 403.
  - The model sees the finding title, excerpt and source URLs/publishers/tiers.
  - `citedUrls` must be a subset of the finding's source URLs, else the result is rejected.
  - Resolve the project with `write: true` (an archived project → 409).
- **Monitoring:** `POST /v1/incidents/:id/triage` / `GET …/triage` work the same way, with `incident_triages` unique per incident and the DEVOPS profile (needs `monitoring.read`).
  - The model sees the incident, its app (name, environment, health URL host only) and its evidence checks.
  - Every `evidenceCheckIds` entry must belong to the incident.
  - The suggested next step is advice text only: no actions, no URLs beyond the app host.
- **Web:**
  - Finding cards and the brief get "Explain" → an inline panel labelled "AI inference: unverified" with confidence, cited sources and the model.
  - The incident drawer gets "Triage" → hypotheses with confidence and links to the cited checks; the old disabled "agent triage" P1Button goes away.
  - Not configured → the setup hint; failure → the error state.
- **Tests:** cache-once (the model is called once across two POSTs and a concurrent pair); citation outside the input → rejected and nothing stored; invalid tool output; 409 without ai.json; profile without the tool → 403; decoy project; archived → 409.

## D: revenue and top products (`apps/api/src/business/**`, `business.tsx`, Talk metric answers)

- **Dictionary:** validation and the connection test cover the new optional sections, with identifiers in the allowlist and `orders.idColumn` required for items.
- **Tools:** `getRevenueSummary(scope, query)` and `getTopProducts(scope, query)`, with the same `ToolScope`, `MetricQuery`, window, partial-day, compare and `Unavailable` rules as sales.
  - **Revenue:** refunds are summed by refund time; net = gross − refunds in SQL `numeric`. The formula text is exact. Each result carries the orders provenance and the refunds provenance. Without a `refunds` section → `UNAVAILABLE` / `NOT_DEFINED`, never "0 refunds".
  - **Top products:** paid orders in the window joined to items, top `TOP_PRODUCTS_LIMIT` by revenue. Product names are masked like payment reasons, inside SQL, and capped. Missing `orderItems` / `idColumn` → `NOT_DEFINED`.
  - Routes: `GET /v1/business/metrics/revenue` and `GET /v1/business/metrics/top-products` (`MetricQuery`).
  - Audit like the other tools.
- **Talk:** `BUSINESS_METRIC` with `REVENUE` / `TOP_PRODUCTS` uses these tools, with METRIC sources and the formula in the text; unavailable → said plainly. Today `tools.ts` maps every non-sales metric to "Failed payments"; fix that switch.
- **Web:** the business drawer gets revenue tiles (gross, refunds, net with the formula shown) and a top-products table, both with provenance/partial labels, plus dictionary form fields for the new sections.
- **Tests:** seeded refunds across the time-zone boundary (refund day ≠ order day); net exact to the cent; masked product names (an email in a product name); NOT_DEFINED; a read-only role still enforced; decoy project; Talk answers for both metrics.

## Done when

All suites, typecheck, lint, `prettier --check` and the web build pass. Adapters are removed at merge. Every requirement above has a test that names it.
