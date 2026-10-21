import { describe, expect, it } from "vitest";
import type {
  ConversationSummary,
  Coverage,
  MailboxView,
} from "@inboxzero/mail-core/queries";
import { localInboxRows } from "./use-local-inbox-rows";

const ADA = { id: "account-a", email: "ada@example.com" };
const BOB = { id: "account-b", email: "bob@example.com" };

describe("localInboxRows", () => {
  it("shows a conversation as Today's row, named for who it is with", () => {
    const rows = localInboxRows(
      view([
        conversation("t1", {
          subject: "Re: Re: Fwd: Quarterly numbers",
          senders: [
            "Grace Hopper <grace@example.com>",
            "Ada <ada@example.com>",
          ],
          unread: true,
        }),
      ]),
      { accounts: [ADA], named: false },
    );

    expect(rows).toEqual([
      {
        threadId: "t1",
        fromName: "Grace Hopper",
        fromEmail: "grace@example.com",
        subject: "Quarterly numbers",
        preview: "Can you take a look?",
        at: "2026-10-20T09:00:00.000Z",
        priority: "medium",
        unread: true,
        messageId: "t1-latest",
        starred: false,
        inInbox: true,
      },
    ]);
  });

  it("names the recipient when only the user has written", () => {
    const [row] =
      localInboxRows(
        view([
          conversation("t1", {
            senders: ["Ada <ada@example.com>"],
            to: "Lin Chen <lin@example.com>, kim@example.com",
          }),
        ]),
        { accounts: [ADA], named: false },
      ) ?? [];

    expect(row).toMatchObject({
      fromName: "Lin Chen",
      fromEmail: "lin@example.com",
    });
  });

  it("never shows another mailbox's rows", () => {
    const rows = localInboxRows(
      view(
        [conversation("t1"), conversation("t2", { accountId: BOB.id })],
        [ADA.id, BOB.id],
      ),
      { accounts: [ADA], named: false },
    );

    expect(rows?.map((row) => row.threadId)).toEqual(["t1"]);
  });

  it("across accounts names each row's account", () => {
    const rows = localInboxRows(
      view(
        [conversation("t1"), conversation("t2", { accountId: BOB.id })],
        [ADA.id, BOB.id],
      ),
      { accounts: [ADA, BOB], named: true },
    );

    expect(rows?.map((row) => row.account)).toEqual([ADA, BOB]);
  });

  it("leaves out a conversation that is only a draft", () => {
    const rows = localInboxRows(
      view([conversation("t1", { latestMessageId: null })]),
      { accounts: [ADA], named: false },
    );

    expect(rows).toEqual([]);
  });

  it("can't answer before every account's first sync finishes", () => {
    const rows = localInboxRows(view([conversation("t1")], [ADA.id]), {
      accounts: [ADA, BOB],
      named: true,
    });

    expect(rows).toBeNull();
  });

  it("can't answer while the provider can't be reached", () => {
    const rows = localInboxRows(
      { ...view([conversation("t1")]), connection: "blocked_auth" },
      { accounts: [ADA], named: false },
    );

    expect(rows).toBeNull();
  });
});

function view(
  conversations: ConversationSummary[],
  syncedAccountIds = [ADA.id],
): MailboxView {
  return {
    conversations,
    counts: {
      matchingConversations: conversations.length,
      unreadConversations: 0,
      extent: "local_coverage",
    },
    nextPage: null,
    coverage: syncedAccountIds.map(
      (accountId): Coverage => ({
        accountId,
        scopeId: "primary",
        metadata: "complete",
        content: "not_requested",
        indexedContent: "not_requested",
        lastCompletedSyncAtMs: 1,
      }),
    ),
    connection: "ready",
  };
}

function conversation(
  conversationId: string,
  {
    accountId = ADA.id,
    subject = "Quarterly numbers",
    senders = ["Grace Hopper <grace@example.com>"],
    to = "ada@example.com",
    unread = false,
    latestMessageId = `${conversationId}-latest`,
  }: {
    accountId?: string;
    subject?: string;
    senders?: string[];
    to?: string;
    unread?: boolean;
    latestMessageId?: string | null;
  } = {},
): ConversationSummary {
  return {
    key: { accountId, conversationId },
    subject,
    preview: "Can you take a look?",
    from: senders.at(-1) ?? "",
    to,
    senders,
    latestMessageAtMs: Date.parse("2026-10-20T09:00:00.000Z"),
    unread,
    starred: false,
    labelIds: [],
    roles: ["inbox"],
    pendingOperationIds: [],
    ...(latestMessageId ? { latestMessageId } : {}),
  };
}
