import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const CONNECTOR_RUNBOOK = "docs/runbooks/business-connector.md";

const CredentialFile = z.strictObject({ connectionString: z.url({ protocol: /^postgres(ql)?$/ }) });

/** Raised with a message that names the file and never its content (it holds the password). */
export class CredentialError extends Error {}

// shortcut: credentials live in a 0600 file, not the OS keychain (PRD FR-SEC-03); move to the vault with ENG-10.
/** Reads `<dir>/<ref>.json` with the same checks as the runner's ai.json: regular file, mode 0600, owned by us. */
export async function loadConnectionString(dir: string, ref: string): Promise<string> {
  const file = join(dir, `${ref}.json`);
  const invalid = (why: string) => new CredentialError(`${file} ${why} (see ${CONNECTOR_RUNBOOK})`);
  const st = await stat(file).catch((err: NodeJS.ErrnoException) => {
    throw err.code === "ENOENT"
      ? invalid("does not exist: create it with mode 0600")
      : invalid(`could not be read (${err.code ?? "error"})`);
  });
  if (!st.isFile()) throw invalid("is not a regular file");
  if ((st.mode & 0o077) !== 0) throw invalid("must not be readable by group or others: run chmod 600");
  if (process.getuid && st.uid !== process.getuid())
    throw invalid("must be owned by the user running the API");

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw invalid("is not valid JSON"); // JSON.parse messages quote the input: never pass them on
  }
  const parsed = CredentialFile.safeParse(raw);
  if (!parsed.success)
    throw invalid('is invalid: it must be {"connectionString": "postgres://…"} and nothing else');
  return parsed.data.connectionString;
}
