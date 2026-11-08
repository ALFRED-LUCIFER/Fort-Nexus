import { describe, expect, it } from "vitest";
import { assertPostgresVersion, createDb, type Db } from "../src/db/index.ts";
import { freshDatabaseUrl } from "./helpers/owner-session.ts";

// The schema's ids default to uuidv7() (PostgreSQL 18+): an older server fails before any migration runs.

const server = (num: string, version: string) =>
  ({ execute: async () => ({ rows: [{ num, version }] }) }) as unknown as Db;

describe("assertPostgresVersion", () => {
  it("refuses a server older than PostgreSQL 18 with a message naming the version and the fix", async () => {
    await expect(assertPostgresVersion(server("170005", "17.5"))).rejects.toThrow(
      /needs PostgreSQL 18 or newer.*uuidv7\(\).*PostgreSQL 17\.5\. Upgrade the database/,
    );
    await expect(assertPostgresVersion(server("", "?"))).rejects.toThrow(/needs PostgreSQL 18/);
  });

  it("accepts PostgreSQL 18 (the test server)", async () => {
    await expect(assertPostgresVersion(server("180001", "18.1"))).resolves.toBeUndefined();
    const { db, pool } = createDb(await freshDatabaseUrl());
    try {
      await expect(assertPostgresVersion(db)).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});
