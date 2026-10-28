# Runbook: connect a business database (read-only)

NEXUS reads business numbers (paid orders, gross sales, failed payments) from your own Postgres or Supabase database through **typed metric tools only**: fixed aggregate queries, no generic SQL, no raw rows. Every call runs in a `READ ONLY` transaction with the connector's statement timeout. The credential stays in a file on the home machine; it never enters the NEXUS database, the browser, a prompt or a log (FR-CON-03, FR-DATA-01).

## 1. Create a read-only role in the source database

Run this as an admin of the **source** database. Replace `shop` with each schema NEXUS may read; nothing else is granted.

```sql
create role nexus_readonly login password '<long random password>';
alter role nexus_readonly set default_transaction_read_only = on;
grant usage on schema shop to nexus_readonly;
grant select on all tables in schema shop to nexus_readonly;
alter default privileges in schema shop grant select on tables to nexus_readonly;
```

Never grant `insert`, `update`, `delete`, `truncate` or `create`, and never use a superuser or the table owner. The connection test fails `read_only` if the role holds any of those in an allowlisted schema.

Generate the password with `openssl rand -hex 24`.

**Supabase:** run the SQL above in the SQL editor of the project, then use the **session pooler** connection string (Project Settings → Database) with `nexus_readonly` as the user. Keep `sslmode=require`. Don't use the `service_role` key or the `postgres` user.

## 2. Write the credential file on the home machine

The file name is the connector's **credential reference** (lower-case letters, digits and `-`):

```sh
mkdir -p ~/.nexus/connectors && chmod 700 ~/.nexus/connectors
$EDITOR ~/.nexus/connectors/shop-prod.json
chmod 600 ~/.nexus/connectors/shop-prod.json
```

```json
{ "connectionString": "postgres://nexus_readonly:<password>@db.example.com:5432/shop?sslmode=require" }
```

The API refuses the file unless it is a regular file, mode `0600` and owned by the user running the API. Errors name the file and never show its content. Set `NEXUS_CONNECTORS_DIR` to use a different directory (default `~/.nexus/connectors`).

**Rotate or revoke:** write a new file (e.g. `shop-prod-2.json`), point the connector at it (`credentialRef`), run the test again, then delete the old file and `alter role nexus_readonly password '…'` or `drop role`. Changing the reference resets the connector to UNTESTED.

## 3. Register, define the metrics, test

In the board: **Business** zone → open the drawer → **Connectors**.

1. **Register**: name, provider (Postgres or Supabase), environment (DEV, STAGING or PROD), credential reference (`shop-prod`), allowlisted schemas (`shop`), statement timeout (default 5000 ms).
2. **Metric dictionary**: the reporting time zone (e.g. `Asia/Dubai`) and currency, which table holds orders (`shop.orders`) and its created-at, status and amount columns, whether amounts are minor units (cents) or major units, and which statuses count as paid. Optionally the payments table, its status and failure-reason columns, and which statuses count as failed. Tables must be in an allowlisted schema.
3. **Test**: checks the credential file, network, sign-in, read-only privileges, schema access and that every dictionary column exists and is readable. The result lists each check with a key-free message.

A **PROD** connector serves no numbers until a test passes, and goes back to UNTESTED when its credential, schemas or dictionary change. DEV and STAGING connectors serve numbers before a test, but a failed test blocks them too.

Use `timestamptz` for created-at columns. A plain `timestamp` column is read as UTC.

## 4. What the numbers mean

- A day is `[00:00, next 00:00)` in the reporting time zone. **Today** ends at the current time and is labelled **partial**. Compare uses the same local clock window on the previous day.
- **Gross sales** is the sum of paid orders' amounts, exact decimal. It isn't net revenue or profit: refunds, chargebacks and fees aren't subtracted.
- Every value comes with its source, dataset, window, status filter, formula and the newest record's timestamp.
- Failure reasons are masked in the database before they reach NEXUS (emails → `[email]`, runs of 6+ digits → `[number]`) and grouped into at most 20 rows.
- When a source is missing, disabled, failing, too slow or not defined, the board says **no data** with the reason. It never shows a zero it didn't read.

## 5. Troubleshooting

| Test check | Meaning | Fix |
|---|---|---|
| `credential` | File missing, wrong mode/owner, bad JSON | Step 2; `chmod 600`; check the JSON shape |
| `network` | Host unreachable or timed out | Host/port in the connection string, firewall, Tailscale |
| `auth` | Role or password rejected, or no such database | Re-check the role and password; rotate if unsure |
| `read_only` | The role can write or create in an allowlisted schema | Use a role with `select` only (step 1) |
| `schema_allowlist` | A schema doesn't exist or the role lacks `usage` | `grant usage on schema …` or fix the allowlist |
| `dictionary` | A dictionary column is missing or not readable | Fix the column name or `grant select` |

Each test and each metric call writes an audit record (connector, tool, environment, duration, outcome). Records never contain rows or the credential.
