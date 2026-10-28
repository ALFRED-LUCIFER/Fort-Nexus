// Shared by the ops scripts (nexus, backup, restore-drill, runner-service): paths, the env file, Compose.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dirname, "..");
// The git-ignored deployment env file (.env.example lists every setting). Variables already set in the shell win.
export const ENV_FILE = resolve(process.env.NEXUS_ENV_FILE || join(REPO, ".env"));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
/** Env-file paths don't go through a shell: expand `~/` here. */
export const expandHome = (p) => resolve(p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
// Where the owner's secrets live: github-app.json, ai.json, backup.key, runner-token.
export const NEXUS_HOME = expandHome(process.env.NEXUS_HOME || "~/.nexus");
export const COMPOSE_FILE = join(REPO, "infra/compose/docker-compose.yml");

/** True when `file` is not readable/writable by group or others. */
export const isPrivate = (file) => (statSync(file).mode & 0o077) === 0;

/** Runs `docker compose` for the home stack; COMPOSE_PROJECT_NAME selects another (e.g. disposable) stack. */
export function compose(args, options = {}) {
  return spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    stdio: "inherit",
    ...options,
    env: {
      ...process.env,
      NEXUS_ENV_FILE: ENV_FILE,
      NEXUS_HOME,
      // The API container runs as the host user so the mounted 0600 github-app.json is readable.
      NEXUS_UID: String(process.getuid()),
      NEXUS_GID: String(process.getgid()),
    },
  });
}

export function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}
