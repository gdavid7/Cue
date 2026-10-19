import { describe, expect, it, vi } from "vitest";
import {
  createHostRuntime,
  createMailEngine,
} from "@inboxzero/mail-core/engine";
import type { MailboxSource } from "@inboxzero/mail-core/ports/mailbox-source";
import type { OperationExecutor } from "@inboxzero/mail-core/ports/operation-executor";
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

  it("keeps an archive it confirmed over a late copy at the same version", async () => {
    const { engine, store } = await startEngine({
      // Gmail confirms the archive without returning the message.
      async execute({ operation }) {
        return {
          status: "confirmed",
          receiptId: "r1",
          observations: [],
          targets: operation.intent.targets.map((key) => ({
            key,
            outcome: "applied" as const,
            code: null,
          })),
        };
      },
    });
    const inbox = observeInbox(engine);
    const preview = messagePatch({
      messageId: "m1",
      conversationId: "c1",
      version: "5",
    });
    await engine.ingestMessages?.({ accountId: "acc-1", changes: [preview] });
    await vi.waitFor(() => expect(conversationIds(inbox)).toEqual(["c1"]));

    await engine.submitMetadata({
      accountId: "acc-1",
      commandId: "op-archive",
      targets: [{ accountId: "acc-1", messageId: "m1" }],
      change: { kind: "archive" },
    });
    await engine.runUntil(Date.now() + 1000);
    expect((await store.getDiagnostics("acc-1")).commands).toEqual([
      expect.objectContaining({ status: "succeeded" }),
    ]);

    // The server's preview, read before the archive, resolves late.
    await engine.ingestMessages?.({ accountId: "acc-1", changes: [preview] });

    const view = await store.readMailboxView({
      accountIds: ["acc-1"],
      predicate: { kind: "role", role: "inbox" },
      order: "newest_first",
      pageSize: 25,
      after: null,
    });
    expect(view.view.counts.matchingConversations).toBe(0);
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

async function startEngine(
  executor: Pick<OperationExecutor, "execute"> = {
    async execute() {
      return { status: "uncertain", receiptId: null };
    },
  },
) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId: "acc-1",
    provider: "google",
    generation: "g1",
  });
  const engine = createMailEngine({
    store,
    source: unavailableSource,
    executor: {
      ...executor,
      async inspect(input) {
        return executor.execute({ ...input, attemptId: "inspect" });
      },
    },
    runtime: createHostRuntime(),
  });
  return { engine, store };
}

// Nothing syncs here: these cases are about what the host hands in.
const unavailable = {
  status: "paused",
  retryAfterMs: 60_000,
  reason: "unavailable",
} as const;
const unavailableSource: MailboxSource = {
  async describe() {
    return {
      status: "ok",
      value: {
        strategy: "account_history",
        supportedChanges: ["archive"],
        maxPageSize: 50,
        maxHydrationBatch: 20,
      },
    };
  },
  async discoverScopes() {
    return { status: "ok", value: { scopes: [], nextPage: null } };
  },
  async beginBootstrap() {
    return unavailable;
  },
  async enumerate() {
    return unavailable;
  },
  async readChanges() {
    return unavailable;
  },
  async hydrate() {
    return unavailable;
  },
  async readConversationMembership() {
    return unavailable;
  },
} as unknown as MailboxSource;

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
