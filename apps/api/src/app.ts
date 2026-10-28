import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, {
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
  type RouteHandlerMethod,
} from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { fromNodeHeaders } from "better-auth/node";
import { sql } from "drizzle-orm";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { AuthStatus, GITHUB_SETUP_COMMAND, type ApiError, type ErrorCode } from "@nexus/contracts";
import { createAuth, type Auth } from "./auth.ts";
import { businessRoutes } from "./business/routes.ts";
import type { Config } from "./config.ts";
import { conversationRoutes } from "./conversations/routes.ts";
import { createDb, runMigrations, type Db } from "./db/index.ts";
import { HttpError } from "./errors.ts";
import { loadGithubAppConfig } from "./github/app-config.ts";
import { createGithubCatalog, type GithubCatalog } from "./github/catalog.ts";
import { createExecutor, expireApprovals, type Executor } from "./issue-to-pr.ts";
import { reapExpiredLeases } from "./jobs.ts";
import { createHub, type Hub } from "./notify.ts";
import { researchRoutes } from "./research/routes.ts";
import { createResearch, type Research } from "./research/service.ts";
import { githubRoutes } from "./routes/github.ts";
import { ownerRoutes } from "./routes/owner.ts";
import { runnerRegisterRoute, runnerRoutes } from "./routes/runner.ts";

export type Deps = {
  config: Config;
  db: Db;
  auth: Auth;
  hub: Hub;
  shutdown: AbortSignal;
  /** null until the GitHub App is set up. */
  github: GithubCatalog | null;
  executor: Executor;
  research: Research;
};

const REAPER_INTERVAL_MS = 5_000;
const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));
const CODE_BY_STATUS: Record<number, ErrorCode> = {
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
};

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
) {
  const body: ApiError = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
    requestId: request.id,
  };
  return reply.code(status).type("application/json; charset=utf-8").send(body);
}

export async function buildApp(config: Config) {
  // Missing file = not set up yet (API runs, sign-in explains how); a malformed or world-readable one fails fast.
  const github = loadGithubAppConfig(config.githubAppFile);
  const app = Fastify({
    logger:
      config.logLevel === "silent"
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                'res.headers["set-cookie"]',
                "*.password",
                "*.token",
                "*.authorization",
                "*.cookie",
              ],
              censor: "[REDACTED]",
            },
            ...(config.env === "development" ? { transport: { target: "pino-pretty" } } : {}),
          },
    genReqId: () => randomUUID(),
    requestIdHeader: false, // never trust a client-supplied id as the correlation id
    trustProxy: "loopback", // Tailscale Serve / Vite proxy on the same host set X-Forwarded-For
    bodyLimit: 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const { pool, db } = createDb(config.databaseUrl);
  pool.on("error", (err) => app.log.error({ err }, "idle postgres client error"));
  let hub: Hub;
  try {
    await runMigrations(db);
    hub = await createHub(config.databaseUrl, app.log);
  } catch (err) {
    await pool.end();
    throw err;
  }
  const shutdown = new AbortController();
  const auth = createAuth(config, db, github);
  const catalog = github ? createGithubCatalog(github, app.log) : null;
  const executor = createExecutor(db, catalog, app.log);
  const research = createResearch(db, app.log, shutdown.signal);
  const deps: Deps = {
    config,
    db,
    auth,
    hub,
    shutdown: shutdown.signal,
    github: catalog,
    executor,
    research,
  };

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err))
      return sendError(
        reply,
        request,
        400,
        "VALIDATION_FAILED",
        "Request validation failed",
        err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      );
    if (err instanceof HttpError)
      return sendError(reply, request, err.statusCode, err.code, err.message, err.details);
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, "unhandled error");
      return sendError(reply, request, 500, "INTERNAL", "Internal server error");
    }
    return sendError(reply, request, status, CODE_BY_STATUS[status] ?? "VALIDATION_FAILED", err.message);
  });

  const https = config.publicOrigin.startsWith("https:");
  await app.register(helmet, {
    // Self-hosted SPA: everything is same-origin; Tailwind/React need inline style attributes only.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(https ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: https,
  });

  // shortcut: in-memory buckets reset on restart and are per process; fine for one API process at home.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, ctx) =>
      new HttpError(429, "RATE_LIMITED", `Too many requests; retry in ${ctx.after}`),
  });

  app.get("/v1/health", async () => {
    try {
      await db.execute(sql`select 1`);
    } catch {
      throw new HttpError(503, "INTERNAL", "Service unavailable");
    }
    return { status: "ok" as const };
  });

  app
    .withTypeProvider<ZodTypeProvider>()
    .get("/v1/auth/status", { schema: { response: { 200: AuthStatus } } }, async () => ({
      github: github ? { configured: true, ownerLogin: github.ownerGithubLogin } : { configured: false },
    }));

  // Better Auth owns /api/auth/*; the raw body is passed through untouched.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    const handler: RouteHandlerMethod = async (request, reply) => {
      if (!github && /^\/api\/auth\/(sign-in|callback)\//.test(request.url))
        throw new HttpError(
          503,
          "INTERNAL",
          `GitHub sign-in isn't set up. On the home machine run \`${GITHUB_SETUP_COMMAND}\`, then restart the API.`,
        );
      const headers = fromNodeHeaders(request.headers);
      headers.set("x-request-id", request.id); // correlation id for auth audit records
      const body =
        request.body instanceof Buffer && request.body.length > 0 ? new Uint8Array(request.body) : undefined;
      const res = await auth.handler(
        new Request(new URL(request.url, config.publicOrigin), {
          method: request.method,
          headers,
          body,
        }),
      );
      reply.code(res.status);
      res.headers.forEach((value, key) => {
        if (key !== "set-cookie" && key !== "content-length") reply.header(key, value);
      });
      const cookies = res.headers.getSetCookie();
      if (cookies.length > 0) reply.header("set-cookie", cookies);
      return reply.send(res.body ? Buffer.from(await res.arrayBuffer()) : null);
    };
    scope.get("/api/auth/*", handler);
    // Sign-in brute-force guard.
    scope.post("/api/auth/*", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, handler);
  });

  // GitHub routes share the owner scope, so its session hook guards them too.
  await app.register(async (scope) =>
    ownerRoutes(scope, deps)
      .then(() => githubRoutes(scope, deps))
      .then(() => businessRoutes(scope, deps))
      .then(() => conversationRoutes(scope, deps))
      .then(() => researchRoutes(scope, deps)),
  );
  await app.register(async (scope) => runnerRegisterRoute(scope, deps));
  await app.register(async (scope) => runnerRoutes(scope, deps));

  const hasWeb = existsSync(join(WEB_DIST, "index.html"));
  if (hasWeb) await app.register(fastifyStatic, { root: WEB_DIST });
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?", 1)[0]!;
    const isApi = path === "/v1" || path.startsWith("/v1/") || path.startsWith("/api/");
    if (hasWeb && request.method === "GET" && !isApi)
      return reply.header("cache-control", "no-cache").sendFile("index.html"); // SPA fallback
    return sendError(reply, request, 404, "NOT_FOUND", "Route not found");
  });

  let reaper: NodeJS.Timeout | undefined;
  const reap = () =>
    Promise.all([
      reapExpiredLeases(db).then((n) => {
        if (n > 0) app.log.warn({ count: n }, "expired leases moved to RECOVERY_REQUIRED");
      }),
      expireApprovals(db).then((n) => {
        if (n > 0) app.log.info({ count: n }, "pending approvals expired");
      }),
      research.tick(),
    ]).catch((err: unknown) => app.log.error({ err }, "reaper failed"));
  app.addHook("onReady", async () => {
    await reap();
    reaper = setInterval(reap, REAPER_INTERVAL_MS);
    // Approved pushes a crash interrupted; in the background so GitHub latency never blocks startup.
    executor
      .reconcile()
      .then((n) => {
        if (n > 0) app.log.warn({ count: n }, "reconciled interrupted approved pushes");
      })
      .catch((err: unknown) => app.log.error({ err }, "approval reconciliation failed"));
  });
  app.addHook("preClose", async () => {
    clearInterval(reaper);
    shutdown.abort(); // ends SSE streams and lease long-polls so close() doesn't wait on them
  });
  app.addHook("onClose", async () => {
    await research.close(); // in-flight runs record their outcome before the pool closes
    await hub.close();
    await pool.end();
  });

  return app;
}
