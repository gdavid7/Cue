import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { LeftOpenDraftsQuery } from "@inboxzero/mail-core/queries";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const SAVED_BEFORE = NOW - HOUR;

const stores: MailStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("readLeftOpenDrafts", () => {
  it("lists drafts last saved over an hour ago, newest first", async () => {
    const store = await setup();
    await write(store, [
      draft({ id: "older", at: NOW - 2 * DAY, subject: "Budget" }),
      draft({ id: "newer", at: NOW - 3 * HOUR, subject: "Re: Lunch" }),
    ]);

    expect(await read(store)).toEqual([
      {
        accountId: "a",
        conversationId: "newer",
        messageId: "newer",
        subject: "Re: Lunch",
        to: ["ann@example.com"],
        savedAtMs: NOW - 3 * HOUR,
      },
      {
        accountId: "a",
        conversationId: "older",
        messageId: "older",
        subject: "Budget",
        to: ["ann@example.com"],
        savedAtMs: NOW - 2 * DAY,
      },
    ]);
  });

  it("leaves out a draft saved within the hour, as it is still being written", async () => {
    const store = await setup();
    await write(store, [
      draft({ id: "recent", at: NOW - 10 * 60_000 }),
      // An older copy in the same conversation doesn't make it abandoned.
      draft({ id: "recent-old", conversationId: "recent", at: NOW - DAY }),
    ]);

    expect(await read(store)).toEqual([]);
  });

  it("shows a conversation once, by its newest draft", async () => {
    const store = await setup();
    await write(store, [
      draft({ id: "first", conversationId: "c", at: NOW - 2 * DAY }),
      draft({ id: "second", conversationId: "c", at: NOW - DAY }),
    ]);

    expect((await read(store)).map((item) => item.messageId)).toEqual([
      "second",
    ]);
  });

  it("is gone once sent, and never lists received or sent mail", async () => {
    const store = await setup();
    await write(store, [draft({ id: "d", at: NOW - DAY })]);
    expect(await read(store)).toHaveLength(1);

    // Sending turns the draft into the sent message.
    await write(store, [
      draft({ id: "d", at: NOW - DAY, roles: ["sent"], version: "2" }),
    ]);
    await write(store, [
      draft({ id: "inbox", at: NOW - DAY, roles: ["inbox"] }),
    ]);

    expect(await read(store)).toEqual([]);
  });

  it("leaves out drafts in the trash and drafts with nothing written", async () => {
    const store = await setup();
    await write(store, [
      draft({ id: "trashed", at: NOW - DAY, roles: ["draft", "trash"] }),
      draft({ id: "subject-only", at: NOW - DAY, preview: "  " }),
    ]);

    expect(await read(store)).toEqual([]);
  });

  it("never lists a Cue suggestion the user hasn't edited, which stays in Cue", async () => {
    const store = await setup();
    // A composer opened on Cue's reply keeps it on this device only; it
    // reaches the mailbox as a draft once the user changes it.
    expect(
      await store.saveDraft({
        key: { accountId: "a", draftId: "m1:reply" },
        expectedRevision: null,
        content: {
          to: ["ann@example.com"],
          cc: [],
          bcc: [],
          subject: "Re: Plans",
          editableHtml: "<p>Sounds good, see you then.</p>",
          quotedHtml: "",
          conversationId: "c1",
          clientState: JSON.stringify({
            startedFrom: { reply: "Sounds good, see you then." },
          }),
        },
      }),
    ).toMatchObject({ status: "saved" });
    await write(store, [
      draft({
        id: "m1",
        conversationId: "c1",
        at: NOW - DAY,
        roles: ["inbox"],
      }),
    ]);

    expect(await read(store)).toEqual([]);

    // Edited, it is the user's draft in the mailbox.
    await write(store, [
      draft({ id: "edited", conversationId: "c1", at: NOW - 2 * HOUR }),
    ]);
    expect((await read(store)).map((item) => item.messageId)).toEqual([
      "edited",
    ]);
  });

  it("reads each asked account, newest first across them, up to the limit", async () => {
    const store = await setup(["a", "b"]);
    await write(store, [draft({ id: "a1", at: NOW - 3 * DAY })], "a");
    await write(store, [draft({ id: "b1", at: NOW - DAY })], "b");
    await write(store, [draft({ id: "b2", at: NOW - 2 * DAY })], "b");

    const drafts = await read(store, { accountIds: ["a", "b"], limit: 2 });
    expect(drafts.map((item) => [item.accountId, item.messageId])).toEqual([
      ["b", "b1"],
      ["b", "b2"],
    ]);
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

function read(store: MailStore, input: Partial<LeftOpenDraftsQuery> = {}) {
  return store.readLeftOpenDrafts({
    accountIds: ["a"],
    savedBeforeMs: SAVED_BEFORE,
    limit: 10,
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

function draft({
  id,
  conversationId = id,
  subject = "Plans",
  preview = "Thinking we could",
  at,
  roles = ["draft"],
  version = "1",
}: {
  id: string;
  conversationId?: string;
  subject?: string;
  preview?: string;
  at: number;
  roles?: ("inbox" | "trash" | "draft" | "sent")[];
  version?: string;
}): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId: "a", messageId: id },
    reference: {
      provider: "google",
      messageId: id,
      conversationId,
      version,
    },
    fields: {
      from: "me@example.com",
      to: ["ann@example.com"],
      cc: [],
      receivedAtMs: at,
      roles,
      subject,
      preview,
      read: true,
      starred: false,
      folderId: null,
      labelIds: [],
      categoryIds: [],
      hasAttachments: false,
    },
  };
}
