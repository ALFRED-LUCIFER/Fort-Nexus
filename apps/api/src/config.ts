import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { RUNNER_LEASE_POLL_MS } from "@nexus/contracts";
import { defaultGithubAppFile } from "./github/app-config.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const origin = z.url({ protocol: /^https?$/ }).transform((u) => new URL(u).origin);

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // shortcut: loopback is enforced, so a containerised API needs this relaxed with a published-port guard (Compose step).
  // DEC-03: the API is reached through Tailscale Serve / a local proxy, never bound to a LAN interface.
  API_HOST: z
    .string()
    .default("127.0.0.1")
    .refine((h) => LOOPBACK.has(h), "API_HOST must be a loopback address"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  PUBLIC_ORIGIN: origin.default("http://127.0.0.1:8787"),
  TRUSTED_ORIGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    )
    .pipe(z.array(origin)),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  RUNNER_LEASE_POLL_MS: z.coerce.number().int().min(0).max(60_000).default(RUNNER_LEASE_POLL_MS),
  // `~/` is expanded here: env files don't go through a shell.
  GITHUB_APP_FILE: z
    .string()
    .min(1)
    .transform((p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p))
    .optional(),
  // Business connector credentials: <dir>/<credentialRef>.json, mode 0600 (docs/runbooks/business-connector.md).
  NEXUS_CONNECTORS_DIR: z
    .string()
    .min(1)
    .transform((p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p))
    .default(join(homedir(), ".nexus", "connectors")),
  // Talk's model provider (ADR-0003); same file format as the runner's ~/.nexus/ai.json.
  NEXUS_AI_FILE: z
    .string()
    .min(1)
    .transform((p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p))
    .default(join(homedir(), ".nexus", "ai.json")),
});

export type Config = {
  env: "development" | "production" | "test";
  logLevel: z.infer<typeof Env>["LOG_LEVEL"];
  databaseUrl: string;
  host: string;
  port: number;
  publicOrigin: string;
  trustedOrigins: string[];
  authSecret: string;
  leasePollMs: number;
  githubAppFile: string;
  connectorsDir: string;
  aiFile: string;
};

/** Parses env once at startup; throws with every problem listed so the process fails fast. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  const e = parsed.data;
  const devOrigins = e.NODE_ENV === "production" ? [] : ["http://localhost:5173"];
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    host: e.API_HOST,
    port: e.API_PORT,
    publicOrigin: e.PUBLIC_ORIGIN,
    trustedOrigins: [...new Set([e.PUBLIC_ORIGIN, ...e.TRUSTED_ORIGINS, ...devOrigins])],
    authSecret: e.BETTER_AUTH_SECRET,
    leasePollMs: e.RUNNER_LEASE_POLL_MS,
    githubAppFile: e.GITHUB_APP_FILE ?? defaultGithubAppFile(),
    connectorsDir: e.NEXUS_CONNECTORS_DIR,
    aiFile: e.NEXUS_AI_FILE,
  };
}
