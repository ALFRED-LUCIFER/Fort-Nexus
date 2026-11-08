import { fileURLToPath } from "node:url";
import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "./schema.ts";

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

export type Db = ReturnType<typeof createDb>["db"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

// The schema's ids default to uuidv7(), which PostgreSQL has from version 18 on.
export const MIN_POSTGRES_VERSION_NUM = 180_000;

/** Fails fast, before any migration runs, when the server is older than PostgreSQL 18. */
export async function assertPostgresVersion(db: Db): Promise<void> {
  const { rows } = await db.execute<{ num: string; version: string }>(
    sql`select current_setting('server_version_num') as num, current_setting('server_version') as version`,
  );
  const num = Number(rows[0]?.num);
  if (!Number.isInteger(num) || num < MIN_POSTGRES_VERSION_NUM)
    throw new Error(
      `NEXUS needs PostgreSQL 18 or newer (its schema uses uuidv7()), but DATABASE_URL points at PostgreSQL ${rows[0]?.version ?? "of an unknown version"}. Upgrade the database (infra/compose uses postgres:18), then start NEXUS again.`,
    );
}

export async function runMigrations(db: Db): Promise<void> {
  await assertPostgresVersion(db);
  await migrate(db, { migrationsFolder });
}
