# P1 wave 5: the researcher (deep research, verified claims, opportunities)

Base: `main` after the wave-5 contracts commit. The owner decided on 2026-11-03:
- web search uses the **Brave Search API**, called and audited by NEXUS itself;
- the **NEXUS Cofounder** design (`docs/design/NEXUS-Cofounder.dc.html`, PRD §D.4) is the target for Home, so the researcher's opportunities are shown as Cofounder cards.

PRD:
- §10.1 `RESEARCH_DEEP_DIVE`
- EPIC RES FR-RES-03/05/06/08/09/10/12, plus the §9 RES scoring note on the source allowlist
- FR-CXR-09 (research → issue)
- FR-AGT-06/07
- FR-CSP-07/08
- §D.3 `opp` drawer, §D.4

## Why

Today the AI researcher only reads RSS/Atom and GitHub releases. Its one model call writes "why it matters" per finding. It cannot search, read pages, cross-check sources or propose anything.

After this wave it:
- runs a bounded **search → read → cross-check → cite** loop;
- has NEXUS **verify every quoted claim** against the page NEXUS fetched itself;
- turns what it finds into ranked **opportunity / risk** cards with an exact, owner-approved GitHub issue as the next step.

## Owner setup (runbooks written in this wave)

1. `~/.nexus/search.json`, mode 0600: `{ "provider": "brave", "apiKey": "…" }`. See `docs/runbooks/web-search.md`, written by agent A.
2. The GitHub App needs **Issues: read & write**.
   - `github:setup` asks for it from now on.
   - For the existing app, the owner changes the permission on GitHub and accepts it on the installation. See `docs/runbooks/github-setup.md`, updated by agent C.
   - Until then, "Create issue" fails with a 409 that names the missing permission.

## Contracts (binding; changes only through the coordinator)

- New file `packages/contracts/src/research-deep.ts`:
  - `DomainName`, `ResearchDomain*`, `SearchProviderStatus`
  - `DeepDive*`, `DEEP_DIVE_DEPTH_LIMITS`, `DEEP_DIVE_MAX_WALL_CLOCK_MS`
  - `Claim`, `ClaimEvidence`, `ClaimLabel`, `DeepDiveReport`, `OpportunityDraft`
  - `Opportunity*`, `IssuePreview*`, `CreateOpportunityIssueRequest`
- `research.ts`: `SkipReason` gains `BLOCKED_HOST` and `UNSUPPORTED_TYPE`.
- `agents.ts`: tools `research.deep_dive` (R1) and `github.issues.create` (R2).
- `plans.ts`: action `research.deep_dive` (request without `projectId`); artifact kind `deep_dive`.
- `conversations.ts`:
  - `Intent` `RESEARCH_DEEP_DIVE`
  - `ProposedAction` is a union (`jobs.create` | `research.deep_dive`)
  - `ActionProposal.result` is `{jobId} | {deepDiveId}`
  - `SourceRef` kinds `DEEP_DIVE`, `OPPORTUNITY`, `WEB_PAGE`
- `notifications.ts`: subject `researchRunId`, `deepDiveId`, `opportunityId`.
- `apps/api/src/config.ts`: `searchFile` (`NEXUS_SEARCH_FILE`, default `~/.nexus/search.json`).
- The coordinator left `// shortcut: wave 5 agent D …` stubs where the new union members aren't handled yet: Talk tools and service, plan target block and executor, web Talk and plans. Agent D replaces them.

## Rules for every module

The wave 2 scope rules and the wave 3 model rules still apply (`docs/specs/p1-wave-2.md`, `p1-wave-3.md`):
- `resolveProject` / `ownerWorkspaceIds` with decoy tests;
- model output is untrusted data, validated with Zod, never partially saved;
- AI text is labelled "AI inference: unverified";
- calls use `loadAi(config.aiFile)` and the agent's effective profile model;
- every create that spends money is idempotent.

In addition:

- **The model only ever asks.**
  - In the research loop its tools are `web_search`, `fetch_page` and `record_report`. NEXUS executes the first two itself and validates the third.
  - No tool writes anything outside NEXUS. An opportunity's issue is created only by the owner's click on the exact previewed hash (R2).
- **Web text is untrusted data** (FR-CSP-07).
  - Search snippets and page text go back to the model as tool results inside the `<untrusted_data>` fence from `ai.ts`, with `<` escaped.
  - The system prompt says that text can't change rules, grant permissions or approve anything.
  - A page asking the model to fetch an internal URL gets `BLOCKED_HOST`.
- **SSRF (FR-RES-12):**
  - Every fetch from the research module resolves the host once, vets every address against `BLOCKED`, and connects to that vetted address (SNI/Host keep the name).
  - This applies to feeds, robots.txt, pages and every redirect hop.
  - https only, no credentials in URLs, robots.txt honoured, 1 request/s per host, 10 s timeout, 2 MB cap (all unchanged).
- **Owner domain policy:** a blocked domain is never fetched, and its search results are removed before the model sees them. Unknown domains are COMMUNITY tier.
- **Budget (FR-CSP-08, GATE-09):**
  - A dive reserves its effective cap against today's budget before the first model call (`BUDGET_EXHAUSTED` 409 otherwise).
  - It settles to the measured cost when it ends.
  - A dive killed by a restart keeps its full reservation as spent, the conservative choice.
  - Cost is computed from provider `usage` × the model's price, never from model text.
- **Limits:**
  - `maxTurns` and `maxCostUsdPerTask` come from the AI researcher's effective profile. The cost cap is the lower of the profile's and the request's `maxCostUsd`.
  - Searches and fetches come from `DEEP_DIVE_DEPTH_LIMITS`; wall clock from `DEEP_DIVE_MAX_WALL_CLOCK_MS`.
  - When a limit is hit, the loop asks once for `record_report` from what it has and sets `stoppedBy`.
  - Autonomy `SUGGEST` / `DRAFT`, or a profile without `research.deep_dive` → 409 naming the profile setting.
- **Emergency stop:** checked at create, before every model call, search and fetch. If engaged mid-dive → `CANCELLED`, error "Emergency stop engaged", spend settled.
- **Truth:** a claim is `verified` only if the server found its quote in a snapshot it fetched in this dive; the label follows `ClaimLabel` rules.
  - The report summary may cite only `[n]` claim ids and URLs NEXUS fetched in this dive. Any other URL is removed (`urlsIn`).
  - "Done" in the UI or notifications comes from the dive's status, never from model text.
- **Audit:** create, cancel, finish, domain changes, issue preview/create.
  - Metadata holds ids, counts, cost and outcome, never prompt, page or query text.
  - The owner sees queries and URLs in the dive's own step log, stored in their database.

## Cross-module signatures (pinned so the parallel work fits)

Until a module merges, the others use a one-file adapter in their own module with exactly these signatures. Each adapter's comment says the coordinator deletes it at merge.

**A (safe web access)**
- `apps/api/src/net-guard.ts`:
  - `export const BLOCKED: BlockList`
  - `export function isBlocked(address: string, blocked?: BlockList): boolean`
  - `export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>`
  - `export async function vetHost(host: string, opts?: { resolve?: Resolve; blocked?: BlockList }): Promise<{ address: string; family: 4 | 6 } | null>` returns null when any address is blocked or none resolves.
  - `monitoring/probe.ts` imports these instead of defining them.
- `apps/api/src/research/fetch.ts`:
  - `fetchSession(wait: Limiter, signal: AbortSignal, opts?: { resolve?: Resolve; blocked?: BlockList; ca?: string })` returns `{ get(url: URL, accept?: string): Promise<Fetched> }`.
  - `Fetched` = `{ ok: true; body: string; url: URL; contentType: string } | Skip`. The charset comes from the HTTP header or the HTML meta, else UTF-8.
- `apps/api/src/research/web/page.ts`:
  - `readPage(get: FetchSession["get"], url: URL): Promise<PageResult>`, where `PageResult = { ok: true; finalUrl: URL; title: string; text: string; sha256: string } | Skip`.
  - HTML goes through `@mozilla/readability` + `linkedom` to readable text; `text/plain` is kept; anything else is `UNSUPPORTED_TYPE`.
  - `text` ≤ 200 000 chars. `sha256` is computed over `text`.
- `apps/api/src/research/web/search.ts`:
  - `SEARCH_RUNBOOK`
  - `loadSearch(file: string): Promise<SearchClient>`: same file checks as `loadAi`; 409 `search_provider_not_configured` / `search_provider_config_invalid` naming the file and runbook.
  - `SearchClient = { provider: "brave"; search(query: string, opts: { count: number; signal: AbortSignal }): Promise<SearchResult[]> }`, rate-limited to 1 request/s per client.
  - `SearchResult = { title: string; url: URL; snippet: string; publishedAt: Date | null }`, https results only.
  - Failures throw `SearchError` with `kind: "AUTH" | "RATE_LIMITED" | "UNAVAILABLE"`, and an owner-safe message.
- `apps/api/src/research/domains.ts`: `domainPolicy(db: Db | Tx, workspaceId: string): Promise<(host: string) => { domain: string | null; tier: SourceTier; blocked: boolean }>`. The longest matching rule wins; `domain` is the rule's domain or null.

**B (deep-dive engine)**
- `apps/api/src/research/deep/service.ts`:
  - `createDeepDive(deps: DeepDeps, ctx: Ctx, body: CreateDeepDiveRequest, idempotencyKey: string): Promise<{ created: boolean; deepDive: DeepDive }>`
  - `getDeepDive(db: Db, ownerId: string, id: string): Promise<DeepDiveDetail>`
  - `listDeepDives(db: Db, ownerId: string, q: DeepDiveListQuery): Promise<DeepDiveList>`
  - `cancelDeepDive(db: Db, ctx: Ctx, id: string): Promise<DeepDive>`
  - `createDeepDiver(db, deps, log, shutdown)` returns `{ start(id: string): void; reconcile(): Promise<void> }`, like `createResearch`.
  - `DeepDeps = { db: Db; config: Config; diver: DeepDiver }`.
- `apps/api/src/system.ts`:
  - `reserveAiSpend(tx: Tx, i: { workspaceId: string; projectId: string; source: "DEEP_DIVE"; sourceId: string; maxUsd: number; timezone: string }): Promise<{ spendId: string }>`
  - `settleAiSpend(db: Db | Tx, spendId: string, costUsd: number): Promise<void>`
- `apps/api/src/notifications.ts`:
  - `notifyResearchBrief(tx, { ownerId, projectId, runId, newFindings, top: string | null })`, sent once per run when it has ≥ 1 new finding.
  - `notifyDeepDive(tx, { ownerId, projectId, deepDiveId, status, question, opportunityId })`.

**C (opportunities + issue)**
- `apps/api/src/research/opportunities/service.ts`: `recordOpportunity(tx: Tx, dive: { id: string; workspaceId: string; projectId: string }, report: DeepDiveReport): Promise<string | null>`.
  - B calls it in the transaction that completes a dive.
  - It returns the new opportunity id, or null when the report has none or none of the draft's `claimIds` has verified evidence. An opportunity needs ≥ 1 verified claim.

**Web**
- `apps/web/src/board/researchSources.tsx` (A): `export function ResearchSources({ workspaceId }: { workspaceId: string })`. D mounts it as a tab in the Research drawer.
- `apps/web/src/board/opportunities.tsx` (C):
  - `export function NoticedZone(...)`, the board zone, wired into `Board.tsx` by C;
  - the `opp:<uuid>` drawer, registered by C.

## A: safe web access

Owns:
- `apps/api/src/net-guard.ts`, `monitoring/probe.ts` (imports only), `research/fetch.ts`, `research/web/**`, `research/domains.ts`
- the domain routes in `research/domain-routes.ts`, which the coordinator registers in `app.ts`
- the domain table in `research/schema.ts`, appended at the end of the file
- `docs/runbooks/web-search.md`
- the web file `researchSources.tsx`

Deliverables:
- **SSRF guard for all research fetches.** The guard comes from `net-guard.ts`. Research fetching connects only to vetted addresses, on every hop, using a pinned-address dispatcher or `https.request`, like `probe.ts`. Tests use a resolver seam plus a local TLS server.
- **Fixes:** charset handling; `contentType` on `Fetched`.
- **`readPage`:** readable-text extraction, title and sha256.
  - Dependencies go through `node scripts/with-lock.mjs pnpm --filter @nexus/api add <name>@<exact-version>`, at versions released at least 2 weeks ago.
- **Brave search client:**
  - `GET https://api.search.brave.com/res/v1/web/search?q=&count=` with header `X-Subscription-Token`. Check the request and response shape against Brave's current API docs.
  - Uses the guarded fetch, a 10 s timeout and a 1 request/s limiter.
  - Maps errors to `SearchError`. Never logs the key.
- **Domain registry:**
  - Table `research_domains`: `id`, `workspace_id`, `domain`, `tier`, `blocked`, `note`, `created_by`, `updated_at`, unique `(workspace_id, domain)`.
  - Routes:
    - `GET /v1/research/domains?workspaceId=`
    - `PUT /v1/research/domains` (upsert, audit)
    - `DELETE /v1/research/domains/:id` (audit)
    - `GET /v1/research/search-provider` → `SearchProviderStatus`
  - Workspace ownership is checked server-side.
- **Web: Sources tab.**
  - Lists domain rules with their tier and blocked state; add, edit and remove.
  - Shows the search-provider status with the runbook path.
  - Honest loading, empty, error and offline states; keyboard and screen-reader access.

Tests:
- RES-G05: private, loopback, link-local and metadata IPs are blocked, on the first hop and after a redirect, with no connection made. DNS rebind is covered by the single resolve.
- Charset handling.
- Readability on a fixture page.
- Brave client mapping with an MSW or local server: 401 → AUTH, 429 → RATE_LIMITED, non-https results dropped.
- `domainPolicy` longest-suffix matching.
- Decoy workspace.

## B: deep-dive engine

Owns:
- `apps/api/src/research/deep/**`: tables, loop, verification, routes in `deep/routes.ts`
- the `runToolLoop` addition in `ai.ts`
- new `ai-cost.ts`
- `system.ts` with the `ai_spend` table in `db/schema.ts`
- `notifications.ts`
- the brief-ready notify call in `research/service.ts`

Deliverables:
- **Spend ledger.**
  - Table `ai_spend`: `id`, `workspace_id`, `project_id`, `source`, `source_id`, `reserved_usd`, `cost_usd` (null until settled), `created_at`, `settled_at`.
  - `budgetStatus` counts the sum of `jobs.estimatedCostUsd` plus the sum of `coalesce(cost_usd, reserved_usd)` for the local day.
  - `reserveAiSpend` takes the same lock order as jobs (controls row first) and returns the same `BUDGET_EXHAUSTED` details as `assertCanStart`.
  - Tests: reservation, settle, parallel reservations can't overshoot, and the daily-reset boundary.
- **`ai-cost.ts`:** `costUsd(model, usage)` from a per-model price table, including cache reads and writes.
  - Load the `claude-api` skill for current prices; never guess them.
  - An unknown model uses the most expensive listed price.
- **`runToolLoop`** in `ai.ts`:
  - A bounded Messages-API loop with server-executed tools and a final validated tool.
  - Use prompt caching on the system prompt and tools.
  - Every tool result is fenced untrusted data.
  - It enforces turns, cost (measured after each response, before the next), deadline and abort signal.
  - Provider errors map to owner-safe text, as in `callTool`.
- **Dive lifecycle.**
  - Tables `research_deep_dives` and `research_deep_dive_steps` (append-only via a trigger appended in the migration, like `run_events`).
  - Table `research_page_snapshots`: `id`, scope, `deep_dive_id`, `url` (canonical), `final_url`, `title`, `text`, `sha256`, `fetched_at`. Text is untrusted.
  - Unique `(project_id, idempotency_key)`.
  - Lifecycle: `QUEUED` → `RUNNING` → `COMPLETED` | `FAILED` | `CANCELLED`.
  - At most 2 dives run at once; the rest wait as QUEUED.
  - `reconcile()` at boot fails every RUNNING dive with "NEXUS restarted during this dive; nothing was published" and keeps its reservation.
  - `findingIds` must be the project's own; their source URLs are fetched first, counting toward `maxFetches`.
- **The loop.**
  - It never sees a blocked domain.
  - `fetch_page` refuses URLs that aren't https, are blocked, or are over the fetch limit, with a reason the model sees.
  - Search results are de-duplicated by canonical URL (`findings.ts` `canonicalUrl`).
  - Every step is logged.
- **Claim verification.**
  - Normalise both the quote and the snapshot text (NFKC, collapse whitespace, case-fold, unify quotes and dashes), then do an exact substring check.
  - Quotes must be 20–500 chars.
  - Labels follow the `ClaimLabel` rules, with tiers from `domainPolicy` and the publisher from `publisherOf`.
  - A contradiction counts only if each claim it names has verified evidence; those claims become CONTESTED.
  - The summary's URLs are filtered as described above.
- **Routes:**
  - `POST /v1/research/deep-dives` (Idempotency-Key required; 202 with the DeepDive)
  - `GET /v1/research/deep-dives`
  - `GET /v1/research/deep-dives/:id`
  - `POST /v1/research/deep-dives/:id/cancel`
  - If `ai.json` is missing: 409 with the runbook. If `search.json` is missing: 409 with the runbook, unless every source comes from `findingIds`, in which case the dive runs with search disabled and the model is told so.
- **Completion:** in one transaction, store the report, settle spend, call `recordOpportunity`, then `notifyDeepDive`. Also call `notifyResearchBrief` from `research/service.ts` when a run finishes with new findings.

Tests:
- RES-G06: budget; no model call when the reservation fails.
- RES-G07: each limit ends the loop with `stoppedBy` and still produces a report.
- RES-G08: fabricated quote, unfetched URL, PRIMARY, CORROBORATED and CONTESTED cases.
- RES-G09: an injection page tries to make the model fetch `https://169.254.169.254/` and claim an issue was created. The fetch is BLOCKED, nothing outside NEXUS changes, and the text stays labelled.
- RES-G10: idempotency, including two concurrent requests with the same key.
- RES-G11: emergency stop at create and mid-dive.
- Restart reconcile and the decoy project.
- Use a scripted fake `AiClient` (as in the explain/plans tests) and a fake search/page layer behind the pinned signatures.

## C: opportunities and the approved issue

Owns:
- `apps/api/src/research/opportunities/**`
- the new `apps/api/src/github/issues.ts`
- `cli/github-setup.ts` (permission `issues: "write"`)
- `docs/runbooks/github-setup.md`
- web `opportunities.tsx`, plus its zone and drawer wiring in `Board.tsx`

Deliverables:
- **Opportunity records.**
  - Table `research_opportunities`, with the evidence claims copied (immutable).
  - Ranking: confidence HIGH > MEDIUM > LOW, then the count of verified claims, then newest.
  - `agents`: AI_RESEARCHER, plus PRODUCT for OPPORTUNITY, DEVOPS for RISK, DEVELOPER for OPTIMIZE.
- **Routes:**
  - `GET /v1/research/opportunities`, `GET /v1/research/opportunities/:id`
  - `POST …/:id/dismiss` (audit)
  - `POST …/:id/issue-preview` → `IssuePreview`
  - `POST …/:id/issue` (Idempotency-Key)
- **Issue preview:**
  - The repository must be bound to the opportunity's project, and the project must be Dev mode.
  - The body is built by the server from the opportunity:
    - the problem;
    - evidence as quoted, labelled claims with their source URLs (verified ones only);
    - validation steps;
    - a footer: "Drafted by the NEXUS AI researcher from deep dive <id>. AI inference; review before acting."
    - a hidden marker `<!-- nexus:opportunity:<id> -->`.
  - `@` mentions are neutralised and links are limited to evidence URLs.
  - The hash covers `{opportunityId, repositoryId, title, body, labels}`. TTL is `PROPOSAL_TTL_MS`.
- **Create (R2):**
  - Requires a fresh preview with that exact hash, the AI researcher's `github.issues.create` tool, and that the emergency stop is not engaged.
  - The claim row `opportunity_issue_requests` (unique per opportunity) is written before the GitHub call.
  - On retry with a PENDING claim, first look for an open or closed issue with the marker, created by the app, and adopt it. Create a new issue only if none exists.
  - The opportunity status becomes ISSUE_CREATED with `issue` set only from GitHub's response.
  - A missing permission → 409 naming "Issues: read & write" and the runbook.
- **Web: Cofounder cards.**
  - The Noticed zone replaces the empty "Noticed for you" zone.
  - Each card shows:
    - the kind tag (Opportunity / Risk / Optimize, with text, not color alone);
    - the title and the impact with "est.";
    - the confidence label (a label, not a %, per the PRD: scores aren't probabilities);
    - one line of evidence and the agent chips;
    - Explain / Preview / Approve.
  - **Explain** opens the drawer on the evidence claims with their labels, quotes, sources and contradictions. It makes no model call.
  - **Preview** asks for a repo (bound repos only), then shows the "exactly what will happen" rows.
  - **Approve** sends the hash; "Created #n" links to GitHub only after the response.
  - **Dismiss.**
  - Honest empty states: "Nothing noticed yet: run a deep dive", and the "All" view is read-only.

Tests:
- RES-G12: approve twice, or crash after GitHub created the issue → exactly one issue.
- A stale or changed hash → 409.
- An unbound repo or a Business project → 403/409.
- Mention neutralising.
- `recordOpportunity` refuses a draft without verified evidence.
- Decoy project.
- Web: card states, keyboard flow, approve only after preview.

## D: researcher in the UI, Talk, plans and agents

Owns:
- web `research.tsx` and the new `deepDive.tsx`
- `Talk.tsx` and `plans.tsx` (replace the coordinator stubs)
- `apps/api/src/conversations/**`, `apps/api/src/plans/**`
- `apps/api/src/agents/service.ts` defaults and roster
- web `agents.tsx` if the new tools need labels

Deliverables:
- **AI researcher defaults:**
  - tools `research.search`, `research.run`, `research.deep_dive`, `github.issues.create`;
  - `maxCostUsdPerTask: 2`, `maxTurns: 30`;
  - description: "Searches the web and your watchlists, verifies every quoted claim against the page it read, and proposes opportunities with evidence."
  - The Chief of Staff keeps all tools.
- **Research drawer tabs:** Findings (existing) · Deep dives · Sources (mount `ResearchSources`).
  - **Start form:** question, depth with what each means (searches/fetches), cost cap prefilled with the profile cap, and "Investigate selected findings" from the Findings tab seeding `findingIds`.
  - **List and detail:**
    - live while RUNNING: TanStack Query `refetchInterval` 2 s, with steps streaming in;
    - Cancel;
    - report:
      - summary labelled AI inference;
      - claims with label chips and evidence quotes marked "✓ found on page" or "not found on page";
      - contradictions and open questions;
      - "Opportunity noticed →" opens `opp:<id>`.
  - The search-provider banner when it isn't configured.
- **Talk:**
  - The router may return `RESEARCH_DEEP_DIVE`; update the router prompt and tool list.
  - The reply is a proposal card (R1) whose server-built preview shows the question, depth, cap and "reads the public web; writes nothing outside NEXUS".
  - Approving it runs `createDeepDive` with the key `proposal:<id>`; the result is `{deepDiveId}`.
  - The web card's "Open the deep dive" opens the research drawer on it.
- **Plans:**
  - `research.deep_dive` steps are draftable (catalog + planner prompt) and blocked by the usual profile rules.
  - `fitBudget` caps `maxCostUsd` to the profile.
  - The executor creates the dive with the step key and succeeds only when the dive is COMPLETED, with the artifact `{ kind: "deep_dive", evidence: [DEEP_DIVE ref] }`. FAILED or CANCELLED fails the step.

Tests:
- Talk: proposal → approve → exactly one dive; deny; expired.
- Plan step success only on COMPLETED; restart-safe.
- Profile without the tool → blocked.
- Web: start form validation, live list, report rendering with both evidence states, cancel, a11y.

## Coordinator at merge

1. Merge A → B → C → D. Delete the adapters, register the new routes and the diver in `app.ts` (diver `reconcile()` at boot), and wire `recordOpportunity`.
2. Write one migration `0007_researcher.sql` with `pnpm --filter @nexus/api db:generate`. Append the triggers by hand: steps append-only.
3. Run every check (typecheck, lint, prettier, all tests, web build) and the secret scan.
4. Update `docs/p1-tracker.md` and the PRD feature status.

## Not in this wave (named)

- Scheduled deep dives.
- Embedding-based semantic dedupe and clustering. This needs an embedding provider; Anthropic has none.
- PDF and paper reading.
- Entity and topic memory (FR-MEM).
- Applying the ai_spend ledger to Explain, Triage, Talk and plan drafting. Same pattern; a follow-up.
- The Cofounder home's headline brief, KPI sparklines and docked or floating Cofounder panel (§D.4). This wave builds only its cards.
