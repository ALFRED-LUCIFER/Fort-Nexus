// Restore drill (FR-OPS-05, GATE-10, NFR-12): decrypts the newest backup (or --file) into a throwaway Postgres
// container with no network and no volume, checks it, and reports PASS/FAIL plus the measured restore time.
// Never touches the live stack or its data.   node scripts/restore-drill.mjs [--file <backup.nxbk>]
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { backupDir, decrypt, keyFile, listBackups, loadKey, unpack } from "./backup.mjs";

const IMAGE = "postgres:18-alpine"; // same as infra/compose/docker-compose.yml
const TABLES = ["jobs", "approvals", "audit_records"];
const RPO_MS = 26 * 3_600_000; // NFR-12: daily backups, with slack for the schedule

const docker = (args, options = {}) => {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 2 ** 31, ...options });
  if (r.status !== 0)
    throw new Error(`docker ${args[0]} failed: ${(r.stderr || r.error?.message || "").trim()}`);
  return typeof r.stdout === "string" ? r.stdout.trim() : r.stdout;
};

function newestBackup() {
  const dir = backupDir();
  const [newest] = listBackups(dir);
  if (!newest) throw new Error(`no backups in ${dir}; run node scripts/backup.mjs`);
  return join(dir, newest.name);
}

function drill(file) {
  const started = Date.now();
  const { createdAt, files, dump } = unpack(decrypt(loadKey(keyFile()).key, readFileSync(file)));
  console.log(
    `backup ${file}\n  created ${createdAt.toISOString()}, ${(dump.length / 1e6).toFixed(1)} MB dump`,
  );
  for (const [name, data] of Object.entries(files))
    try {
      JSON.parse(data.toString("utf8"));
    } catch {
      throw new Error(`${name} in the backup is not valid JSON`); // never echo the parser message: it quotes secrets
    }
  console.log(`  config files OK: ${Object.keys(files).join(", ") || "none"}`);

  const name = `nexus-restore-drill-${randomBytes(4).toString("hex")}`;
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--tmpfs",
    "/var/lib/postgresql",
    "-e",
    "POSTGRES_USER=nexus",
    "-e",
    `POSTGRES_PASSWORD=${randomBytes(16).toString("hex")}`,
    "-e",
    "POSTGRES_DB=nexus",
    IMAGE,
  ]);
  try {
    // The image's init phase runs a socket-only server; TCP on 127.0.0.1 answers only once the real server is up.
    const deadline = Date.now() + 60_000;
    while (spawnSync("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "nexus"]).status !== 0) {
      if (Date.now() > deadline) throw new Error("throwaway postgres did not become ready within 60 s");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    docker(
      [
        "exec",
        "-i",
        name,
        "pg_restore",
        "-U",
        "nexus",
        "-d",
        "nexus",
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--single-transaction",
      ],
      { input: dump },
    );
    const counts = docker([
      "exec",
      name,
      "psql",
      "-U",
      "nexus",
      "-d",
      "nexus",
      "-tA",
      "-c",
      `select ${TABLES.map((t) => `(select count(*) from ${t})`).join(", ")}`,
    ]).split("|");
    TABLES.forEach((t, i) => console.log(`  ${t}: ${counts[i]} rows`));
  } finally {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  }
  console.log(
    `✔ PASS: restored onto a fresh instance in ${((Date.now() - started) / 1000).toFixed(1)} s (RTO measure)`,
  );
  if (Date.now() - createdAt > RPO_MS)
    console.warn(`! newest backup is older than 24 h: the daily schedule is not running (RPO, NFR-12)`);
}

try {
  const { values } = parseArgs({ options: { file: { type: "string" } }, strict: true });
  drill(values.file ?? newestBackup());
} catch (err) {
  console.error(`✖ FAIL: ${err.message}`);
  process.exitCode = 1;
}
