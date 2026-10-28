import pg from "pg";

// The only way NEXUS talks to a business database (FR-DATA-01). Every call: a fresh short-lived client, a READ ONLY
// transaction, a statement timeout and a search_path limited to the allowlist. Callers pass fixed SQL templates whose
// identifiers come from `quoteTable`/`quoteColumn`; nothing here takes SQL from a request, and nothing returns rows.

const CONNECT_TIMEOUT_MS = 5_000;

export type GatewayOptions = { timeoutMs: number; schemas: readonly string[] };

/** A connect/auth failure, as opposed to one raised by a query once connected. Message is key-free. */
export class ConnectError extends Error {
  readonly check: "network" | "auth";
  constructor(check: "network" | "auth", message: string) {
    super(message);
    this.check = check;
  }
}

const AUTH_CODES = new Set(["28000", "28P01", "3D000"]); // bad role/password, no such database

function connectError(err: unknown): ConnectError {
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && AUTH_CODES.has(code))
    return new ConnectError("auth", `The database rejected the credential (SQLSTATE ${code})`);
  // pg/net messages can carry host names and user names from the connection string: report the code only.
  return new ConnectError(
    "network",
    `Can't reach the database${typeof code === "string" ? ` (${code})` : " (connection timed out or was closed)"}`,
  );
}

/** Runs `fn` in a READ ONLY transaction bounded by the connector's statement timeout. The client never outlives the call. */
export async function readOnly<T>(
  connectionString: string,
  opts: GatewayOptions,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // Client-side backstop in case the server never answers the statement timeout.
    query_timeout: opts.timeoutMs + 2_000,
    application_name: "nexus-business-readonly",
  });
  client.on("error", () => undefined); // a dropped connection surfaces on the pending query instead
  try {
    try {
      await client.connect();
    } catch (err) {
      throw connectError(err);
    }
    await client.query("begin read only");
    // Naive `timestamp` columns are read as UTC; reporting time zones are applied explicitly in SQL.
    await client.query(
      "select set_config('statement_timeout', $1, true), set_config('search_path', $2, true), set_config('TimeZone', 'UTC', true)",
      [String(opts.timeoutMs), opts.schemas.map((s) => pg.escapeIdentifier(s)).join(", ")],
    );
    const result = await fn(client);
    await client.query("commit");
    return result;
  } finally {
    await client.end().catch(() => undefined); // an open transaction is rolled back by the server
  }
}

/** `schema.table` → `"schema"."table"`, only when the schema is allowlisted. */
export function quoteTable(table: string, allowlist: readonly string[]): string {
  const [schema, name] = table.split(".");
  if (!schema || !name || !allowlist.includes(schema))
    throw new IdentifierError(`${table} is outside the connector's schema allowlist`);
  return `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(name)}`;
}

export const quoteColumn = (column: string) => pg.escapeIdentifier(column);

export class IdentifierError extends Error {}

/** statement_timeout (57014) or the client-side backstop. */
export const isTimeout = (err: unknown) =>
  (err as { code?: unknown }).code === "57014" ||
  (err instanceof Error && /query read timeout/i.test(err.message));
