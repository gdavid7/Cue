import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { SenderHistoryQuery } from "@inboxzero/mail-core/queries";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import type { SqliteDriver } from "./driver";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const ME = "me@example.com";

const stores: MailStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("readSenderHistory", () => {
  it("finds the address you most recently wrote to under the same name, accents and case aside", async () => {
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
      receivedBefore: false,
      knownAddress: "jose@work.example",
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
      knownAddress: "dana@example.com",
    });
  });

  it("counts a colleague's personal address that has written to you before as known", async () => {
    const store = await setup();
    await write(store, [
      sent("1", ["Dana Example <dana@work.example>"]),
      mail("2", "Dana Example <dana@personal.example>", [ME], T0 + DAY),
      mail("3", "Dana Example <dana@personal.example>", [ME], T0 + 2 * DAY),
      // The message being read.
      mail("4", "Dana Example <dana@personal.example>", [ME], T0 + 3 * DAY),
    ]);
    await ready(store);

    expect(
      await read(store, {
        email: "dana@personal.example",
        receivedAtMs: T0 + 3 * DAY,
      }),
    ).toMatchObject({
      receivedBefore: true,
      knownAddress: "dana@work.example",
    });
  });

  it("treats a lookalike's first message as new, and its copy in another account too", async () => {
    const store = await setup(["a", "b"]);
    await write(store, [
      sent("1", ["Dana Example <dana@work.example>"]),
      // The message being read.
      mail("2", "Dana Example <dana@lookalike.example>", [ME], T0 + DAY),
    ]);
    // The same message reached the other account a few seconds earlier.
    await write(
      store,
      [
        mail(
          "b2",
          "Dana Example <dana@lookalike.example>",
          [ME],
          T0 + DAY - 5000,
        ),
      ],
      "b",
    );
    // Mail that only copied the address in doesn't count as theirs.
    await write(store, [
      mail("3", "Someone Else <else@example.com>", [
        ME,
        "dana@lookalike.example",
      ]),
    ]);
    await ready(store);

    expect(
      await read(store, {
        email: "dana@lookalike.example",
        receivedAtMs: T0 + DAY,
      }),
    ).toMatchObject({
      receivedBefore: false,
      knownAddress: "dana@work.example",
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
    ).toMatchObject({ knownAddress: null });
  });

  it("is not ready until the contact index has read every message", async () => {
    const store = await setup();
    await write(store, [sent("1", ["Dana Example <dana@example.com>"])]);
    await listed(store);
    expect(await read(store)).toMatchObject({ ready: false });
  });

  it("is not ready until every scope of the mailbox has been listed", async () => {
    const store = await setup();
    await write(store, [sent("1", ["Dana Example <dana@example.com>"])]);
    await indexed(store);
    expect(await read(store, { accountIds: ["a"] })).toMatchObject({
      ready: false,
    });
    await listed(store);
    expect(await read(store, { accountIds: ["a"] })).toMatchObject({
      ready: true,
    });
  });

  it("looks nothing up for a short name or a machine address", async () => {
    const store = await setup();
    await write(store, [
      sent("1", ["Dana Example <dana@example.com>", "Dana <d@example.com>"]),
    ]);
    await ready(store);

    expect(await read(store, { name: "Dana" })).toMatchObject({
      knownAddress: null,
    });
    expect(
      await read(store, { email: "noreply@service.example" }),
    ).toMatchObject({ knownAddress: null });
  });
});

const drivers = new WeakMap<MailStore, SqliteDriver>();

async function setup(accountIds = ["a"]) {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  stores.push(store);
  drivers.set(store, driver);
  for (const accountId of accountIds)
    await store.ensureAccount({
      accountId,
      provider: "google",
      generation: "g",
    });
  return store;
}

async function ready(store: MailStore) {
  await indexed(store);
  await listed(store);
}

async function indexed(store: MailStore) {
  while ((await store.indexContactBacklog()).remaining) {
    // Each call indexes one batch.
  }
}

/** Marks every account's mailbox as fully listed. */
async function listed(store: MailStore) {
  await drivers.get(store)?.write(async (tx) => {
    for (const accountId of ["a", "b"])
      await tx.execute(
        `INSERT OR REPLACE INTO coverage(account_id, scope_id, metadata, content, indexed_content)
         VALUES (?, 'primary', 'complete', 'partial', 'partial')`,
        [accountId],
      );
  });
}

function read(store: MailStore, input: Partial<SenderHistoryQuery> = {}) {
  return store.readSenderHistory({
    accountIds: ["a", "b"],
    email: "dana@new.example",
    name: "Dana Example",
    ownAddresses: [ME],
    receivedAtMs: T0 + 30 * DAY,
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
