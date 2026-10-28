# Runbook: AI provider for the coding engine

The runner's Claude coding engine (`apps/runner/src/claude.ts`) calls the model with the key in `~/.nexus/ai.json` on the home machine. Pick **one** provider (ADR-0003): the Anthropic API or Claude on Microsoft Foundry.

**Personal accounts only.** Use your own Anthropic Console account or a **personal** Azure subscription. Never an employer tenant, key or credit (PRD §20 lesson 12, SEC-G06).

## 1. Write `~/.nexus/ai.json`

Anthropic API (key from console.anthropic.com → API keys):

```json
{ "provider": "anthropic", "apiKey": "sk-ant-...", "model": "claude-opus-5-5" }
```

Microsoft Foundry (deploy a Claude model in your Foundry resource, copy the resource's API key). Give **either** the bare resource name **or** the base URL, not both:

```json
{ "provider": "foundry", "resource": "my-foundry-resource", "apiKey": "...", "model": "claude-opus-5-5" }
```

```json
{ "provider": "foundry", "baseUrl": "https://my-foundry-resource.services.ai.azure.com/anthropic", "apiKey": "..." }
```

`model` is optional (default `claude-opus-5-5`); on Foundry it must name a model you deployed. `baseUrl` must be `https` on the default port.

Lock the file down; the runner refuses it otherwise:

```sh
mkdir -p ~/.nexus && chmod 700 ~/.nexus
$EDITOR ~/.nexus/ai.json
chmod 600 ~/.nexus/ai.json
```

The runner fails a coding job with `ai_provider_not_configured` (file missing, with the path to create) or `ai_provider_config_invalid` (bad JSON, unknown fields, wrong mode or owner). Error messages never contain the file's content.

### Talk (the API) uses the same file

Talk's intent router (`apps/api/src/ai.ts`) reads the same `~/.nexus/ai.json` with the same checks, so the file must also be owned by the user the API runs as. `NEXUS_AI_FILE` points the API at another path. The file is read on every message: no restart after creating or rotating it. Until it exists, sending a message answers 409 and the Talk drawer explains what to create. Each message makes one Messages API call with the configured `model`.

## 2. What the job container gets

- Only what the Agent SDK needs: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_USE_FOUNDRY=1` + `ANTHROPIC_FOUNDRY_RESOURCE`/`ANTHROPIC_FOUNDRY_BASE_URL` + `ANTHROPIC_FOUNDRY_API_KEY`. The key is passed to `docker run` by name, so it never shows up in a process list. It is masked in every run event and log line.
- Network: only the provider host on port 443 (`api.anthropic.com`, or the Foundry resource host) through the job's egress proxy. No GitHub, no package registries, no telemetry. Refused targets are recorded as `tool.denied` events.
- If a run writes the key into the worktree, the job fails with `secret_leak_detected` and nothing may be pushed from it.

## 3. Cost

- Each run has hard limits: wall clock, turns and USD (`budget` in `runClaudeTask`). Hitting one stops the container and fails the job with `budget_exceeded`; changes made so far are kept for inspection.
- The cost shown on a run (`estimatedCostUsd`, `costBasis: "sdk_estimate"`) is the Agent SDK's list-price estimate, **not an invoice**. Check real spend in the Anthropic Console (Usage) or Azure Cost Management.
- On Foundry, Claude is billed through the Azure Marketplace at Anthropic's per-token rates. Set an Azure budget alert on the subscription.
- Anthropic: set a monthly spend limit in the Console (Settings → Limits) as a second ceiling.

## 4. Check it works (optional, costs a few cents)

```sh
pnpm --filter @nexus/runner sandbox:build
NEXUS_E2E_CLAUDE=1 pnpm --filter @nexus/runner exec vitest run src/claude.test.ts -t "real Claude run"
```

It asks Claude to create `HELLO.md` in a throwaway repo and checks the diff.

## 5. Rotate or remove the key

Revoke the key at the provider, put the new one in `~/.nexus/ai.json` (keep mode `0600`). No restart needed: the file is read at the start of every coding job. Deleting the file disables coding jobs.
