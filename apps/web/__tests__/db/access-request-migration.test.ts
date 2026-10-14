import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, test } from "vitest";

const readMigration = (name: string) =>
  readFileSync(
    new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url),
    "utf8",
  );
const createMigration = readMigration("20261015090000_access_requests");
const gmailFormMigration = readMigration(
  "20261015100000_access_request_gmail_form",
);

describe.skipIf(!process.env.RUN_DB_TESTS)("access request migrations", () => {
  test("approve every existing user, in the form sign-ins are matched in", async () => {
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
          ('u2', 'founder@school.edu', NULL),
          ('u3', 'Jane.Doe@googlemail.com', 'Jane'),
          ('u4', 'jo.e@gmail.com', NULL),
          ('u5', 'joe@gmail.com', NULL);
      `);
      await client.query(createMigration);
      await client.query(gmailFormMigration);
      const result = await client.query(
        `SELECT "email", "source", "status", "decidedBy", "notifiedAt" IS NOT NULL AS notified
         FROM "AccessRequest" ORDER BY "email"`,
      );
      const approved = {
        source: "existing_user",
        status: "APPROVED",
        decidedBy: "migration",
        notified: true,
      };
      expect(result.rows).toEqual([
        { email: "founder@school.edu", ...approved },
        { email: "friend@gmail.com", ...approved },
        { email: "janedoe@gmail.com", ...approved },
        // Two accounts that are one Gmail address: one keeps its raw form,
        // which sign-in lookups still match.
        { email: "jo.e@gmail.com", ...approved },
        { email: "joe@gmail.com", ...approved },
      ]);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
