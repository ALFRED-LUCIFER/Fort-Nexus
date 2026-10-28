import { and, desc, eq } from "drizzle-orm";
import type {
  ConnectionTestResult,
  Connector,
  ConnectorStatus,
  CreateConnectorRequest,
  MetricDictionary,
  UpdateConnectorRequest,
} from "@nexus/contracts";
import { audit } from "../audit.ts";
import type { Db } from "../db/index.ts";
import { HttpError, notFound } from "../errors.ts";
import type { ProjectScope } from "../scope.ts";
import { CredentialError, loadConnectionString } from "./credentials.ts";
import { ConnectError, IdentifierError, isTimeout, quoteTable, readOnly } from "./gateway.ts";
import { businessConnectors, type BusinessConnectorRow } from "./schema.ts";

/** Who is calling, for which project, and how to reach connector credentials. Every query filters on the scope. */
export type BusinessScope = ProjectScope & {
  db: Db;
  connectorsDir: string;
  actor: string;
  correlationId: string;
};

type Check = ConnectionTestResult["checks"][number];

export const toConnectorDto = (r: BusinessConnectorRow): Connector => ({
  id: r.id,
  projectId: r.projectId,
  name: r.name,
  provider: r.provider,
  environment: r.environment,
  credentialRef: r.credentialRef,
  schemaAllowlist: r.schemaAllowlist,
  statementTimeoutMs: r.statementTimeoutMs,
  status: r.status,
  lastTestedAt: r.lastTestedAt?.toISOString() ?? null,
  lastError: r.lastError,
  hasDictionary: r.dictionary !== null,
  createdAt: r.createdAt.toISOString(),
});

const inScope = (s: ProjectScope, id: string) =>
  and(
    eq(businessConnectors.id, id),
    eq(businessConnectors.workspaceId, s.workspaceId),
    eq(businessConnectors.projectId, s.projectId),
  );

export async function findConnector(s: BusinessScope, id: string): Promise<BusinessConnectorRow | undefined> {
  const [row] = await s.db.select().from(businessConnectors).where(inScope(s, id));
  return row;
}

async function requireConnector(s: BusinessScope, id: string) {
  const row = await findConnector(s, id);
  if (!row) throw notFound("Connector");
  return row;
}

const auditMeta = (s: BusinessScope, extra: Record<string, unknown> = {}) => ({
  workspaceId: s.workspaceId,
  projectId: s.projectId,
  ...extra,
});

export async function listConnectors(s: BusinessScope): Promise<Connector[]> {
  const rows = await s.db
    .select()
    .from(businessConnectors)
    .where(
      and(eq(businessConnectors.workspaceId, s.workspaceId), eq(businessConnectors.projectId, s.projectId)),
    )
    .orderBy(desc(businessConnectors.id));
  return rows.map(toConnectorDto);
}

export async function createConnector(s: BusinessScope, body: CreateConnectorRequest): Promise<Connector> {
  return s.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(businessConnectors)
      .values({
        ...body,
        workspaceId: s.workspaceId,
        projectId: s.projectId, // shortcut: placeholder scope wins over body.projectId until wave 2 S2 lands
        status: "UNTESTED",
      })
      .returning();
    await audit(tx, {
      actor: s.actor,
      action: "connector.create",
      resourceType: "connector",
      resourceId: row!.id,
      correlationId: s.correlationId,
      metadata: auditMeta(s, { provider: body.provider, environment: body.environment }),
    });
    return toConnectorDto(row!);
  });
}

/** Changing what or how the connector reads needs a fresh test before a PROD connector serves tools again. */
export async function updateConnector(
  s: BusinessScope,
  id: string,
  u: UpdateConnectorRequest,
): Promise<Connector> {
  return s.db.transaction(async (tx) => {
    const [row] = await tx.select().from(businessConnectors).where(inScope(s, id)).for("update");
    if (!row) throw notFound("Connector");
    const { disabled, ...fields } = u;
    let status: ConnectorStatus = row.status;
    if (disabled === true) status = "DISABLED";
    else if (disabled === false && status === "DISABLED") status = "UNTESTED";
    else if ((u.credentialRef !== undefined || u.schemaAllowlist !== undefined) && status !== "DISABLED")
      status = "UNTESTED";
    const [updated] = await tx
      .update(businessConnectors)
      .set({ ...fields, status, ...(status === "UNTESTED" && { lastError: null }), updatedAt: new Date() })
      .where(eq(businessConnectors.id, id))
      .returning();
    await audit(tx, {
      actor: s.actor,
      action: "connector.update",
      resourceType: "connector",
      resourceId: id,
      correlationId: s.correlationId,
      metadata: auditMeta(s, { fields: Object.keys(u), status }),
    });
    return toConnectorDto(updated!);
  });
}

export async function getDictionary(s: BusinessScope, id: string): Promise<MetricDictionary> {
  const row = await requireConnector(s, id);
  if (!row.dictionary) throw notFound("Metric dictionary");
  return row.dictionary;
}

const dictionaryTables = (d: MetricDictionary) => [d.orders.table, ...(d.payments ? [d.payments.table] : [])];

export async function putDictionary(
  s: BusinessScope,
  id: string,
  dictionary: MetricDictionary,
): Promise<MetricDictionary> {
  return s.db.transaction(async (tx) => {
    const [row] = await tx.select().from(businessConnectors).where(inScope(s, id)).for("update");
    if (!row) throw notFound("Connector");
    try {
      for (const t of dictionaryTables(dictionary)) quoteTable(t, row.schemaAllowlist);
    } catch (err) {
      if (err instanceof IdentifierError) throw new HttpError(400, "VALIDATION_FAILED", err.message);
      throw err;
    }
    const status: ConnectorStatus = row.status === "DISABLED" ? "DISABLED" : "UNTESTED";
    await tx
      .update(businessConnectors)
      .set({ dictionary, status, lastError: null, updatedAt: new Date() })
      .where(eq(businessConnectors.id, id));
    await audit(tx, {
      actor: s.actor,
      action: "connector.dictionary.put",
      resourceType: "connector",
      resourceId: id,
      correlationId: s.correlationId,
      metadata: auditMeta(s, { tables: dictionaryTables(dictionary), payments: !!dictionary.payments }),
    });
    return dictionary;
  });
}

const sqlState = (err: unknown) => {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : "unknown";
};

/** FR-CON-02: credential → network → auth → read_only → schema_allowlist → dictionary, stopping at the first failure. */
export async function testConnector(s: BusinessScope, id: string): Promise<ConnectionTestResult> {
  const row = await requireConnector(s, id);
  if (row.status === "DISABLED")
    throw new HttpError(409, "CONFLICT", "Enable the connector before testing it");
  const checks: Check[] = [];
  const pass = (name: Check["name"], detail: string) => checks.push({ name, ok: true, detail });
  const fail = (name: Check["name"], detail: string) => checks.push({ name, ok: false, detail });

  let connectionString: string | undefined;
  try {
    connectionString = await loadConnectionString(s.connectorsDir, row.credentialRef);
    pass("credential", `${row.credentialRef}.json found with mode 0600`);
  } catch (err) {
    if (!(err instanceof CredentialError)) throw err;
    fail("credential", err.message);
  }

  if (connectionString) {
    let current: Check["name"] = "network";
    try {
      await readOnly(
        connectionString,
        { timeoutMs: row.statementTimeoutMs, schemas: row.schemaAllowlist },
        async (c) => {
          pass("network", "Reached the database");
          pass("auth", "Signed in with the connector's role");

          current = "read_only";
          const ro = await c.query<{
            superuser: boolean;
            create_in: string[] | null;
            writable: string[] | null;
          }>(
            `select
               coalesce((select rolsuper from pg_roles where rolname = current_user), false) as superuser,
               (select array_agg(nspname order by nspname) from pg_namespace
                 where nspname = any($1::text[]) and has_schema_privilege(oid, 'CREATE')) as create_in,
               (select array_agg(t order by t) from (
                 select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = any($1::text[]) and c.relkind in ('r', 'p', 'v', 'm', 'f')
                   and has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')) w) as writable`,
            [row.schemaAllowlist],
          );
          const r = ro.rows[0]!;
          if (r.superuser)
            return fail("read_only", "The role is a superuser: use a dedicated read-only role");
          if (r.create_in?.length)
            return fail("read_only", `The role can create objects in ${r.create_in.join(", ")}`);
          if (r.writable?.length)
            return fail(
              "read_only",
              `The role can write to ${r.writable.slice(0, 5).join(", ")}${r.writable.length > 5 ? ` and ${r.writable.length - 5} more` : ""}`,
            );
          pass("read_only", "No write, truncate or create privilege in the allowlisted schemas");

          current = "schema_allowlist";
          const usable = await c.query<{ nspname: string }>(
            "select nspname from pg_namespace where nspname = any($1::text[]) and has_schema_privilege(oid, 'USAGE')",
            [row.schemaAllowlist],
          );
          const missing = row.schemaAllowlist.filter((n) => !usable.rows.some((u) => u.nspname === n));
          if (missing.length)
            return fail("schema_allowlist", `No such schema, or no USAGE on: ${missing.join(", ")}`);
          pass("schema_allowlist", `USAGE on ${row.schemaAllowlist.join(", ")}`);

          current = "dictionary";
          const d = row.dictionary;
          if (!d)
            return pass(
              "dictionary",
              "No metric dictionary yet: metrics stay unavailable until you define one",
            );
          const cols: [string, string][] = [
            [d.orders.table, d.orders.createdAtColumn],
            [d.orders.table, d.orders.statusColumn],
            [d.orders.table, d.orders.amountColumn],
            ...(d.payments
              ? ([
                  [d.payments.table, d.payments.createdAtColumn],
                  [d.payments.table, d.payments.statusColumn],
                  [d.payments.table, d.payments.reasonColumn],
                ] as [string, string][])
              : []),
          ];
          const notReadable = await c.query<{ col: string }>(
            `select u.t || '.' || u.c as col from unnest($1::text[], $2::text[]) as u(t, c)
             left join pg_namespace n on n.nspname = split_part(u.t, '.', 1)
             left join pg_class k on k.relnamespace = n.oid and k.relname = split_part(u.t, '.', 2)
             left join pg_attribute a on a.attrelid = k.oid and a.attname = u.c and a.attnum > 0 and not a.attisdropped
             where a.attnum is null or not has_column_privilege(k.oid, a.attnum, 'SELECT')`,
            [cols.map(([t]) => t), cols.map(([, col]) => col)],
          );
          if (notReadable.rows.length)
            return fail(
              "dictionary",
              `Missing or not readable: ${[...new Set(notReadable.rows.map((x) => x.col))].join(", ")}`,
            );
          pass("dictionary", "Every dictionary column exists and is readable");
        },
      );
    } catch (err) {
      if (err instanceof ConnectError) fail(err.check, err.message);
      else if (isTimeout(err)) fail(current, `Timed out after ${row.statementTimeoutMs} ms`);
      else fail(current, `Query failed (SQLSTATE ${sqlState(err)})`); // pg messages may quote data: code only
    }
  }

  const ok = checks.every((c) => c.ok);
  const testedAt = new Date();
  await s.db.transaction(async (tx) => {
    await tx
      .update(businessConnectors)
      .set({
        status: ok ? "CONNECTED" : "FAILED",
        lastTestedAt: testedAt,
        lastError: ok ? null : checks.find((c) => !c.ok)!.detail,
        updatedAt: testedAt,
      })
      // Don't record a result for settings that changed (or a connector disabled) while the test ran.
      .where(
        and(
          eq(businessConnectors.id, id),
          eq(businessConnectors.status, row.status),
          eq(businessConnectors.credentialRef, row.credentialRef),
        ),
      );
    await audit(tx, {
      actor: s.actor,
      action: "connector.test",
      resourceType: "connector",
      resourceId: id,
      correlationId: s.correlationId,
      outcome: ok ? "SUCCEEDED" : "FAILED",
      metadata: auditMeta(s, {
        environment: row.environment,
        checks: Object.fromEntries(checks.map((c) => [c.name, c.ok])),
      }),
    });
  });
  return { ok, checks, testedAt: testedAt.toISOString() };
}
