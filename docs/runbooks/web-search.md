# Runbook: web search for the AI researcher

The AI researcher's deep dives search the web through the **Brave Search API**. NEXUS makes and audits these calls itself, using the key in `~/.nexus/search.json` on the home machine (owner decision 2026-11-03, `docs/specs/p1-wave-5-researcher.md`). Without the file, deep dives can still read the sources of findings you pick. They just can't search.

**Personal accounts only.** Use your own Brave Search API account and payment method, never an employer's (PRD §20 lesson 12).

## 1. Get a key

1. Sign in at `https://api-dashboard.search.brave.com/`.
2. Subscribe to a plan that includes **Web search**. Note its rate limit and monthly quota. NEXUS sends at most 1 request per second, but a deep dive makes up to 20 searches (depth THOROUGH).
3. Go to **API keys** and create a key for NEXUS.

## 2. Write `~/.nexus/search.json`

```json
{ "provider": "brave", "apiKey": "..." }
```

Lock the file down. The API refuses it otherwise:

```sh
mkdir -p ~/.nexus && chmod 700 ~/.nexus
$EDITOR ~/.nexus/search.json
chmod 600 ~/.nexus/search.json
```

- The file must be a regular file with mode `0600`, owned by the user the API runs as, and contain exactly these two fields.
- `NEXUS_SEARCH_FILE` points the API at another path.
- The file is read on every search, so you don't need a restart after creating or rotating it.

Check it in **Research → Sources**. The search-provider line shows **Brave Search: configured**, or the reason it isn't usable plus this runbook's path. The same check is at `GET /v1/research/search-provider`. Neither ever shows the key.

Failures answer 409:
- `search_provider_not_configured`: the file is missing. The message names the path to create.
- `search_provider_config_invalid`: bad JSON, unknown fields, the wrong mode or owner, or a directory.

Error messages never contain the file's content.

## 3. What NEXUS sends and keeps

- **Request:** `GET https://api.search.brave.com/res/v1/web/search?q=…&count=…`.
  - The key goes only in the `X-Subscription-Token` header, never in the URL or a log line.
  - Queries are capped at 400 characters and 50 words, and 20 results.
  - Each request has a 10 s timeout. Redirects aren't followed.
- **Results:** only `https` results are kept, and snippets are reduced to plain text.
  - Results from domains you **block** in Research → Sources are removed before the model sees them.
  - Results are untrusted data. The model gets them inside a fenced block that can't change its rules or approve anything.
- **Audit:** the dive's step log, stored in your database, shows each query and URL.
  - Audit records hold only ids, counts, cost and outcome, never query or page text.
- **Errors** reach the dive as owner-safe text:
  - **AUTH:** 401/403, or 422 with an invalid-token code. "Brave Search rejected NEXUS's key."
  - **RATE_LIMITED:** 429, for the rate limit or a used-up quota.
  - **UNAVAILABLE:** anything else.

## 4. Pages the researcher reads

Every page fetch (and its robots.txt and each redirect hop) follows the research fetch policy, FR-RES-12:
- `https` only;
- no credentials;
- `robots.txt` honoured;
- 1 request per second per host;
- a 10 s timeout and a 2 MB cap.

Each host is resolved once. If any address is private, loopback, link-local (including cloud metadata such as `169.254.169.254`), CGNAT, multicast or reserved, the fetch is refused as `BLOCKED_HOST`. Otherwise the connection goes to the vetted address, so a DNS rebind can't redirect it. Only HTML and plain text are read. Anything else, PDFs and feeds included, is skipped as `UNSUPPORTED_TYPE`.

## 5. Source tiers and blocked domains

In **Research → Sources** you set, per workspace, how much a domain counts:
- **PRIMARY:** the vendor's own docs and release notes.
- **SECONDARY:** established press.
- **COMMUNITY:** forums and blogs. This is the default for any domain without a rule.

You can also **block** a domain. A rule covers the domain and its subdomains, and the most specific rule wins: `blog.example.org` overrides `example.org`. Changes are audited.

## 6. Rotate or remove the key

1. Revoke the key in the Brave dashboard.
2. Put the new key in `~/.nexus/search.json`, keeping mode `0600`. No restart is needed.

Deleting the file turns web search off. Deep dives that need it then answer 409 with this runbook.
