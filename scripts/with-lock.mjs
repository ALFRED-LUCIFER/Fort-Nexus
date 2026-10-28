// Serialises lockfile-touching commands (e.g. `pnpm add`) when several agents work in one tree.
// Usage: node scripts/with-lock.mjs pnpm --filter @nexus/api add some-pkg
import { mkdirSync, rmdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lock = join(tmpdir(), "nexus-pnpm.lock");
const deadline = Date.now() + 10 * 60_000;
for (;;) {
  try {
    mkdirSync(lock);
    break;
  } catch {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}
try {
  const [cmd, ...args] = process.argv.slice(2);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  process.exitCode = r.status ?? 1;
} finally {
  rmdirSync(lock);
}
