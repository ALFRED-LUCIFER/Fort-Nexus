# Runbook: connect n8n (signed automation triggers)

n8n is glue, never a source of truth. It can call exactly one NEXUS endpoint, `POST /v1/automations/trigger`, with a **signed, typed** request for an action its automation client allows, inside that client's project (EPIC AUTO, AUTO-G01..G03). There is no shell-text field anywhere in this API: a request with an unknown field is refused (400) before anything runs. Emergency stop, the daily budget, project archiving and repository binding apply exactly as they do for the owner.

## 1. Run n8n without host access

Use an n8n you already run, or add it next to the NEXUS stack with a Compose override on the home machine (not checked in). The rules are the same either way:

- **No Docker socket.** Never mount `/var/run/docker.sock` or the host file system into n8n.
- **No command nodes.** Exclude Execute Command and SSH. n8n 2.x already disables Execute Command; keep the exclusion explicit anyway.
- **Private only.** Publish n8n on host loopback (reach it over Tailscale Serve like NEXUS), never on a LAN or public interface.
- **Persisted, encrypted credentials.** Set a fixed `N8N_ENCRYPTION_KEY` (`openssl rand -hex 32`) and keep the data volume in your backups.

```yaml
# infra/compose/docker-compose.n8n.yml (yours, not committed)
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:<pinned version>
    restart: unless-stopped
    ports:
      - "127.0.0.1:5678:5678"
    environment:
      N8N_ENCRYPTION_KEY: ${N8N_ENCRYPTION_KEY:?set it in .env}
      NODES_EXCLUDE: '["n8n-nodes-base.executeCommand","n8n-nodes-base.ssh"]'
      GENERIC_TIMEZONE: ${OWNER_TIMEZONE:-Asia/Dubai}
    volumes:
      - n8ndata:/home/node/.n8n
volumes:
  n8ndata:
```

Start it with `docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.n8n.yml up -d n8n`. From inside that Compose project the API is `http://api:8787`; from an n8n elsewhere on the machine it is `http://127.0.0.1:8787`.

## 2. Create an automation client in NEXUS

Settings → Automations, with the target project selected in SCOPE ("All" is read-only):

1. Name the client (e.g. `n8n morning brief`).
2. Allow only what the workflow needs: `research.run` (start a watchlist run) and/or `jobs.create` with the job types it may create.
3. Set triggers per minute (1–60; more get 429).
4. **Create client** shows the **client ID** and the **signing key** once. Copy both into n8n now: the key is never stored in NEXUS and is never shown again.

The key is `HKDF-SHA256(BETTER_AUTH_SECRET, salt = client ID, info = "nexus-automation-v<keyVersion>")`, 32 bytes, base64url. NEXUS derives it again for every request. Use the base64url **text** as the HMAC secret.

## 3. Sign every request

| Header | Value |
|---|---|
| `x-nexus-client` | the client ID |
| `x-nexus-timestamp` | Unix time in seconds; more than 300 s off the API's clock is refused |
| `x-nexus-signature` | `v1=` + hex(HMAC-SHA256(key, `<timestamp>.<raw body>`)) |
| `content-type` | `application/json` |

The signature covers the **exact bytes** sent. Build the body string once, sign that string, and send that same string. Re-serializing between signing and sending breaks the signature. The body is at most 64 KB.

```json
{ "idempotencyKey": "brief-2026-10-28", "action": { "type": "research.run", "watchlistId": "<uuid>" } }
```

```json
{
  "idempotencyKey": "diag-2026-10-28T08",
  "action": {
    "type": "jobs.create",
    "request": { "jobType": "RUNNER_DIAGNOSTIC", "preset": "node-version", "projectId": "<the client's project>" }
  }
}
```

### n8n workflow: Edit Fields → Crypto → HTTP Request

1. **Edit Fields (Set)** with two string fields:
   - `ts` = `{{ Math.floor(Date.now() / 1000) }}`
   - `body` = `{{ JSON.stringify({ idempotencyKey: "brief-" + $now.toFormat("yyyy-MM-dd"), action: { type: "research.run", watchlistId: "<uuid>" } }) }}`
2. **Crypto**:
   - Action: *Hmac*, Type: *SHA256*, Encoding: *HEX*
   - Value: `{{ $json.ts }}.{{ $json.body }}`
   - Secret: the signing key
   - Property name: `sig`
   - Keep the key out of exported workflows: put it in an n8n variable or environment variable and reference that here.
3. **HTTP Request**:
   - `POST http://api:8787/v1/automations/trigger`
   - Send Headers: `x-nexus-client` = client ID, `x-nexus-timestamp` = `{{ $json.ts }}`, `x-nexus-signature` = `v1={{ $json.sig }}`
   - Send Body: *Raw*, content type `application/json`, body `{{ $json.body }}`

Derive `idempotencyKey` from the business event (date, delivery ID), never from a random value. n8n then retries safely: the same key returns the first result and nothing runs twice. The same key with a different body is a 409.

Check the setup from a shell on the home machine:

```sh
BODY='{"idempotencyKey":"smoke-test-0001","action":{"type":"research.run","watchlistId":"<uuid>"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$NEXUS_AUTOMATION_KEY" -hex | sed 's/^.* //')
curl -sS http://127.0.0.1:8787/v1/automations/trigger -H 'content-type: application/json' \
  -H "x-nexus-client: $NEXUS_AUTOMATION_CLIENT" -H "x-nexus-timestamp: $TS" -H "x-nexus-signature: v1=$SIG" \
  --data-binary "$BODY"
```

## 4. Responses

| Status | Meaning | n8n should |
|---|---|---|
| 202 | `{ automationRunId, result: { kind: "job" \| "research_run", id } }`; also returned for a replay | continue |
| 400 | body isn't valid JSON or doesn't match the schema (unknown fields such as `shell` included) | fix the workflow; don't retry |
| 401 | unknown or disabled client, stale timestamp, or bad signature (one generic message; the reason is in the API log) | check clock, key and body bytes |
| 403 / 404 | action or job type not allowed, another project, or a watchlist outside the client's project | fix the client or the workflow |
| 409 | emergency stop, budget, archived project, or idempotency key reused with another body | retry later with the **same** key; a rejected key isn't used up |
| 429 | over the client's triggers per minute | back off, then retry |

Every authenticated trigger is listed under Settings → Automations → Recent triggers, with the reason when it was rejected, and is in the audit log as `automation:<client ID>`.

## 5. Rotate or revoke

- **Rotate** (Settings → Automations → Rotate → Confirm) bumps the key version. The old key stops verifying at once. Paste the new key into n8n.
- **Disable** stops a client immediately. Every request then gets 401. Enable restores the same key.
- **Rotating `BETTER_AUTH_SECRET` invalidates every automation key** (and every browser session). Rotate each client afterwards and update n8n.
- If you suspect n8n is compromised: disable its clients first, then rotate after it is rebuilt.

## 6. Licensing (FR-AUTO-09)

n8n's self-hosted edition is under the **Sustainable Use License** (fair-code, not OSI open source). Running it on your own machine for your own internal workflows is allowed. Check n8n's current license and commercial terms before you:

- let third parties use or edit workflows (e.g. clients or a team outside your business);
- white-label it;
- embed n8n in a product or offer it as a service.

Those need an n8n commercial or Embed license.
