import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { LOCAL_MIGRATIONS } from "./local-migrations";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

describe("important people", () => {
  it("keys a star by account and normalised address", async () => {
    const { store } = await openStore();
    await store.writeImportantPerson({
      accountIds: ["acc-1"],
      email: '"Dana Lee" <Dana.Lee@Example.COM> ',
      important: true,
    });

    expect(await store.readImportantPeople(["acc-1", "acc-2"])).toEqual([
      { accountId: "acc-1", email: "dana.lee@example.com", addedAtMs: 1000 },
    ]);
    expect(await store.readImportantPeople(["acc-2"])).toEqual([]);
    await store.close();
  });

  it("stars and unstars across every account it's given, and survives a reopen", async () => {
    const { store, path } = await openStore();
    await store.writeImportantPerson({
      accountIds: ["acc-1", "acc-2"],
      email: "dana@example.com",
      important: true,
    });
    // Starring again keeps when it was first starred.
    await store.writeImportantPerson({
      accountIds: ["acc-1"],
      email: "DANA@example.com",
      important: true,
    });
    await store.close();

    const reopened = await createSqliteMailStore(createNodeSqliteDriver(path), {
      runtime: runtimeAt(5000),
    });
    expect(
      (await reopened.readImportantPeople(["acc-1", "acc-2"])).map((person) => [
        person.accountId,
        person.addedAtMs,
      ]),
    ).toEqual([
      ["acc-1", 1000],
      ["acc-2", 1000],
    ]);

    await reopened.writeImportantPerson({
      accountIds: ["acc-2"],
      email: "dana@example.com",
      important: false,
    });
    expect(
      (await reopened.readImportantPeople(["acc-1", "acc-2"])).map(
        (person) => person.accountId,
      ),
    ).toEqual(["acc-1"]);
    await reopened.close();
  });

  it("rejects input without an address or accounts", async () => {
    const { store } = await openStore();
    await expect(
      store.writeImportantPerson({
        accountIds: ["acc-1"],
        email: "Dana Lee",
        important: true,
      }),
    ).rejects.toThrow("important_person_invalid_address");
    await expect(
      store.writeImportantPerson({
        accountIds: [],
        email: "dana@example.com",
        important: true,
      }),
    ).rejects.toThrow("important_person_invalid_accounts");
    expect(await store.readImportantPeople(["acc-1"])).toEqual([]);
    await store.close();
  });

  it("forgets an account's stars when the account is purged", async () => {
    const { store } = await openStore();
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "acc-1",
    });
    await store.writeImportantPerson({
      accountIds: ["acc-1", "acc-2"],
      email: "dana@example.com",
      important: true,
    });

    await store.purgeAccount("acc-1");

    expect(
      (await store.readImportantPeople(["acc-1", "acc-2"])).map(
        (person) => person.accountId,
      ),
    ).toEqual(["acc-2"]);
    await store.close();
  });

  it("records its local migration once", async () => {
    const { store, path } = await openStore();
    await store.close();
    const reopened = await createSqliteMailStore(createNodeSqliteDriver(path));
    await reopened.close();

    const db = new DatabaseSync(path);
    const rows = db
      .prepare("SELECT name FROM schema_migrations WHERE id = ?")
      .all(LOCAL_MIGRATIONS.importantPeople.id);
    db.close();
    expect(rows).toEqual([{ name: LOCAL_MIGRATIONS.importantPeople.name }]);
  });
});

async function openStore() {
  const directory = await mkdtemp(join(tmpdir(), "mail-important-"));
  const path = join(directory, "mailbox.sqlite");
  const store = await createSqliteMailStore(createNodeSqliteDriver(path), {
    runtime: runtimeAt(1000),
  });
  return { store, path };
}

function runtimeAt(nowMs: number) {
  return {
    nowMs: () => nowMs,
    randomId: randomUUID,
    sha256: async (bytes: Uint8Array) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  };
}
