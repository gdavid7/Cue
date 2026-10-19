import { describe, expect, it, vi } from "vitest";
import {
  createHostRuntime,
  createMailEngine,
} from "@inboxzero/mail-core/engine";
import type { MailboxSource } from "@inboxzero/mail-core/ports/mailbox-source";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

// A sign-in's server-rendered inbox rows reach the engine before its first
// sync, so the first rows a person sees can already be opened and triaged.
describe("engine ingesting messages the host already read", () => {
  it("shows them in the inbox before any sync", async () => {
    const { engine } = await startEngine();
    const inbox = observeInbox(engine);

    await engine.ingestMessages?.({
      accountId: "acc-1",
      changes: [
        messagePatch({ messageId: "m1", conversationId: "c1", version: "5" }),
        messagePatch({ messageId: "m2", conversationId: "c2", version: "6" }),
      ],
    });

    await vi.waitFor(() =>
      expect(conversationIds(inbox)).toEqual(
        expect.arrayContaining(["c1", "c2"]),
      ),
    );
    inbox.close();
    await engine.close();
  });

  it("keeps a newer copy of a message over the one handed in", async () => {
    const { engine } = await startEngine();
    const inbox = observeInbox(engine);
    // The sync saw the message archived after the page was rendered.
    await engine.ingestMessages?.({
      accountId: "acc-1",
      changes: [
        messagePatch({
          messageId: "m1",
          conversationId: "c1",
          version: "9",
          inInbox: false,
        }),
      ],
    });

    await engine.ingestMessages?.({
      accountId: "acc-1",
      changes: [
        messagePatch({ messageId: "m1", conversationId: "c1", version: "5" }),
      ],
    });

    await vi.waitFor(() => expect(inbox.getSnapshot().data).toBeDefined());
    expect(conversationIds(inbox)).toEqual([]);
    inbox.close();
    await engine.close();
  });

  it("ignores messages for an account it does not hold", async () => {
    const { engine } = await startEngine();
    await expect(
      engine.ingestMessages?.({
        accountId: "acc-other",
        changes: [
          {
            ...messagePatch({
              messageId: "m1",
              conversationId: "c1",
              version: "5",
            }),
            key: { accountId: "acc-other", messageId: "m1" },
          },
        ],
      }),
    ).resolves.toBeUndefined();
    await engine.close();
  });
});

async function startEngine() {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId: "acc-1",
    provider: "google",
    generation: "g1",
  });
  const engine = createMailEngine({
    store,
    source: {} as MailboxSource,
    executor: {
      async execute() {
        return { status: "uncertain", receiptId: null };
      },
      async inspect() {
        return { status: "uncertain", receiptId: null };
      },
    },
    runtime: createHostRuntime({ nowMs: () => 1000 }),
  });
  return { engine };
}

function observeInbox(engine: ReturnType<typeof createMailEngine>) {
  return engine.observeMailbox({
    accountIds: ["acc-1"],
    predicate: { kind: "role", role: "inbox" },
    order: "newest_first",
    pageSize: 25,
    after: null,
  });
}

function conversationIds(inbox: ReturnType<typeof observeInbox>) {
  return (
    inbox
      .getSnapshot()
      .data?.conversations.map((item) => item.key.conversationId) ?? []
  );
}

function messagePatch({
  messageId,
  conversationId,
  version,
  inInbox = true,
}: {
  messageId: string;
  conversationId: string;
  version: string;
  inInbox?: boolean;
}): Extract<ProviderChange, { kind: "message_patch" }> {
  return {
    kind: "message_patch",
    key: { accountId: "acc-1", messageId },
    reference: { provider: "google", messageId, conversationId, version },
    fields: {
      subject: messageId,
      preview: messageId,
      from: "ada@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs: 1000,
      read: false,
      starred: false,
      folderId: inInbox ? "inbox" : null,
      labelIds: inInbox ? ["INBOX"] : [],
      categoryIds: [],
      roles: inInbox ? ["inbox"] : [],
    },
  };
}
