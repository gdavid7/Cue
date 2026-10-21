import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_MIGRATIONS } from "./local-migrations";

describe("LOCAL_MIGRATIONS", () => {
  it("gives every migration a unique id and name", () => {
    const entries = Object.values(LOCAL_MIGRATIONS);
    expect(new Set(entries.map((m) => m.id)).size).toBe(entries.length);
    expect(new Set(entries.map((m) => m.name)).size).toBe(entries.length);
  });

  it("prefixes each name with its zero-padded id", () => {
    for (const { id, name } of Object.values(LOCAL_MIGRATIONS)) {
      expect(name.startsWith(`${String(id).padStart(4, "0")}-`)).toBe(true);
    }
  });

  it("is the only place a schema_migrations id or name is written as a literal", () => {
    const dir = import.meta.dirname;
    const sources = readdirSync(dir).filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        file !== "local-migrations.ts",
    );
    const literalId =
      /schema_migrations[^;"'`]{0,40}?(?:\bid\s*=\s*\d|VALUES\s*\(\s*\d)/;
    const literalName = /['"]\d{4}-[a-z]/;
    const offenders = sources.filter((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      return literalId.test(text) || literalName.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
