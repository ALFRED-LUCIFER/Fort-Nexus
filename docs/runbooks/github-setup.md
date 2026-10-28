# Runbook: GitHub App setup and sign-in

One GitHub App does two jobs for NEXUS:

- **Sign in with GitHub** through the app's OAuth client. Only the GitHub account that created the app can sign in, and GitHub's own two-factor authentication is NEXUS's MFA (FR-ACC-04). Turn 2FA on for that account.
- **Repository access** through the app's installations, on the repositories you choose (FR-GH-01).

## 1. Before you start

`.env` at the repo root has `DATABASE_URL`, `BETTER_AUTH_SECRET` and **`PUBLIC_ORIGIN` set to the URL you open NEXUS at** (see [Origins and callback URLs](#origins-and-callback-urls)). Setup bakes that origin into the app.

## 2. Create the app

```sh
pnpm --filter @nexus/api github:setup                              # app owned by your personal account
pnpm --filter @nexus/api github:setup --org acme --owner your-login # app owned by an organization
```

1. The command opens a local page (`http://127.0.0.1:<port>/`) that sends you to GitHub's "Create GitHub App" form with the NEXUS manifest filled in. If no browser opens, open the printed URL yourself.
2. Sign in to GitHub **as the account that will own NEXUS**, review the permissions and click **Create GitHub App**.
3. GitHub returns to the local page; the command saves the credentials to `GITHUB_APP_FILE` (default `~/.nexus/github-app.json`, mode `0600`, directory `0700`) and prints the next steps. It never prints secrets.

The command gives up after 10 minutes. It refuses to replace an existing file; `--force` replaces it (the old app stays on GitHub — delete it under Settings → Developer settings → GitHub Apps). With `--org`, GitHub reports the organization as the owner, so `--owner` names the person who may sign in.

Permissions requested (least privilege, PRD EPIC GH): metadata read, issues read, pull requests write, contents write, checks read, and the account permission email addresses read (for sign-in). The webhook is created **inactive**: GitHub can't reach the home host, so NEXUS polls first.

## 3. Install the app on your repositories

Open `<app URL>/installations/new` (printed by the command), pick **Only select repositories** and choose the ones NEXUS may work on. You can change this any time in the app's installation settings.

## 4. Sign in

Restart the API (`pnpm --filter @nexus/api dev` reloads on file changes, not on the app file), open NEXUS and click **Continue with GitHub**.

- "This GitHub account isn't the owner of this NEXUS" — you are signed in to GitHub as someone else. Switch accounts on github.com and try again. Every denied attempt is recorded as an `auth.denied` audit record with the GitHub login.
- The login page shows the setup command — the API found no app file at `GITHUB_APP_FILE`. Run step 2, then restart the API.
- The API refuses to start with "must not be readable by group/others" — run `chmod 600 ~/.nexus/github-app.json`.

## Origins and callback URLs

GitHub only redirects back to callback URLs registered on the app, and Better Auth only finishes a sign-in on the same origin that started it (its state cookie lives there). So **`PUBLIC_ORIGIN` must be the origin in your browser's address bar, and `<PUBLIC_ORIGIN>/api/auth/callback/github` must be one of the app's callback URLs.** Setup registers the one for the `PUBLIC_ORIGIN` it ran with.

- **Production build on the home machine** — the API serves the web app; `PUBLIC_ORIGIN=http://127.0.0.1:8787`.
- **Vite dev server (`:5173`)** — Vite proxies `/api/auth` and `/v1` to the API, so set `PUBLIC_ORIGIN=http://localhost:5173` while developing. Signing in at `:5173` while `PUBLIC_ORIGIN` points at `:8787` fails with `state_mismatch`.
- **Tailscale Serve** — set `PUBLIC_ORIGIN=https://<host>.<tailnet>.ts.net`, and add `https://<host>.<tailnet>.ts.net/api/auth/callback/github` under the app's **Callback URL** list (GitHub App settings → General; up to 10 URLs) if setup ran with a different origin.

Changing `PUBLIC_ORIGIN` later only needs the matching callback URL added in the app settings; no new app.

## Moving from the Spike 0 password owner

Password sign-in is gone. On the first GitHub sign-in, if the email GitHub reports for the account (its public email, otherwise its primary one) is verified and equals the old owner's email, Better Auth links GitHub to that user and its runners and jobs stay visible. Otherwise a new user is created; pair the runner again.
