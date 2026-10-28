// Usage: pnpm --filter @nexus/api owner:create --email you@example.com --name "Your Name"
// The password is read from stdin (hidden on a TTY), never from argv where it would land in shell history.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createAuth, createOwner } from "../auth.ts";
import { loadConfig } from "../config.ts";
import { createDb, runMigrations } from "../db/index.ts";

const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" } } });
const args = z
  .object({ email: z.email(), name: z.string().trim().min(1).max(64) })
  .safeParse({ email: values.email, name: values.name ?? "Owner" });
if (!args.success) {
  console.error(`Usage: owner:create --email <email> [--name <name>]\n${z.prettifyError(args.error)}`);
  process.exit(2);
}

const tty = process.stdin.isTTY === true;
// Swallow readline's echo so a typed password never appears on screen.
const silent = new Writable({ write: (_chunk, _enc, cb) => cb() });
const rl = createInterface({ input: process.stdin, output: silent, terminal: tty });
const lines = rl[Symbol.asyncIterator]();
const ask = async (prompt: string) => {
  process.stdout.write(prompt);
  const { value, done } = await lines.next();
  if (tty) process.stdout.write("\n");
  if (done) throw new Error("No password on stdin");
  return String(value);
};

const config = loadConfig();
const { pool, db } = createDb(config.databaseUrl);
try {
  const password = await ask("Password: ");
  if (tty && (await ask("Repeat password: ")) !== password) throw new Error("Passwords do not match");
  await runMigrations(db);
  const owner = await createOwner(createAuth(config, db), db, { ...args.data, password });
  console.log(`Owner created: ${owner.email} (${owner.id})`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  rl.close();
  await pool.end();
}
