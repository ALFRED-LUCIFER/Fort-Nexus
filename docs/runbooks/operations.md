# Runbook: operations

Day-to-day commands and the PRD §18.2 playbooks for this stack. Run from the repo root on the home machine.

## Everyday

| Task                     | Command                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| Status                   | `node scripts/nexus.mjs status` · `node scripts/runner-service.mjs status`                                |
| Start / stop the stack   | `node scripts/nexus.mjs up` · `node scripts/nexus.mjs down` (database volume kept)                        |
| API / database logs      | `node scripts/nexus.mjs logs` · `node scripts/nexus.mjs logs postgres`                                    |
| Runner / backup logs     | `tail -f ~/.nexus/logs/runner.log` · `tail ~/.nexus/logs/backup.log`                                      |
| Restart the runner       | macOS `launchctl kickstart -k gui/$(id -u)/com.nexus.runner` · Linux `systemctl --user restart nexus-runner` |
| Stop the runner          | macOS `launchctl kill TERM gui/$(id -u)/com.nexus.runner` (stays down until kickstart) · Linux `systemctl --user stop nexus-runner` |
| Database shell           | `docker compose -f infra/compose/docker-compose.yml exec postgres psql -U nexus -d nexus`                  |
| Recent audit records     | in that shell: `select occurred_at, actor, action, resource_type, outcome from audit_records order by occurred_at desc limit 50;` |
| Backup now / drill       | `node scripts/backup.mjs` · `node scripts/restore-drill.mjs` ([backup-restore.md](backup-restore.md))     |

## Playbooks (PRD §18.2)

**Home host offline** — the board shows the runner offline; queued work waits.
Check power/network remotely (Tailscale admin console shows the machine's last seen). After it is back: `node scripts/nexus.mjs status`, `node scripts/runner-service.mjs status`. The API moves expired leases to `RECOVERY_REQUIRED` and reconciles interrupted approved pushes on start (`logs` shows "reconciled interrupted approved pushes"). Decide on each recovered job in the UI. *Don't* re-run jobs or re-approve pushes because they "look stuck".

**Claude not authenticated / rate-limited** — job fails with `ai_provider_not_configured`, `ai_provider_config_invalid` or a provider error.
Fix `~/.nexus/ai.json` ([ai-provider.md](ai-provider.md); read per job, no restart), check the provider console for limits, resubmit under budget. *Don't* loop retries.

**Disk nearly full** — `df -h ~ /var/lib/docker`, `du -sh ~/.nexus/work ~/.nexus/repos ~/.nexus/backups`, `docker system df`.
Stop the runner (above) so no new containers start, then `docker image prune` (dangling images only) and `docker builder prune`. Remove `~/.nexus/work/<jobId>` only for jobs that are finished in the UI. Lower `NEXUS_BACKUP_RETENTION_DAYS` if backups dominate. *Never* `docker volume prune`, `docker system prune --volumes`, or deleting `~/.nexus/work` wholesale.

**GitHub access revoked** — drawers say "NEXUS can't access … anymore"; pushes fail with 401/403.
NEXUS already suspends writes for that repository. Re-grant on GitHub (app installation → repository access). If the app's credentials are gone or leaked, see *Suspected token leak*. *Don't* add a PAT or other token as a fallback.

**Failed tests** — the run's verification shows failures; the approval says so.
Branch, logs and changes are kept; read them in the run drawer, then rerun or fix. *Don't* approve the PR as review-ready.

**Lost worker after branch push** — job in `RECOVERY_REQUIRED` after a crash during push.
Restarting the API reconciles against GitHub by the stable branch name and idempotency key (no second push or PR). Check the job and the PR on GitHub. *Don't* re-approve or push by hand.

**Suspected token leak** — rotate what leaked, then review `audit_records` (above) for the exposure window:

| Secret                    | Rotate                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Session secret            | new `BETTER_AUTH_SECRET` in `.env`, `node scripts/nexus.mjs up` (every session ends)                               |
| GitHub App                | app settings → generate a new private key and client secret, delete the old ones, update `~/.nexus/github-app.json`, `node scripts/nexus.mjs up` |
| AI key                    | revoke at the provider, new key in `~/.nexus/ai.json`                                                              |
| Runner token              | revoke the runner in the UI, pair again (bootstrap.md §5)                                                          |
| Backup key                | [backup-restore.md](backup-restore.md) "Rotating the backup key"                                                   |
| Postgres password         | `ALTER USER nexus PASSWORD '…'` in the database shell, update `POSTGRES_PASSWORD` + `DATABASE_URL` in `.env`, `node scripts/nexus.mjs up` |

*Don't* keep using a secret you suspect.

**Research source down / Supabase timeout / external monitor** — P1 features, not deployed yet.
