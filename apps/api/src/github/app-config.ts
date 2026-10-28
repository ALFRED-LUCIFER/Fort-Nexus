import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// One GitHub App serves both "Sign in with GitHub" (its OAuth client) and repository access (its installations).
// `pnpm --filter @nexus/api github:setup` creates it via the manifest flow and writes this file (mode 0600).
// shortcut: credentials live in a 0600 file, not the OS keychain (PRD FR-SEC-03); move to the vault with ENG-10.
export const GithubAppConfig = z.object({
  appId: z.int().positive(),
  slug: z.string().min(1),
  htmlUrl: z.url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  privateKey: z.string().includes("PRIVATE KEY"),
  webhookSecret: z.string().min(16),
  // The GitHub account that created the app is the only account allowed to sign in (single-owner NEXUS).
  ownerGithubUserId: z.int().positive(),
  ownerGithubLogin: z.string().min(1),
});
export type GithubAppConfig = z.infer<typeof GithubAppConfig>;

export const defaultGithubAppFile = () => join(homedir(), ".nexus", "github-app.json");

/** Returns null when GitHub isn't set up yet; throws if the file exists but is unreadable, malformed or too permissive. */
export function loadGithubAppConfig(file: string): GithubAppConfig | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0)
    throw new Error(`${file} must not be readable by group/others (chmod 600)`);
  // Never echo parser/validation details: they can quote fragments of the secret file into logs.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON; re-run the GitHub setup with --force`);
  }
  const result = GithubAppConfig.safeParse(parsed);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`${file} is invalid (fields: ${fields}); re-run the GitHub setup with --force`);
  }
  return result.data;
}
