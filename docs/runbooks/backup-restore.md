# Runbook: encrypted backups and restore

FR-SEC-11, FR-OPS-05, NFR-12 (RPO 24 h), GATE-10.

**In a backup:** a `pg_dump` of the stack's database (jobs, run history, approvals, audit records, sessions, runners) and the top-level `~/.nexus/*.json` files (`github-app.json`, `ai.json`). **Never:** worktrees, repository mirrors, run directories, the runner token, the backup key.

**Format:** one `nexus-<UTC time>.nxbk` file, AES-256-GCM (authenticated: a modified or truncated file is rejected), key in `~/.nexus/backup.key` (32 random bytes, mode `0600`).

## 1. Set up

In `.env`:

```sh
NEXUS_BACKUP_DIR=~/.nexus/backups                     # default
NEXUS_BACKUP_OFFSITE_DIR="~/Library/Mobile Documents/com~apple~CloudDocs/nexus-backups"   # any synced/off-host folder
NEXUS_BACKUP_RETENTION_DAYS=14                        # default; applied to both folders
```

First backup (the stack must be up):

```sh
node scripts/backup.mjs
```

It creates `~/.nexus/backup.key` and prints a loud warning. **Copy the key off this machine now** (password manager entry "NEXUS backup key": `cat ~/.nexus/backup.key`). Backups are useless without it, and the key must never sit next to the off-host copies.

`node scripts/runner-service.mjs install` schedules the backup daily at 03:30 (launchd / systemd timer; a run missed while asleep happens on wake). Log: `~/.nexus/logs/backup.log`.

## 2. Restore drill (monthly, and after any change to this setup)

```sh
node scripts/restore-drill.mjs                        # newest backup in NEXUS_BACKUP_DIR
node scripts/restore-drill.mjs --file <off-host copy> # prove the off-host copy too
```

Decrypts the backup, checks the config files, restores the dump into a throwaway Postgres container (no network, no volume, removed afterwards), counts `jobs`, `approvals`, `audit_records` and prints `PASS` with the restore time (the RTO measure) or `FAIL` with the reason (exit code 1). It never touches the live stack. It warns if the newest backup is older than 24 h.

## 3. Real restore onto a fresh host

1. Bootstrap steps 1–4 ([bootstrap.md](bootstrap.md)) **without** `github:setup` (the app comes from the backup). `POSTGRES_PASSWORD` may be new; set it in `.env` before step 3.
2. Put the key back: `mkdir -m 700 -p ~/.nexus && $EDITOR ~/.nexus/backup.key && chmod 600 ~/.nexus/backup.key`.
3. Restore:

```sh
OUT=$(mktemp -d)
node scripts/backup.mjs extract <backup.nxbk> "$OUT"
cp "$OUT"/nexus-home/*.json ~/.nexus/ && chmod 600 ~/.nexus/*.json
dc() { docker compose --env-file .env -f infra/compose/docker-compose.yml "$@"; }
dc up -d --wait postgres
dc exec -T postgres pg_restore -U nexus -d nexus --no-owner --exit-on-error --single-transaction < "$OUT/nexus.dump"
# Nothing restored may stay trusted without re-authorization (OPS-G03): sign in again, pair the runner again.
dc exec -T postgres psql -U nexus -d nexus -c "delete from session; update runners set revoked_at = now() where revoked_at is null"
rm -rf "$OUT"
node scripts/nexus.mjs up
```

4. Sign in, pair the runner, `node scripts/runner-service.mjs install`, then check a past run and its approvals in the UI.

`pg_restore` needs an **empty** database: restore before the API's first start, or on an existing install `node scripts/nexus.mjs down` and remove the volume (`docker volume rm nexus_pgdata`) **only after the drill passed on the backup you are about to use**.

## Rotating the backup key

`mv ~/.nexus/backup.key ~/.nexus/backup.key.old && node scripts/backup.mjs` creates a new key; store it off-host. Keep the old key as long as backups made with it are within retention.
