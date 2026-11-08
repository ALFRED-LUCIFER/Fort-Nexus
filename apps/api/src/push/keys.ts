import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import webpush from "web-push";
import { z } from "zod";

// The VAPID key pair that signs every push (RFC 8292). Browsers bind a subscription to the public key, so it must
// stay the same across restarts: generated once into ~/.nexus/push.json (0600) and read at startup.
// shortcut: like github-app.json, a 0600 file, not the OS keychain (PRD FR-SEC-03); moves to the vault with ENG-10.

export const PUSH_RUNBOOK = "docs/runbooks/push.md";

export const PushKeyFile = z.strictObject({
  // base64url, unpadded: a 65-byte uncompressed P-256 point and a 32-byte scalar.
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  // Who the push services may contact about this sender. Defaults to PUBLIC_ORIGIN when that is https.
  subject: z
    .string()
    .regex(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/)
    .optional(),
});
export type PushKeyFile = z.infer<typeof PushKeyFile>;

export type VapidKeys = { publicKey: string; privateKey: string; subject: string };
/** `keys` null = push unavailable; `problem` says why in owner-safe words (never the file's content). */
export type PushKeys = { keys: VapidKeys | null; problem: string | null };

const FALLBACK_SUBJECT = "mailto:owner@nexus.invalid";
const subjectFor = (f: PushKeyFile, publicOrigin: string) =>
  f.subject ?? (publicOrigin.startsWith("https:") ? publicOrigin : FALLBACK_SUBJECT);

function read(file: string, publicOrigin: string): VapidKeys {
  const st = statSync(file);
  if (!st.isFile()) throw new Error(`${file} is not a regular file (${PUSH_RUNBOOK})`);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0)
    throw new Error(`${file} must not be readable by group/others (chmod 600)`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON; delete it to generate new push keys (${PUSH_RUNBOOK})`);
  }
  const parsed = PushKeyFile.safeParse(raw);
  if (!parsed.success) {
    // Field names only: issue messages can quote the private key.
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ");
    throw new Error(
      `${file} is invalid (fields: ${fields}); delete it to generate new push keys (${PUSH_RUNBOOK})`,
    );
  }
  return { ...parsed.data, subject: subjectFor(parsed.data, publicOrigin) };
}

/**
 * Reads the key file, creating it on first start. A group/world-readable or malformed file stops the API (like
 * github-app.json). A missing file that can't be created (the Compose mount is read-only) leaves push unavailable,
 * with a problem the Settings tab shows; nothing else depends on it.
 */
export function loadOrCreatePushKeys(file: string, publicOrigin: string): PushKeys {
  try {
    return { keys: read(file, publicOrigin), problem: null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const generated = webpush.generateVAPIDKeys();
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // `wx`: never overwrite a file another process created meanwhile.
    writeFileSync(
      file,
      `${JSON.stringify({ publicKey: generated.publicKey, privateKey: generated.privateKey })}\n`,
      {
        mode: 0o600,
        flag: "wx",
      },
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { keys: read(file, publicOrigin), problem: null };
    return {
      keys: null,
      problem: `Push keys aren't set up: ${file} doesn't exist and the API couldn't create it (${code ?? "error"}). Start NEXUS with \`node scripts/nexus.mjs up\` (it creates the file), or see ${PUSH_RUNBOOK}.`,
    };
  }
  return { keys: read(file, publicOrigin), problem: null };
}
