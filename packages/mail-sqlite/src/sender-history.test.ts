import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { SenderHistoryQuery } from "@inboxzero/mail-core/queries";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const T0 = 1_800_000_000_000;
const ME = "me@example.com";

const stores: MailStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("readSenderHistory", () => {
  it("finds the addresses you have written to under the same name, accents and case aside", async () => {
    const store = await setup(["a", "b"]);
    await write(store, [
      sent("1", ["José Álvarez <jose@example.com>"], T0),
      sent("2", ["JOSE ALVAREZ <jose@work.example>"], T0 + 10),
      // Their own From line, but never written to: not vouched for.
      mail("3", "Jose Alvarez <jose@received-only.example>"),
      // Another person who shares the surname.
      sent("4", ["Maria Alvarez <maria@example.com>"]),
    ]);
    await write(store, [sent("b1", ["Jose Alvarez <jose@b.example>"])], "b");
    await ready(store);

    expect(
      await read(store, {
        email: "jose.alvarez@new.example",
        name: "jose  alvarez",
      }),
    ).toEqual({
      ready: true,
      writtenTo: false,
      sameNameAddresses: [
        "jose@work.example",
        "jose@b.example",
        "jose@example.com",
      ],
    });
  });

  it("says whether you have written to the address itself", async () => {
    const store = await setup();
    await write(store, [
      sent("1", ["Dana Example <dana@example.com>"]),
      sent("2", ["dana@personal.example"]),
    ]);
    await ready(store);

    expect(
      await read(store, {
        email: "Dana@Personal.example",
        name: "Dana Example",
      }),
    ).toMatchObject({
      writtenTo: true,
      sameNameAddresses: ["dana@example.com"],
    });
  });

  it("leaves out the user's own addresses", async () => {
    const store = await setup();
    await write(store, [sent("1", ["Sam Taylor <me@work.example>"])]);
    await ready(store);

    expect(
      await read(store, {
        email: "sam@new.example",
        name: "Sam Taylor",
        ownAddresses: [ME, "me@work.example"],
      }),
    ).toMatchObject({ sameNameAddresses: [] });
  });

  it("is not ready until the contact index has read every message", async () => {
    const store = await setup();
    await write(store, [sent("1", ["Dana Example <dana@example.com>"])]);
    expect(await read(store)).toMatchObject({ ready: false });
  });

  it("looks nothing up for a short name or a machine address", async () => {
    const store = await setup();
    await write(store, [
      sent("1", ["Dana Example <dana@example.com>", "Dana <d@example.com>"]),
    ]);
    await ready(store);

    expect(await read(store, { name: "Dana" })).toMatchObject({
      sameNameAddresses: [],
    });
    expect(
      await read(store, { email: "noreply@service.example" }),
    ).toMatchObject({ sameNameAddresses: [] });
  });
});

async function setup(accountIds = ["a"]) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  stores.push(store);
  for (const accountId of accountIds)
    await store.ensureAccount({
      accountId,
      provider: "google",
      generation: "g",
    });
  return store;
}

async function ready(store: MailStore) {
  while ((await store.indexContactBacklog()).remaining) {
    // Each call indexes one batch.
  }
}

function read(store: MailStore, input: Partial<SenderHistoryQuery> = {}) {
  return store.readSenderHistory({
    accountIds: ["a", "b"],
    email: "dana@new.example",
    name: "Dana Example",
    ownAddresses: [ME],
    ...input,
  });
}

async function write(
  store: MailStore,
  changes: ProviderChange[],
  accountId = "a",
) {
  expect(
    await store.applyHydration({
      session: { accountId, generation: "g" },
      requestId: "test",
      changes: changes.map((change) =>
        change.kind === "message_patch"
          ? { ...change, key: { ...change.key, accountId } }
          : change,
      ),
      bodies: [],
    }),
  ).toMatchObject({ status: "committed" });
}

function sent(id: string, to: string[], at = T0) {
  return mail(id, ME, to, at, ["sent"]);
}

function mail(
  id: string,
  from: string,
  to = [ME],
  at = T0,
  roles: ("sent" | "inbox")[] = ["inbox"],
): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId: "a", messageId: id },
    reference: {
      provider: "google",
      messageId: id,
      conversationId: id,
      version: "1",
    },
    fields: {
      from,
      to,
      cc: [],
      receivedAtMs: at,
      roles,
      subject: "",
      preview: "",
      read: true,
      starred: false,
      folderId: null,
      labelIds: [],
      categoryIds: [],
      hasAttachments: false,
    },
  };
}
