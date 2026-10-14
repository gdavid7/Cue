import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  new URL(
    "../../prisma/migrations/20261015090000_access_requests/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe.skipIf(!process.env.RUN_DB_TESTS)("access request migration", () => {
  test("approves every existing user so the waitlist can't lock them out", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      // A scratch schema keeps the migration's enum and table away from the
      // real ones, and the rollback removes it.
      await client.query(`
        BEGIN;
        CREATE SCHEMA access_migration_test;
        SET LOCAL search_path TO access_migration_test;
        CREATE TABLE "User" ("id" text PRIMARY KEY, "email" text NOT NULL UNIQUE, "name" text);
        INSERT INTO "User" VALUES
          ('u1', 'Friend@Gmail.com', 'Friend'),
          ('u2', 'founder@gmail.com', NULL);
      `);
      await client.query(migration);
      const result = await client.query(
        `SELECT "email", "name", "source", "status", "decidedBy", "notifiedAt" IS NOT NULL AS notified
         FROM "AccessRequest" ORDER BY "email"`,
      );
      expect(result.rows).toEqual([
        {
          email: "founder@gmail.com",
          name: null,
          source: "existing_user",
          status: "APPROVED",
          decidedBy: "migration",
          notified: true,
        },
        {
          email: "friend@gmail.com",
          name: "Friend",
          source: "existing_user",
          status: "APPROVED",
          decidedBy: "migration",
          notified: true,
        },
      ]);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
