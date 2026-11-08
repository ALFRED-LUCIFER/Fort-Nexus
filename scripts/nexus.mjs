// Home deployment in one command (FR-OPS-01): node scripts/nexus.mjs up | down | status | logs [service]
// Starts postgres + api (serving the web app) with Compose on 127.0.0.1; the runner is a host service (runner-service.mjs).
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV_FILE, NEXUS_HOME, compose, fail, isPrivate } from "./nexus-common.mjs";

const PORT = process.env.API_PORT || "8787";
const LOCAL_URL = `http://127.0.0.1:${PORT}`;
const ok = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;

function preflight() {
  const problems = [];
  const need = (cond, problem, fix) => cond || problems.push(`${problem}\n    fix: ${fix}`);

  need(
    Number(process.versions.node.split(".")[0]) >= 24,
    `Node ${process.versions.node} is too old`,
    "install Node 24 LTS (`nvm install 24`)",
  );
  need(
    ok("docker", ["info"]),
    "Docker is not running or not reachable",
    "start Docker Desktop (macOS) or `systemctl --user start docker` / `sudo systemctl start docker` (Linux)",
  );
  need(
    ok("docker", ["compose", "version"]),
    "Docker Compose v2 is missing",
    "install the docker compose plugin",
  );
  need(ok("pnpm", ["--version"]), "pnpm is missing", "`corepack enable`");

  if (!existsSync(ENV_FILE)) {
    need(false, `${ENV_FILE} not found`, `cp .env.example .env && chmod 600 .env, then fill it in`);
  } else {
    need(
      isPrivate(ENV_FILE),
      `${ENV_FILE} holds secrets but is group/world-readable`,
      `chmod 600 ${ENV_FILE}`,
    );
    need(
      (process.env.BETTER_AUTH_SECRET ?? "").length >= 32,
      "BETTER_AUTH_SECRET is missing or shorter than 32 characters",
      `set BETTER_AUTH_SECRET=$(openssl rand -base64 48) in ${ENV_FILE}`,
    );
  }

  const app = join(NEXUS_HOME, "github-app.json");
  if (!existsSync(app))
    need(false, `${app} not found (GitHub App not set up)`, "pnpm --filter @nexus/api github:setup");
  else need(isPrivate(app), `${app} is group/world-readable`, `chmod 600 ${app}`);

  const ai = join(NEXUS_HOME, "ai.json");
  if (!existsSync(ai))
    console.warn(
      `! ${ai} not found: every AI feature (Talk, plans, job drafts, Explain, Triage, deep dives, coding jobs) will fail until it exists (docs/runbooks/ai-provider.md)`,
    );
  else need(isPrivate(ai), `${ai} is group/world-readable`, `chmod 600 ${ai}`);

  // Phone push keys (docs/runbooks/push.md): the API container mounts ~/.nexus read-only, so they are made here.
  const push = join(NEXUS_HOME, "push.json");
  if (!existsSync(push) && problems.length === 0) {
    createPushKeys(push);
    console.log(`→ created ${push} (phone push keys, mode 0600)`);
  } else if (existsSync(push)) need(isPrivate(push), `${push} is group/world-readable`, `chmod 600 ${push}`);

  if (problems.length > 0) fail(`Not ready to start NEXUS:\n  - ${problems.join("\n  - ")}`);
}

/** A VAPID key pair (P-256) in web-push's format: base64url public point (65 bytes) and private scalar (32 bytes). */
function createPushKeys(file) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x, "base64url"),
    Buffer.from(pub.y, "base64url"),
  ]);
  mkdirSync(NEXUS_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ publicKey: point.toString("base64url"), privateKey: priv.d })}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}

async function health() {
  try {
    const res = await fetch(`${LOCAL_URL}/v1/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

const run = (label, result) => {
  if (result.status !== 0)
    fail(`${label} failed (exit ${result.status ?? result.signal}); see the output above`);
};

const [command = "", ...rest] = process.argv.slice(2);
switch (command) {
  case "up": {
    preflight();
    console.log("→ building the job sandbox image");
    run(
      "sandbox image build",
      spawnSync("pnpm", ["--filter", "@nexus/runner", "sandbox:build"], { stdio: "inherit" }),
    );
    console.log("→ starting postgres + api");
    run("docker compose up", compose(["up", "-d", "--build", "--wait", "--wait-timeout", "180"]));
    if (!(await health()))
      fail(`${LOCAL_URL}/v1/health is not healthy; check \`node scripts/nexus.mjs logs\``);
    const origin = process.env.PUBLIC_ORIGIN || LOCAL_URL;
    console.log(`
✔ NEXUS is up at ${LOCAL_URL} (healthy)

Next steps (docs/runbooks/bootstrap.md):
  1. Open ${origin} and Continue with GitHub.
  2. On the board click "Pair a runner", then on this machine:
       node --env-file-if-exists=.env.runner apps/runner/src/main.ts pair --code <CODE>
       node scripts/runner-service.mjs install
  3. Remote access: docs/runbooks/remote-access.md. Backups: docs/runbooks/backup-restore.md.`);
    break;
  }
  case "down":
    run("docker compose down", compose(["down"])); // never -v: the database volume stays
    break;
  case "status":
    compose(["ps"]);
    console.log(`api health: ${(await health()) ? "ok" : "DOWN"} (${LOCAL_URL}/v1/health)`);
    console.log("runner service: node scripts/runner-service.mjs status");
    break;
  case "logs":
    compose(["logs", "--tail", "200", "-f", ...(rest.length > 0 ? rest : ["api"])]);
    break;
  default:
    console.error("usage: node scripts/nexus.mjs up | down | status | logs [service]");
    process.exitCode = 2;
}
