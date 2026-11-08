# Runbook: bootstrap the home host

PRD §18.1, in order, for this stack: Postgres + API (serving the web app) in Docker Compose on `127.0.0.1`, the runner and the daily backup as host services. Every command runs on the home machine from the repo root.

## 1. Host

- macOS or Linux, ≥ 8 GB RAM, ≥ 20 GB free disk (`df -h ~`), wired or stable network.
- Never sleep, come back after power loss:
  - macOS: `sudo pmset -a sleep 0 disksleep 0 autorestart 1`, Docker Desktop → Settings → General → **Start Docker Desktop when you sign in**. LaunchAgents start at login, so turn on automatic login (System Settings → Users & Groups; not possible with FileVault — then log in after each power cut).
  - Linux: `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`.
- Install: Node 24 (`nvm install 24`), pnpm (`corepack enable`), git, Docker (Docker Desktop on macOS; rootless Docker on Linux is preferred), Tailscale.

## 2. AI provider

Write `~/.nexus/ai.json` (mode `0600`) with your **personal** key: [ai-provider.md](ai-provider.md). Never paste keys into NEXUS chat.

The compose stack mounts the whole `~/.nexus` directory (`NEXUS_HOME`) read-only at `/run/nexus` and points `ai.json`, `search.json`, `voice.json`, `claude-cloud.json`, `github-app.json` and `connectors/` there. The API refuses a key file that is not mode `0600` or not owned by the user it runs as; a bind mount keeps the host owner, so `pnpm nexus` runs the container as your own uid/gid (`NEXUS_UID`/`NEXUS_GID`). Keep the files owned by the user who starts NEXUS. If you run `docker compose` yourself, export `NEXUS_UID=$(id -u) NEXUS_GID=$(id -g)` first, otherwise the files are rejected as "must be owned by the API user".

## 3. Isolation

Run NEXUS under a dedicated OS user if the machine is shared (e.g. a `nexus` account); everything below then happens as that user. Jobs already run in a fresh container each (FR-RUN-03).

## 4. Configuration and keys

```sh
git clone <repo> nexus && cd nexus && pnpm install --frozen-lockfile
cp .env.example .env && chmod 600 .env
openssl rand -base64 48   # → BETTER_AUTH_SECRET in .env
openssl rand -hex 24      # → POSTGRES_PASSWORD in .env (before the first `up`); update DATABASE_URL to match
pnpm --filter @nexus/api github:setup   # GitHub App → ~/.nexus/github-app.json (github-setup.md)
```

Set `PUBLIC_ORIGIN` to the URL you will open NEXUS at (step 7 changes it to the tailnet URL). The backup key is created by the first backup in step 6.

**Moving from another machine (the GitHub App already exists):** skip `github:setup`. Copy `~/.nexus/github-app.json` and `~/.nexus/ai.json` over a private channel (e.g. `scp`, never chat or email), then `chmod 700 ~/.nexus && chmod 600 ~/.nexus/*.json`. On GitHub → the NEXUS app → General, **add** this machine's callback URL (`<PUBLIC_ORIGIN>/api/auth/callback/github`, keep the old one until you retire it) and check Permissions has **Issues: Read & write** (accept it on the installation). Do **not** copy `runner-token`, `repos/` or `work/`: pair a new runner here (step 5) and revoke the old one in Settings → Security & devices. The database starts empty; to carry history over, restore a backup instead ([backup-restore.md](backup-restore.md) §3, same backup key).

## 5. Start NEXUS

```sh
node scripts/nexus.mjs up
```

It checks Node, Docker, `.env` and the `~/.nexus` files (each failure prints its fix), builds the job sandbox image, builds and starts the stack, applies database migrations, waits for the health checks and prints the next steps. `status`, `logs [service]` and `down` do the obvious; `down` never deletes the database volume. Stop any `pnpm dev` API first: both use port 8787.

Open `http://127.0.0.1:8787`, **Continue with GitHub**, then on the board **Pair a runner** and:

```sh
node --env-file-if-exists=.env.runner apps/runner/src/main.ts pair --code <CODE>
node scripts/runner-service.mjs install   # runner (login/boot, restart on failure) + daily backup at 03:30
node scripts/runner-service.mjs status
```

Runner settings go in the optional, git-ignored `.env.runner` (`NEXUS_API_URL`, `RUNNER_TOKEN_FILE`, `RUNNER_DATA_DIR`; defaults suit one host). Logs: `~/.nexus/logs/`. Re-run `install` after upgrading Node (it pins the `node` path).

## 6. Backup

Set `NEXUS_BACKUP_OFFSITE_DIR` in `.env`, then follow [backup-restore.md](backup-restore.md) §1–2: first backup, key off-host, restore drill passes.

## 7. Remote access

[remote-access.md](remote-access.md): Tailscale Serve, `PUBLIC_ORIGIN`, GitHub callback URL. Prove a device outside your tailnet gets nothing, and an unauthenticated browser gets only the sign-in page.

## 8. First real run (one test repository)

Install the GitHub App on **one test repository** only (github-setup.md §3). Pick a small issue → run → watch the live log → approve → a draft PR appears on GitHub.

## 9. Prove recovery and safety

| Check                       | How                                                                                                           | Expect                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| API restart mid-run         | `docker restart nexus-api-1`                                                                                  | run continues or is reconciled; no second PR                               |
| Runner killed mid-run       | `kill -9 $(pgrep -f "runner/src/main.ts start")`                                                              | service restarts in ~10 s; job → `RECOVERY_REQUIRED`, never re-run blindly |
| Host power loss             | pull the plug, boot, log in                                                                                   | stack + runner come back; `node scripts/nexus.mjs status` healthy          |
| Session revoke              | Settings → sessions → revoke the other browser                                                                | that browser is signed out                                                 |
| Budget                      | a run with a tiny budget                                                                                      | `budget_exceeded`, partial changes kept                                    |
| Unauthenticated API         | `curl -i http://127.0.0.1:8787/v1/jobs`                                                                       | `401`                                                                      |

## 10. Only then

Add more repositories to the installation, then read-only business data.

## Updating

```sh
git pull && pnpm install --frozen-lockfile
node scripts/nexus.mjs up                                    # rebuilds the API image and the sandbox image
launchctl kickstart -k gui/$(id -u)/com.nexus.runner         # macOS
systemctl --user restart nexus-runner                        # Linux
```
