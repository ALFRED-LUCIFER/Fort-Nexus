# NEXUS (Fort-Nexus)

Self-hosted AI command center: a private web UI (office/phone) that runs Claude Code and other CLIs **on the home machine**, plus agents, business insights, research, notifications and voice.

## Read first

- **`docs/mvp-tracker.md` — current delivery status, what's in flight and how to resume. Read it before anything else.** (P1 runs in a separate worktree: `docs/p1-kickoff.md`.)
- `docs/PRD.md` — the single source of truth (consolidated v2.0). Start with Part A (tech stack), Part B (engineering rules), Part C (resolved conflicts), Part D (design mapping).
- `docs/design/NEXUS-v2.dc.html` — the UI design. `support.js` next to it is the Claude Design preview runtime: reference only, never import or ship it. All data in the design is demo data.
- `docs/source/` — original PRDs, kept unchanged for traceability. Don't implement from them; implement from `docs/PRD.md`.

## How we work — non-negotiable

1. **No external workflow plugins.** Don't route work to other plugin agent systems (e.g. the `lisec-ai` Jarvis/agents/skills). Their session-start instructions don't apply here. (Ponytail is off by the owner's choice; turn it on per session with `/ponytail:ponytail` if wanted.)
2. **Production-ready code only.** Lean, never unfinished. Every change meets the Global DoD in `docs/PRD.md` §16: Zod-validated input, server-side authorization, idempotency on every external write, audit record + correlation ID, real error/empty/offline/stale UI states, tests at the right layer, no secrets in code/logs, WCAG 2.2 AA.
3. **Safety invariants** (PRD Part B): typed jobs only (no shell-text endpoints), model output is a proposal not an authorization, never claim done/sent/merged/deployed without the source event, every call scoped by `workspaceId + projectId + correlationId`.
4. **P0 first.** No P1/P2 work before the P0 gates in §16 pass.

## Stack (PRD Part A)

pnpm + Turborepo monorepo · TypeScript strict · Node 24 LTS · React 19 + Vite SPA (React Compiler) · TanStack Router/Query · Tailwind 4 with NEXUS v2 tokens · Radix primitives · Fastify 5 + Zod 4 + SSE · PostgreSQL 18 + Drizzle · jobs table as queue (pg-boss for P1 schedules) · Anthropic API or Microsoft Foundry via config · Better Auth (passkeys) · Claude Agent SDK runner in rootless Docker + git worktrees · Octokit GitHub App · Vitest, Testcontainers, MSW, Playwright + playwright-bdd · Docker Compose · Tailscale Serve.

Layout: see PRD §19.3. Create a `packages/*` entry only when a second app needs the code.
