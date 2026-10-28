// Encrypted backup (FR-SEC-11, FR-OPS-05, NFR-12): pg_dump of the stack's database + ~/.nexus/*.json in one
// AES-256-GCM file, written to NEXUS_BACKUP_DIR and NEXUS_BACKUP_OFFSITE_DIR, pruned after N days.
//   node scripts/backup.mjs                      create a backup (scheduled daily by runner-service.mjs)
//   node scripts/backup.mjs extract <file> <dir> decrypt for a real restore (docs/runbooks/backup-restore.md)
// Never includes worktrees, repo mirrors or run directories: only top-level *.json files of NEXUS_HOME.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NEXUS_HOME, compose, expandHome, fail, isPrivate } from "./nexus-common.mjs";

const MAGIC = Buffer.from("NEXUSBK1"); // format v1: MAGIC | iv(12) | tag(16) | ciphertext
const NAME = /^nexus-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.nxbk$/;
const DAY_MS = 86_400_000;

export const keyFile = () => expandHome(process.env.NEXUS_BACKUP_KEY_FILE || join(NEXUS_HOME, "backup.key"));
export const backupDir = () => expandHome(process.env.NEXUS_BACKUP_DIR || join(NEXUS_HOME, "backups"));

/** Reads the 32-byte key; with `create`, generates it (0600) on first use. Refuses a group/world-readable key. */
export function loadKey(file, { create = false } = {}) {
  try {
    if (!isPrivate(file)) throw new Error(`${file} must not be readable by group/others: chmod 600 ${file}`);
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    if (key.length !== 32)
      throw new Error(`${file} is not a base64 32-byte key; restore it from your off-host copy`);
    return { key, created: false };
  } catch (err) {
    if (err.code !== "ENOENT" || !create) throw err;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  return { key, created: true };
}

export function encrypt(key, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decrypt(key, blob) {
  if (blob.length < 36 || !blob.subarray(0, 8).equals(MAGIC)) throw new Error("not a NEXUS backup file");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(8, 20)).setAAD(MAGIC);
  decipher.setAuthTag(blob.subarray(20, 36));
  try {
    return Buffer.concat([decipher.update(blob.subarray(36)), decipher.final()]);
  } catch {
    throw new Error("backup failed authentication: wrong key, or the file was modified or truncated");
  }
}

/** Plaintext layout: u32 manifest length | manifest JSON (config files, base64) | pg_dump custom-format bytes. */
export function pack(files, dump, createdAt = new Date()) {
  const manifest = Buffer.from(
    JSON.stringify({
      format: 1,
      createdAt: createdAt.toISOString(),
      files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, b.toString("base64")])),
    }),
  );
  const len = Buffer.alloc(4);
  len.writeUInt32BE(manifest.length);
  return Buffer.concat([len, manifest, dump]);
}

export function unpack(plain) {
  const len = plain.readUInt32BE(0);
  const manifest = JSON.parse(plain.subarray(4, 4 + len).toString("utf8"));
  if (manifest.format !== 1) throw new Error(`unsupported backup format ${manifest.format}`);
  const files = Object.fromEntries(
    Object.entries(manifest.files).map(([n, b]) => [n, Buffer.from(b, "base64")]),
  );
  return { createdAt: new Date(manifest.createdAt), files, dump: plain.subarray(4 + len) };
}

export const backupName = (date) => `nexus-${date.toISOString().replace(/[:.]/g, "-")}.nxbk`;
const dateOf = (name) => {
  const m = NAME.exec(name);
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null;
};

/** Backup files in `dir`, newest first. */
export function listBackups(dir) {
  return readdirSync(dir)
    .map((name) => ({ name, date: dateOf(name) }))
    .filter((b) => b.date)
    .sort((a, b) => b.date - a.date);
}

/** Deletes backups older than `days` (by the timestamp in the name; cloud sync can change mtimes). */
export function prune(dir, days, now = new Date()) {
  const removed = listBackups(dir).filter((b) => now - b.date > days * DAY_MS);
  for (const b of removed) rmSync(join(dir, b.name));
  return removed.map((b) => b.name);
}

function writePrivate(dir, name, data) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, join(dir, name));
}

function createBackup() {
  const days = Number(process.env.NEXUS_BACKUP_RETENTION_DAYS || 14);
  if (!Number.isInteger(days) || days < 1)
    fail("NEXUS_BACKUP_RETENTION_DAYS must be a whole number of days ≥ 1");
  const offsite = process.env.NEXUS_BACKUP_OFFSITE_DIR;
  const dirs = [backupDir(), ...(offsite ? [expandHome(offsite)] : [])];

  const { key, created } = loadKey(keyFile(), { create: true });
  if (created)
    console.warn(`
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!! New backup key: ${keyFile()}
!! Store a copy OFF this machine now (password manager). Without it no backup can be restored.
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
`);

  // shortcut: the dump is held in memory (fine for a home database of a few hundred MB); stream it once it grows past ~1 GB.
  const dump = compose(["exec", "-T", "postgres", "pg_dump", "-U", "nexus", "-d", "nexus", "-Fc"], {
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 2 ** 31,
  });
  if (dump.status !== 0 || dump.error)
    fail(
      `pg_dump failed (${dump.error?.message ?? `exit ${dump.status}`}); is the stack up? node scripts/nexus.mjs status`,
    );

  const files = {};
  for (const name of readdirSync(NEXUS_HOME).filter((n) => n.endsWith(".json")))
    if (statSync(join(NEXUS_HOME, name)).isFile()) files[name] = readFileSync(join(NEXUS_HOME, name));

  const now = new Date();
  const name = backupName(now);
  const blob = encrypt(key, pack(files, dump.stdout, now));
  for (const dir of dirs) {
    writePrivate(dir, name, blob);
    const removed = prune(dir, days, now);
    console.log(
      `✔ ${join(dir, name)} (${(blob.length / 1e6).toFixed(2)} MB; pruned ${removed.length} older than ${days} days)`,
    );
  }
  if (dirs.length < 2)
    console.warn(
      "! NEXUS_BACKUP_OFFSITE_DIR is not set: this backup is NOT off-host (GATE-10). See docs/runbooks/backup-restore.md",
    );
  console.log(`  config files: ${Object.keys(files).join(", ") || "none"}`);
}

function extract(file, out) {
  if (!file || !out) fail("usage: node scripts/backup.mjs extract <backup.nxbk> <output-dir>");
  const { createdAt, files, dump } = unpack(decrypt(loadKey(keyFile()).key, readFileSync(file)));
  mkdirSync(join(out, "nexus-home"), { recursive: true, mode: 0o700 });
  writeFileSync(join(out, "nexus.dump"), dump, { mode: 0o600 });
  for (const [name, data] of Object.entries(files))
    writeFileSync(join(out, "nexus-home", name), data, { mode: 0o600 });
  console.log(
    `✔ backup from ${createdAt.toISOString()} extracted to ${out} (contains secrets: delete it after the restore)`,
  );
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (!command) createBackup();
    else if (command === "extract") extract(args[0], args[1]);
    else fail("usage: node scripts/backup.mjs [extract <file> <dir>]");
  } catch (err) {
    fail(err.message);
  }
}
