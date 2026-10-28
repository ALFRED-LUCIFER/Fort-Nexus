// Creates the NEXUS GitHub App with GitHub's App Manifest flow and saves its credentials to GITHUB_APP_FILE (0600).
// Usage: pnpm --filter @nexus/api github:setup [--org <org> --owner <your-github-login>] [--force]
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../config.ts";
import { GithubAppConfig } from "../github/app-config.ts";

const TIMEOUT_MS = 10 * 60_000;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "nexus-github-setup",
};

/** GitHub App names are globally unique and at most 34 characters. */
export function appName(host = hostname()) {
  const short =
    host
      .split(".")[0]!
      .replace(/[^A-Za-z0-9-]/g, "")
      .slice(0, 20) || "home";
  return `NEXUS ${short} ${randomBytes(3).toString("hex")}`;
}

export function buildManifest(publicOrigin: string, redirectUrl: string, name = appName()) {
  return {
    name,
    url: publicOrigin,
    redirect_url: redirectUrl,
    callback_urls: [`${publicOrigin}/api/auth/callback/github`],
    public: false,
    // shortcut: webhook inactive because GitHub can't reach the home host; NEXUS polls first. Activate it with a relay for FR-GH-10.
    hook_attributes: { url: `${publicOrigin}/v1/webhooks/github`, active: false },
    // Least privilege (PRD EPIC GH): browse repos/issues, push branches, open PRs, read CI; email for sign-in.
    default_permissions: {
      metadata: "read",
      issues: "read",
      pull_requests: "write",
      contents: "write",
      checks: "read",
      email_addresses: "read",
    },
  };
}

const GithubAccount = z.object({ id: z.int().positive(), login: z.string().min(1), type: z.string() });
const Conversion = z.object({
  id: z.int().positive(),
  slug: z.string().min(1),
  html_url: z.url(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  pem: z.string().min(1),
  webhook_secret: z.string().nullish(),
  owner: GithubAccount,
});

async function githubJson<T>(url: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: GITHUB_HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${new URL(url).pathname}`);
  const parsed = schema.safeParse(await res.json());
  // Report only the field paths: the body holds the app's secrets.
  if (!parsed.success)
    throw new Error(
      `Unexpected GitHub response (${parsed.error.issues.map((i) => i.path.join(".")).join(", ")})`,
    );
  return parsed.data;
}

/**
 * Exchanges the one-time manifest code for the new app's credentials. `ownerLogin` names the person who may sign
 * in when the app belongs to an organization (GitHub then reports the org as the owner).
 */
export async function convertManifest(code: string, ownerLogin?: string): Promise<GithubAppConfig> {
  const app = await githubJson(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    Conversion,
    { method: "POST" },
  );
  const owner = ownerLogin
    ? await githubJson(`https://api.github.com/users/${encodeURIComponent(ownerLogin)}`, GithubAccount)
    : app.owner;
  if (owner.type !== "User")
    throw new Error(
      `The app belongs to ${owner.login} (${owner.type}); re-run with --owner <your-github-login>`,
    );
  return GithubAppConfig.parse({
    appId: app.id,
    slug: app.slug,
    htmlUrl: app.html_url,
    clientId: app.client_id,
    clientSecret: app.client_secret,
    privateKey: app.pem,
    webhookSecret: app.webhook_secret || randomBytes(32).toString("base64url"),
    ownerGithubUserId: owner.id,
    ownerGithubLogin: owner.login,
  });
}

/** Atomic write, mode 0600 (dir 0700). Without `force` an existing file is never replaced. */
export function writeAppConfig(file: string, config: GithubAppConfig, force = false) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    if (force) renameSync(tmp, file);
    else linkSync(tmp, file); // EEXIST instead of silently replacing
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`${file} already exists; re-run with --force to replace it`);
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
  `<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">${body}</body></html>`;

function safeEqual(a: string | null, b: string) {
  return a !== null && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export type SetupOptions = {
  file: string;
  publicOrigin: string;
  force?: boolean;
  org?: string;
  owner?: string;
  timeoutMs?: number;
};

/**
 * Serves the manifest form on 127.0.0.1 (random port) and waits for GitHub's redirect back. `result` settles
 * once: with the saved config, or with the error (bad conversion, write failure, timeout). The server always stops.
 */
export async function startSetup(opts: SetupOptions) {
  const state = randomBytes(24).toString("base64url");
  let settle!: { resolve: (c: GithubAppConfig) => void; reject: (e: unknown) => void };
  const result = new Promise<GithubAppConfig>((resolve, reject) => (settle = { resolve, reject }));
  let handled = false;

  const server = createServer((req, res) => {
    const send = (status: number, title: string, body: string, then?: () => void) => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end(page(title, body), then);
    };
    // Only the address we printed: a DNS-rebinding page must not read the state or drive the callback.
    if (req.headers.host !== host || req.method !== "GET")
      return send(400, "Bad request", "<p>Bad request.</p>");
    const url = new URL(req.url ?? "/", base);
    if (url.pathname === "/") {
      const target = opts.org
        ? `https://github.com/organizations/${encodeURIComponent(opts.org)}/settings/apps/new`
        : "https://github.com/settings/apps/new";
      const manifest = JSON.stringify(buildManifest(opts.publicOrigin, `${base}/callback`));
      return send(
        200,
        "Create the NEXUS GitHub App",
        `<h1>Create the NEXUS GitHub App</h1><p>Sending you to GitHub to review and create the app…</p>` +
          `<form method="post" action="${escapeHtml(`${target}?state=${state}`)}">` +
          `<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">` +
          `<button type="submit">Continue to GitHub</button></form>` +
          `<script>document.forms[0].submit()</script>`,
      );
    }
    if (url.pathname !== "/callback") return send(404, "Not found", "<p>Not found.</p>");
    if (!safeEqual(url.searchParams.get("state"), state))
      return send(
        400,
        "State mismatch",
        "<p>This link doesn't belong to the running setup. Start it again.</p>",
      );
    const code = url.searchParams.get("code");
    if (!code) return send(400, "Missing code", "<p>GitHub didn't send a code. Start the setup again.</p>");
    if (handled) return send(409, "Already done", "<p>Setup already finished. Check the terminal.</p>");
    handled = true;
    convertManifest(code, opts.owner)
      .then((config) => {
        writeAppConfig(opts.file, config, opts.force);
        send(
          200,
          "NEXUS GitHub App created",
          "<p>Done. Return to the terminal for the next steps.</p>",
          stop,
        );
        settle.resolve(config);
      })
      .catch((err: unknown) => {
        send(500, "Setup failed", "<p>Setup failed. The terminal shows why.</p>", stop);
        settle.reject(err);
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as { port: number };
  const host = `127.0.0.1:${port}`;
  const base = `http://${host}`;
  const timer = setTimeout(() => {
    settle.reject(new Error("Timed out after 10 minutes without GitHub's redirect; run setup again."));
    stop();
  }, opts.timeoutMs ?? TIMEOUT_MS);
  function stop() {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
  return { url: `${base}/`, result };
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(cmd, args, () => undefined); // best effort: the URL is printed too
}

async function main() {
  const { values } = parseArgs({
    options: {
      org: { type: "string" },
      owner: { type: "string" },
      force: { type: "boolean", default: false },
    },
    strict: true,
  });
  for (const v of [values.org, values.owner])
    if (v !== undefined && !GITHUB_LOGIN.test(v)) throw new Error(`Not a GitHub login: ${v}`);
  if (values.org && !values.owner)
    throw new Error("--org needs --owner <your-github-login>: the only account allowed to sign in");

  const config = loadConfig();
  const file = config.githubAppFile;
  if (!values.force && existsSync(file))
    throw new Error(
      `${file} already exists; re-run with --force to replace it (the old app stays on GitHub)`,
    );

  const { url, result } = await startSetup({ ...values, file, publicOrigin: config.publicOrigin });
  console.log(`Opening ${url} to create the GitHub App (open it yourself if no browser appears)…`);
  openBrowser(url);
  const app = await result.catch((err: unknown) => {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n` +
        "If GitHub already created the app, delete it under Settings → Developer settings → GitHub Apps and run setup again.",
    );
  });
  console.log(
    [
      "",
      `GitHub App "${app.slug}" created; credentials saved to ${file} (mode 600).`,
      "Next:",
      `  1. Install it on the repositories NEXUS may use: ${app.htmlUrl}/installations/new`,
      `  2. Restart the API, then sign in with GitHub as @${app.ownerGithubLogin}.`,
    ].join("\n"),
  );
}

if (import.meta.main)
  await main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
