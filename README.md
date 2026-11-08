# NEXUS

A private command center that runs on your home machine. It runs coding agents on GitHub issues and opens draft PRs. It also watches your products' business numbers and health, does research, sends notifications and handles voice. You reach it from a browser at the office or on your phone.

- How to run it locally and the current state: [`docs/handoff.md`](docs/handoff.md)
- The source of truth for scope and rules: [`docs/PRD.md`](docs/PRD.md)
- Setup runbooks: [`docs/runbooks/`](docs/runbooks/)

## Dev: where an issue runs

Every GitHub issue of a repository bound to a Dev project shows up in the repository drawer. From an issue you choose where the work happens:

| Where                                        | What it needs                                                                                                                                                                     | Result                                                                                                                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Home runner** (Start run)                  | `~/.nexus/ai.json` and a paired runner ([`docs/runbooks/ai-provider.md`](docs/runbooks/ai-provider.md))                                                                           | Runs in a sandbox on this machine. You approve the exact change before NEXUS pushes and opens a draft PR.                                                                                                                            |
| **Claude in the cloud** (Hand off to Claude) | A claude.ai Pro/Max/Team/Enterprise plan, the Claude GitHub App on the repository, one routine per repository with an API trigger, and `~/.nexus/claude-cloud.json` (mode `0600`) | NEXUS starts one Claude Code session on claude.ai with the exact text you approved. The session opens a draft PR on a `claude/…` branch as your GitHub user. Setup: [`docs/runbooks/claude-cloud.md`](docs/runbooks/claude-cloud.md) |

Cloud sessions use your claude.ai plan's usage, not an API key. The routine token is kept in a file, not an environment variable, so it stays out of logs and process listings. `NEXUS_CLAUDE_CLOUD_FILE` only changes where that file is.

## Business: watching several products

Each product you run (Project 1, Project 2, Project 3, …) is a separate **Business project**. A project has its own connections and its own numbers, and data from one project never shows up in another (PRD §1, NFR-CNV-05).

### 1. Turn Business on

**Settings → Workspaces → Business → Show Business: on.** On this machine it was switched off on 2026-11-04 (Dev-only mode). While it is off, the Business switch, zones and agents are hidden, but projects and records are kept.

### 2. Add one project per product

**Settings → Workspaces → Business → New project**: give it a name (`Store A`) and a slug (`store-a`). Archive a project to hide it without deleting its history.

The header's workspace switch moves between **All** (a read-only view across every project), **Dev** and **Business**. Pick a project to see only its numbers.

### 3. Attach what NEXUS should read for that project

| What you get                                                                | What it needs                                                                                                            | Where to set it up                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Orders, gross sales, failed payments, refunds and net revenue, top products | A **read-only** Postgres or Supabase role and a connection-string file at `~/.nexus/connectors/<ref>.json` (mode `0600`) | Business drawer → **Connectors**; [`docs/runbooks/business-connector.md`](docs/runbooks/business-connector.md) |
| Uptime, incidents and AI triage                                             | A public `https` health URL, optionally linked to the product's GitHub repository                                        | **Systems** zone → Monitored apps                                                                              |
| Scheduled reports and webhooks                                              | A local n8n instance                                                                                                     | [`docs/runbooks/n8n.md`](docs/runbooks/n8n.md)                                                                 |
| Explanations, KPI questions in plain words, Cofounder cards                 | `~/.nexus/ai.json` (mode `0600`)                                                                                         | [`docs/runbooks/ai-provider.md`](docs/runbooks/ai-provider.md)                                                 |

Rules that always apply:

- Credentials stay in files on the home machine. They never go into the NEXUS database, the browser, a prompt or a log.
- NEXUS reads through typed metric tools only. There is no generic SQL and nothing is written to your product.
- A **PROD** connector shows no numbers until its connection test passes. When a source is missing or failing, NEXUS says **no data** and why. It never shows a zero it didn't read.

### Not supported yet

| Wanted                                                                                                              | Status                                                   |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Connecting a product's own **REST/GraphQL API** (instead of its database)                                           | Planned: FR-CON-05 (P1), API adapter catalog. Not built. |
| **Customer feedback and support** (tickets, emails, chats, reviews) per product, with clustering into GitHub issues | Planned: FR-SUP-01..05 (P2). Not built.                  |
| Conversion funnel from analytics (sessions → carts → checkouts → orders)                                            | Planned: FR-BIZ-06 (P1). Not built.                      |

Each of these needs a spec first (`docs/specs/`). For every source it has to settle the read-only credential, which typed operations are allowed, and how personal data is masked.
