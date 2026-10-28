// node --test scripts/   (part of `pnpm test`)
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backupName, decrypt, encrypt, loadKey, pack, prune, unpack } from "./backup.mjs";
import { render } from "./runner-service.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "nexus-ops-"));

test("backup round-trips; tampering, truncation or a wrong key fail authentication", () => {
  const key = randomBytes(32);
  const dump = randomBytes(1000);
  const files = { "ai.json": Buffer.from('{"apiKey":"x"}') };
  const blob = encrypt(key, pack(files, dump, new Date("2026-10-28T03:30:00Z")));
  const out = unpack(decrypt(key, blob));
  assert.deepEqual(out.files, files);
  assert.ok(out.dump.equals(dump));
  assert.equal(out.createdAt.toISOString(), "2026-10-28T03:30:00.000Z");
  assert.ok(!blob.includes(Buffer.from("apiKey")), "plaintext must not appear in the file");

  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decrypt(key, tampered), /failed authentication/);
  assert.throws(() => decrypt(key, blob.subarray(0, blob.length - 10)), /failed authentication/);
  assert.throws(() => decrypt(randomBytes(32), blob), /failed authentication/);
  assert.throws(() => decrypt(key, Buffer.from("not a backup at all, really")), /not a NEXUS backup/);
});

test("backup key is created 0600 once, reused, and refused when group/world-readable", () => {
  const file = join(tmp(), "nexus", "backup.key");
  assert.throws(() => loadKey(file), { code: "ENOENT" }); // the drill never creates a key
  const first = loadKey(file, { create: true });
  assert.equal(first.created, true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const again = loadKey(file, { create: true });
  assert.equal(again.created, false);
  assert.ok(again.key.equals(first.key));
  chmodSync(file, 0o644);
  assert.throws(() => loadKey(file), /chmod 600/);
  chmodSync(file, 0o600);
  writeFileSync(file, "too-short\n");
  assert.throws(() => loadKey(file), /32-byte key/);
});

test("retention prunes only backups older than N days and leaves other files alone", () => {
  const dir = tmp();
  const now = new Date("2026-10-28T03:30:00Z");
  const day = 86_400_000;
  const names = [0, 13, 15, 40].map((d) => backupName(new Date(now - d * day)));
  for (const n of [...names, "notes.txt", "nexus-garbage.nxbk"]) writeFileSync(join(dir, n), "x");
  assert.deepEqual(prune(dir, 14, now).sort(), [names[2], names[3]].sort());
  assert.deepEqual(readdirSync(dir).sort(), [names[0], names[1], "nexus-garbage.nxbk", "notes.txt"].sort());
});

test("service templates render with every placeholder filled; plist values are XML-escaped", () => {
  const values = {
    NODE: "/usr/bin/node",
    REPO: "/srv/a&b",
    PATH: "/usr/bin:/bin",
    LOGS: "/home/u/.nexus/logs",
  };
  for (const unit of [
    "com.nexus.runner.plist",
    "com.nexus.backup.plist",
    "nexus-runner.service",
    "nexus-backup.service",
  ]) {
    const out = render(unit, values);
    assert.doesNotMatch(out, /\{\{/);
    if (unit.endsWith(".plist")) assert.match(out, /\/srv\/a&amp;b/);
  }
  assert.throws(() => render("nexus-runner.service", { NODE: "x" }), /no value/);
});
