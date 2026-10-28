// Host services (FR-OPS-02): the runner (starts at login/boot, restarts on failure) and the daily encrypted backup.
//   node scripts/runner-service.mjs install | uninstall | status
// macOS: LaunchAgents (launchctl). Linux: systemd user units. Templates: infra/services/. Logs: ~/.nexus/logs/.
// Runner settings come from the git-ignored .env.runner (optional; defaults suit one host), backup settings from .env.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { NEXUS_HOME, REPO, fail } from "./nexus-common.mjs";

const TEMPLATES = join(REPO, "infra/services");
const LOGS = join(NEXUS_HOME, "logs");
const MAC = {
  dir: join(homedir(), "Library/LaunchAgents"),
  units: ["com.nexus.runner.plist", "com.nexus.backup.plist"],
};
const LINUX = {
  dir: join(homedir(), ".config/systemd/user"),
  units: ["nexus-runner.service", "nexus-backup.service", "nexus-backup.timer"],
  enable: ["nexus-runner.service", "nexus-backup.timer"],
};

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Fills a template; plist values are XML-escaped. PATH is captured so launchd/systemd find docker, git and pnpm. */
export function render(unit, values) {
  const escape = unit.endsWith(".plist") ? xml : (s) => s;
  return readFileSync(join(TEMPLATES, unit), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (values[k] === undefined) throw new Error(`template ${unit}: no value for {{${k}}}`);
    return escape(values[k]);
  });
}

const sh = (cmd, args, quiet = false) =>
  spawnSync(cmd, args, { stdio: quiet ? "ignore" : "inherit" }).status === 0;
const must = (cmd, args) => sh(cmd, args) || fail(`\`${cmd} ${args.join(" ")}\` failed`);

function runnerTokenFile() {
  const envFile = join(REPO, ".env.runner");
  const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  const file = env.RUNNER_TOKEN_FILE ?? "~/.nexus/runner-token";
  return file.startsWith("~/") ? join(homedir(), file.slice(2)) : file;
}

function install(platform) {
  const token = runnerTokenFile();
  if (!existsSync(token))
    fail(
      `${token} not found: pair the runner first.\n  Board → "Pair a runner", then: node --env-file-if-exists=.env.runner apps/runner/src/main.ts pair --code <CODE>`,
    );
  mkdirSync(LOGS, { recursive: true, mode: 0o700 });
  mkdirSync(platform.dir, { recursive: true });
  const values = { NODE: process.execPath, REPO, PATH: process.env.PATH ?? "/usr/bin:/bin", LOGS };
  for (const unit of platform.units)
    writeFileSync(join(platform.dir, unit), render(unit, values), { mode: 0o644 });

  if (platform === MAC) {
    const domain = `gui/${process.getuid()}`;
    for (const unit of MAC.units) {
      const path = join(MAC.dir, unit);
      sh("launchctl", ["bootout", domain, path], true); // reinstall: unload the old copy first
      must("launchctl", ["bootstrap", domain, path]);
    }
  } else {
    must("systemctl", ["--user", "daemon-reload"]);
    must("systemctl", ["--user", "enable", "--now", ...LINUX.enable]);
    console.log("For start at boot without logging in: sudo loginctl enable-linger $USER");
  }
  console.log(`✔ runner service + daily backup (03:30) installed; logs in ${LOGS}`);
}

function uninstall(platform) {
  if (platform === MAC)
    for (const unit of MAC.units)
      sh("launchctl", ["bootout", `gui/${process.getuid()}`, join(MAC.dir, unit)], true);
  else sh("systemctl", ["--user", "disable", "--now", ...LINUX.enable], true);
  for (const unit of platform.units) rmSync(join(platform.dir, unit), { force: true });
  if (platform === LINUX) sh("systemctl", ["--user", "daemon-reload"], true);
  console.log("✔ runner service and backup schedule removed (data and logs kept)");
}

function status(platform) {
  if (platform === MAC)
    for (const unit of MAC.units) {
      const label = unit.replace(/\.plist$/, "");
      const r = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], { encoding: "utf8" });
      const lines =
        r.status === 0 ? r.stdout.split("\n").filter((l) => /^\s*(state|pid|last exit code) =/.test(l)) : [];
      console.log(`${label}: ${lines.length > 0 ? lines.map((l) => l.trim()).join(", ") : "not installed"}`);
    }
  else sh("systemctl", ["--user", "status", "--no-pager", ...LINUX.enable]);
  console.log(`logs: ${join(LOGS, "runner.log")}, ${join(LOGS, "backup.log")}`);
}

if (import.meta.main) {
  const platform = process.platform === "darwin" ? MAC : process.platform === "linux" ? LINUX : null;
  if (!platform) fail(`unsupported platform ${process.platform}: use macOS (launchd) or Linux (systemd)`);
  const command = process.argv[2];
  if (command === "install") install(platform);
  else if (command === "uninstall") uninstall(platform);
  else if (command === "status") status(platform);
  else fail("usage: node scripts/runner-service.mjs install | uninstall | status");
}
