import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

const expandHome = (p: string) => resolve(p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const Env = z.object({
  NEXUS_API_URL: z
    .url({ protocol: /^https?$/ })
    .default("http://127.0.0.1:8787")
    // The runner token travels in every request, so plain http is only allowed on this machine.
    .refine((u) => {
      const { protocol, hostname } = new URL(u);
      return protocol === "https:" || LOOPBACK.includes(hostname);
    }, "NEXUS_API_URL must use https unless it points at loopback"),
  RUNNER_TOKEN_FILE: z.string().min(1).default("~/.nexus/runner-token").transform(expandHome),
  // Bare mirrors (repos/<owner>/<name>.git) and per-job worktrees (work/<jobId>) live here.
  RUNNER_DATA_DIR: z.string().min(1).default("~/.nexus").transform(expandHome),
  // "none" runs jobs on the host without isolation: dev/test escape hatch only.
  RUNNER_SANDBOX: z.enum(["docker", "none"]).default("docker"),
});
export type Config = z.infer<typeof Env>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Env.parse(env);

export async function readToken(file: string): Promise<string> {
  const token = (await readFile(file, "utf8")).trim();
  if (!token) throw new Error(`${file} is empty; run "pair" first`);
  return token;
}

// Write to a fresh 0600 temp file and rename, so the token never sits in a file with wider permissions.
export async function writeToken(file: string, token: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await rm(tmp, { force: true });
  await writeFile(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
}
