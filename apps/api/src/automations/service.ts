import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  AUTOMATION_CLIENT_HEADER,
  AUTOMATION_MAX_SKEW_SECONDS,
  AUTOMATION_SIGNATURE_HEADER,
  AUTOMATION_TIMESTAMP_HEADER,
  TriggerRequest,
  type AutomationClient,
  type AutomationClientSecret,
  type AutomationRun,
  type CreateAutomationClientRequest,
  type TriggerResponse,
  type UpdateAutomationClientRequest,
} from "@nexus/contracts";
import type { Deps } from "../app.ts";
import { audit } from "../audit.ts";
import type { Db } from "../db/index.ts";
import { HttpError, notFound } from "../errors.ts";
import { canonical, createJob, ownerActor, sha256 } from "../jobs.ts";
import { requireGithub } from "../routes/github.ts";
import { assertNotStopped } from "../system.ts";
import { ownerWorkspaceIds, resolveProject } from "../workspaces.ts";
import { createManualRun, getWatchlist } from "../research/service.ts";
import { automationClients, automationRuns } from "./schema.ts";

type ClientRow = typeof automationClients.$inferSelect;
type RunRow = typeof automationRuns.$inferSelect;
type OwnerCtx = { ownerId: string; correlationId: string };

const RUN_LIST_LIMIT = 50;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** HKDF-SHA256(BETTER_AUTH_SECRET, salt = client id, info = version); the base64url text is the HMAC secret. */
export const signingKey = (authSecret: string, c: Pick<ClientRow, "id" | "keyVersion">) =>
  Buffer.from(hkdfSync("sha256", authSecret, c.id, `nexus-automation-v${c.keyVersion}`, 32)).toString(
    "base64url",
  );

const toClientDto = (c: ClientRow): AutomationClient => ({
  id: c.id,
  projectId: c.projectId,
  name: c.name,
  allowedActions: c.allowedActions,
  allowedJobTypes: c.allowedJobTypes,
  rateLimitPerMinute: c.rateLimitPerMinute,
  disabled: c.disabled,
  keyVersion: c.keyVersion,
  lastUsedAt: iso(c.lastUsedAt),
  createdAt: c.createdAt.toISOString(),
});

const toRunDto = (r: RunRow): AutomationRun => ({
  id: r.id,
  clientId: r.clientId,
  action: r.action,
  status: r.status,
  reason: r.reason,
  result: r.result,
  receivedAt: r.receivedAt.toISOString(),
});

// ── Owner operations ──

/** One project's clients, or the read-only "All" view across the owner's workspaces. */
export async function listClients(db: Db, ownerId: string, projectId?: string) {
  const where = projectId
    ? eq(automationClients.projectId, (await resolveProject(db, ownerId, projectId)).projectId)
    : inArray(automationClients.workspaceId, await ownerWorkspaceIds(db, ownerId));
  const rows = await db.select().from(automationClients).where(where).orderBy(desc(automationClients.id));
  return rows.map(toClientDto);
}

export async function createClient(
  db: Db,
  authSecret: string,
  ctx: OwnerCtx,
  body: CreateAutomationClientRequest,
): Promise<AutomationClientSecret> {
  return db.transaction(async (tx) => {
    const scope = await resolveProject(tx, ctx.ownerId, body.projectId, { write: true });
    const [c] = await tx
      .insert(automationClients)
      .values({
        ownerId: ctx.ownerId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        name: body.name,
        allowedActions: [...new Set(body.allowedActions)],
        allowedJobTypes: [...new Set(body.allowedJobTypes)],
        rateLimitPerMinute: body.rateLimitPerMinute,
      })
      .returning();
    await audit(tx, {
      actor: ownerActor(ctx.ownerId),
      action: "automation.client.create",
      resourceType: "automation_client",
      resourceId: c!.id,
      correlationId: ctx.correlationId,
      metadata: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        allowedActions: c!.allowedActions,
        allowedJobTypes: c!.allowedJobTypes,
        rateLimitPerMinute: c!.rateLimitPerMinute,
      },
    });
    return { client: toClientDto(c!), signingKey: signingKey(authSecret, c!) };
  });
}

/** Loads and locks the owner's client, then re-checks its project is writable (archived = read-only). */
async function changeClient(
  db: Db,
  ctx: OwnerCtx,
  id: string,
  action: string,
  set: (c: ClientRow) => Partial<ClientRow>,
  metadata: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const [c] = await tx
      .select()
      .from(automationClients)
      .where(and(eq(automationClients.id, id), eq(automationClients.ownerId, ctx.ownerId)))
      .for("update");
    if (!c) throw notFound("Automation client");
    await resolveProject(tx, ctx.ownerId, c.projectId, { write: true });
    const [updated] = await tx
      .update(automationClients)
      .set({ ...set(c), updatedAt: new Date() })
      .where(eq(automationClients.id, id))
      .returning();
    await audit(tx, {
      actor: ownerActor(ctx.ownerId),
      action,
      resourceType: "automation_client",
      resourceId: id,
      correlationId: ctx.correlationId,
      metadata: { workspaceId: c.workspaceId, projectId: c.projectId, ...metadata },
    });
    return updated!;
  });
}

export async function updateClient(db: Db, ctx: OwnerCtx, id: string, body: UpdateAutomationClientRequest) {
  const set = {
    ...body,
    ...(body.allowedActions ? { allowedActions: [...new Set(body.allowedActions)] } : {}),
    ...(body.allowedJobTypes ? { allowedJobTypes: [...new Set(body.allowedJobTypes)] } : {}),
  };
  return toClientDto(await changeClient(db, ctx, id, "automation.client.update", () => set, set));
}

/** Bumps keyVersion: the old key stops verifying at once. */
export async function rotateClient(
  db: Db,
  authSecret: string,
  ctx: OwnerCtx,
  id: string,
): Promise<AutomationClientSecret> {
  const c = await changeClient(
    db,
    ctx,
    id,
    "automation.client.rotate",
    (c) => ({ keyVersion: c.keyVersion + 1 }),
    {},
  );
  return { client: toClientDto(c), signingKey: signingKey(authSecret, c) };
}

/** Newest runs of one client, one project, or the "All" view. */
export async function listRuns(db: Db, ownerId: string, q: { clientId?: string; projectId?: string }) {
  const scope = q.projectId
    ? eq(automationRuns.projectId, (await resolveProject(db, ownerId, q.projectId)).projectId)
    : inArray(automationRuns.workspaceId, await ownerWorkspaceIds(db, ownerId));
  const rows = await db
    .select()
    .from(automationRuns)
    .where(and(scope, q.clientId ? eq(automationRuns.clientId, q.clientId) : undefined))
    .orderBy(desc(automationRuns.id))
    .limit(RUN_LIST_LIMIT); // shortcut: newest 50 only; add a cursor when someone needs the older history here
  return rows.map(toRunDto);
}

// ── Service trigger (n8n) ──

const unauthenticated = () =>
  new HttpError(401, "UNAUTHENTICATED", "Automation request could not be authenticated");

const header = (headers: Record<string, string | string[] | undefined>, name: string) => {
  const v = headers[name];
  return typeof v === "string" ? v : undefined;
};

/** In-process fixed one-minute window per client. */
// shortcut: per process and reset on restart, like the global limiter; fine for one API process at home.
export function clientRateLimiter() {
  const windows = new Map<string, { start: number; count: number }>();
  return (clientId: string, max: number, now = Date.now()) => {
    const w = windows.get(clientId);
    if (!w || now - w.start >= 60_000) {
      windows.set(clientId, { start: now, count: 1 });
      return true;
    }
    return ++w.count <= max;
  };
}

/**
 * The client whose current key signed `${timestamp}.${raw}`, or a generic 401. Nothing is parsed before this
 * passes; the reason is logged server-side (never the signature or key).
 */
async function authenticate(
  deps: Pick<Deps, "db" | "config">,
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
  correlationId: string,
  log: FastifyBaseLogger,
  now = Date.now(),
): Promise<ClientRow> {
  const id = header(headers, AUTOMATION_CLIENT_HEADER);
  const timestamp = header(headers, AUTOMATION_TIMESTAMP_HEADER);
  const signature = header(headers, AUTOMATION_SIGNATURE_HEADER);
  const deny = async (reason: string, client?: ClientRow): Promise<never> => {
    log.warn({ clientId: client?.id ?? null, reason }, "automation trigger refused");
    // Forged calls against a real client are audited; unknown ids are only logged (no write for random traffic).
    if (client)
      await audit(deps.db, {
        actor: `automation:${client.id}`,
        action: "automation.trigger.unauthenticated",
        resourceType: "automation_client",
        resourceId: client.id,
        correlationId,
        outcome: "DENIED",
        metadata: { workspaceId: client.workspaceId, projectId: client.projectId, reason },
      });
    throw unauthenticated();
  };
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || !timestamp || !signature)
    return deny("missing or malformed headers");
  const [client] = await deps.db.select().from(automationClients).where(eq(automationClients.id, id));
  if (!client) return deny("unknown client");
  if (client.disabled) return deny("client disabled", client);
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > AUTOMATION_MAX_SKEW_SECONDS)
    return deny("timestamp outside the replay window", client);
  const expected = Buffer.from(
    `v1=${createHmac("sha256", signingKey(deps.config.authSecret, client)).update(`${timestamp}.`).update(raw).digest("hex")}`,
  );
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return deny("signature mismatch", client);
  return client;
}

/** Runs one allowed action inside the client's project, as its owner, with a key derived from the trigger's. */
async function runAction(
  deps: Pick<Deps, "db" | "config" | "github" | "research">,
  client: ClientRow,
  body: TriggerRequest,
  correlationId: string,
): Promise<NonNullable<AutomationRun["result"]>> {
  const { db, config } = deps;
  const action = body.action;
  if (!client.allowedActions.includes(action.type))
    throw new HttpError(403, "FORBIDDEN", `This automation client may not run ${action.type}`);
  const idempotencyKey = `automation:${client.id}:${body.idempotencyKey}`;
  if (action.type === "jobs.create") {
    const req = action.request;
    if (!client.allowedJobTypes.includes(req.jobType))
      throw new HttpError(403, "FORBIDDEN", `This automation client may not create ${req.jobType} jobs`);
    if (req.projectId !== client.projectId)
      throw new HttpError(403, "FORBIDDEN", "An automation client acts only in its own project", {
        field: "projectId",
      });
    const job = await createJob(db, {
      ownerId: client.ownerId,
      idempotencyKey,
      body: req,
      correlationId,
      timezone: config.ownerTimezone,
      pinIssue: (b) => requireGithub(deps.github).issueSnapshot(b.repositoryId, b.issueNumber, b.baseBranch),
    });
    return { kind: "job", id: job.id };
  }
  // A watchlist of another project doesn't exist for this client.
  if ((await getWatchlist(db, client.ownerId, action.watchlistId)).projectId !== client.projectId)
    throw notFound("Watchlist");
  await assertNotStopped(db); // research isn't a job, but an engaged stop still means nothing new starts
  const run = await createManualRun(
    db,
    { ownerId: client.ownerId, actor: `automation:${client.id}`, correlationId },
    action.watchlistId,
    idempotencyKey,
  );
  // Safe to repeat for a replayed run: the executor settles a run once, under its row lock.
  if (run.status === "RUNNING") deps.research.start(run.id);
  return { kind: "research_run", id: run.id };
}

/**
 * POST /v1/automations/trigger (AUTO-G01..G03): authenticate → rate limit → strict parse → replay → policy → act.
 * Every authenticated outcome is recorded as an automation run and audited.
 */
export async function trigger(
  deps: Pick<Deps, "db" | "config" | "github" | "research">,
  allow: ReturnType<typeof clientRateLimiter>,
  input: {
    raw: Buffer;
    headers: Record<string, string | string[] | undefined>;
    correlationId: string;
    log: FastifyBaseLogger;
  },
): Promise<TriggerResponse> {
  const { db } = deps;
  const client = await authenticate(deps, input.raw, input.headers, input.correlationId, input.log);
  if (!allow(client.id, client.rateLimitPerMinute)) {
    input.log.warn({ clientId: client.id }, "automation trigger rate limited");
    throw new HttpError(429, "RATE_LIMITED", "Too many automation requests; retry in a minute");
  }
  const actor = `automation:${client.id}`;
  const scope = { workspaceId: client.workspaceId, projectId: client.projectId };

  const record = (values: Pick<RunRow, "action" | "status" | "reason" | "result"> & Partial<RunRow>) =>
    db.transaction(async (tx) => {
      const [run] = await tx
        .insert(automationRuns)
        .values({ clientId: client.id, ...scope, correlationId: input.correlationId, ...values })
        .onConflictDoNothing()
        .returning();
      // A concurrent replay of the same key won: answer with its result.
      if (!run) return null;
      await tx
        .update(automationClients)
        .set({ lastUsedAt: new Date() })
        .where(eq(automationClients.id, client.id));
      await audit(tx, {
        actor,
        action: "automation.trigger",
        resourceType: "automation_run",
        resourceId: run.id,
        correlationId: input.correlationId,
        outcome: run.status === "ACCEPTED" ? "SUCCEEDED" : "DENIED",
        metadata: {
          ...scope,
          clientId: client.id,
          action: run.action,
          reason: run.reason,
          result: run.result,
        },
      });
      return run;
    });
  const reject = async (err: HttpError, action: RunRow["action"], idempotencyKey: string | null = null) => {
    await record({ action, status: "REJECTED", reason: err.message, result: null, idempotencyKey });
    return err;
  };

  let json: unknown;
  try {
    json = JSON.parse(input.raw.toString("utf8"));
  } catch {
    throw await reject(new HttpError(400, "VALIDATION_FAILED", "Body is not valid JSON"), null);
  }
  const parsed = TriggerRequest.safeParse(json);
  if (!parsed.success)
    throw await reject(
      new HttpError(
        400,
        "VALIDATION_FAILED",
        "Request validation failed",
        parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      ),
      null,
    );
  const body = parsed.data;
  const requestHash = sha256(canonical(body));
  const accepted = () =>
    db
      .select()
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.clientId, client.id),
          eq(automationRuns.idempotencyKey, body.idempotencyKey),
          eq(automationRuns.status, "ACCEPTED"),
        ),
      );
  const replay = (run: RunRow): TriggerResponse => {
    if (run.requestHash !== requestHash)
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "idempotencyKey was already used with a different body",
      );
    return { automationRunId: run.id, result: run.result! };
  };

  const [previous] = await accepted();
  if (previous) return replay(previous);

  let result: NonNullable<AutomationRun["result"]>;
  try {
    result = await runAction(deps, client, body, input.correlationId);
  } catch (err) {
    if (err instanceof HttpError) throw await reject(err, body.action.type, body.idempotencyKey);
    throw err;
  }
  const run = await record({
    action: body.action.type,
    status: "ACCEPTED",
    reason: null,
    result,
    idempotencyKey: body.idempotencyKey,
    requestHash,
  });
  if (run) return { automationRunId: run.id, result };
  const [winner] = await accepted();
  return replay(winner!);
}
