import { readFile, stat } from "node:fs/promises";
import type { z } from "zod";
import { HttpError } from "./errors.ts";

/**
 * Reads a provider key file on the home machine (ai.json, search.json, voice.json): a regular file, mode 0600, owned
 * by the API user, strict JSON matching `schema`. Read on every call, so rotating a key needs no restart. Missing or
 * unusable → 409 naming the file and runbook; no message ever includes the file's content (it holds a key).
 */
export async function readSecretJson<T>(
  file: string,
  schema: z.ZodType<T>,
  o: {
    runbook: string;
    /** reason + owner-facing sentence for a missing file. */
    missing: { reason: string; message: string };
    invalidReason: string;
  },
): Promise<T> {
  const fail = (reason: string, message: string) =>
    new HttpError(409, "CONFLICT", message, { reason, file, runbook: o.runbook });
  const invalid = (why: string) =>
    fail(o.invalidReason, `${file} ${why}. See ${o.runbook} on the home machine.`);

  const st = await stat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw fail(o.missing.reason, o.missing.message);
    throw invalid(`could not be read (${err.code ?? "error"})`);
  });
  if (!st.isFile()) throw invalid("is not a regular file");
  if ((st.mode & 0o077) !== 0) throw invalid("must not be readable by group or others: run chmod 600");
  if (process.getuid && st.uid !== process.getuid()) throw invalid("must be owned by the API user");

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw invalid("is not valid JSON"); // JSON.parse messages quote the input: never pass them on
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw invalid(
      `is invalid (${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`).join("; ")})`,
    );
  return parsed.data;
}
