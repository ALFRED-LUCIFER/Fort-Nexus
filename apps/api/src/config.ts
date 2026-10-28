import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { RUNNER_LEASE_POLL_MS } from "@nexus/contracts";
import { defaultGithubAppFile } from "./github/app-config.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const isIanaZone = (tz: string) => {
  if (!/^[A-Za-z][A-Za-z_]*(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const origin = z.url({ protocol: /^https?$/ }).transform((u) => new URL(u).origin);

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // DEC-03: the API is reached through Tailscale Serve / a local proxy, never bound to a LAN interface.
  // In its container it must bind 0.0.0.0 (Compose publishes it on host loopback only): explicit flag + container marker.
  API_HOST: z.string().default("127.0.0.1"),
  API_BIND_ALL_IN_CONTAINER: z.enum(["0", "1"]).default("0"),
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
  // Reverse proxies in front of the API that append X-Forwarded-For (Tailscale Serve = 1). Only hops from loopback or
  // private addresses (the Compose gateway) are believed; 0 ignores the header. More than one is never needed at home.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(1),
  RUNNER_LEASE_POLL_MS: z.coerce.number().int().min(0).max(60_000).default(RUNNER_LEASE_POLL_MS),
  // The owner's day for the daily budget (FR-SEC-08). IANA names only: Postgres reads "+04:00" with the sign inverted.
  OWNER_TIMEZONE: z
    .string()
    .default("Asia/Dubai")
    .refine(isIanaZone, "OWNER_TIMEZONE must be an IANA time zone name, e.g. Asia/Dubai"),
  // `~/` is expanded here: env files don't go through a shell.
  GITHUB_APP_FILE: z
    .string()
    .min(1)
    .transform((p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p))
    .optional(),
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
  trustProxyHops: number;
  githubAppFile: string;
  ownerTimezone: string;
};

// Docker writes /.dockerenv, Podman /run/.containerenv.
const runsInContainer = () => existsSync("/.dockerenv") || existsSync("/run/.containerenv");

/** Parses env once at startup; throws with every problem listed so the process fails fast. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, inContainer = runsInContainer): Config {
  const parsed = Env.superRefine((e, ctx) => {
    const bindAll = e.API_BIND_ALL_IN_CONTAINER === "1";
    if (bindAll && !inContainer())
      ctx.addIssue({
        code: "custom",
        path: ["API_BIND_ALL_IN_CONTAINER"],
        message: "API_BIND_ALL_IN_CONTAINER=1 is only allowed inside a container",
      });
    if (!LOOPBACK.has(e.API_HOST) && !(bindAll && e.API_HOST === "0.0.0.0"))
      ctx.addIssue({
        code: "custom",
        path: ["API_HOST"],
        message: "API_HOST must be a loopback address (0.0.0.0 only with API_BIND_ALL_IN_CONTAINER=1)",
      });
  }).safeParse(env);
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
    trustProxyHops: e.TRUST_PROXY_HOPS,
    githubAppFile: e.GITHUB_APP_FILE ?? defaultGithubAppFile(),
    ownerTimezone: e.OWNER_TIMEZONE,
  };
}
