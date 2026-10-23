import { describe, expect, it } from "vitest";
import { type MailPredicate, mailPredicateSchema } from "./queries";
import {
  conversationMatchesAfterChange,
  conversationMatchesPredicate,
  type EffectiveMessage,
  resolveSearchPredicates,
} from "./query-semantics";

describe("conversation predicates", () => {
  const named: Extract<MailPredicate, { kind: "conversation" }> = {
    kind: "conversation",
    ids: ["c-1"],
  };
  const conversation = [
    message({ messageId: "m-1", conversationId: "c-1", roles: ["inbox"] }),
    message({ messageId: "m-2", conversationId: "c-1", roles: ["inbox"] }),
  ];

  it("matches every message of a named conversation, so its inverse matches none", () => {
    expect(conversationMatchesPredicate(conversation, named)).toBe(true);
    expect(
      conversationMatchesPredicate(conversation, {
        kind: "not",
        predicate: named,
      }),
    ).toBe(false);
  });

  it("is accepted by the query schema and scoped to its account", () => {
    expect(mailPredicateSchema.safeParse(named).success).toBe(true);
    expect(
      conversationMatchesPredicate(conversation, {
        ...named,
        accountId: "someone-else",
      }),
    ).toBe(false);
  });
});

describe("mailbox predicates", () => {
  it("treats archive as a conversation with no inbox, trash, or spam members", () => {
    expect(
      conversationMatchesPredicate(
        [message({ roles: ["sent"] }), message({ roles: [] })],
        { kind: "mailbox", mailbox: "archive" },
      ),
    ).toBe(true);
    expect(
      conversationMatchesPredicate(
        [message({ roles: ["inbox"] }), message({ roles: ["sent"] })],
        { kind: "mailbox", mailbox: "archive" },
      ),
    ).toBe(false);
  });

  it("keeps a conversation out of all mail when any message is trash or spam", () => {
    expect(
      conversationMatchesPredicate(
        [message({ roles: ["inbox"] }), message({ roles: ["trash"] })],
        { kind: "mailbox", mailbox: "all" },
      ),
    ).toBe(false);
    expect(
      conversationMatchesPredicate(
        [message({ roles: ["inbox"] }), message({ roles: ["sent"] })],
        { kind: "mailbox", mailbox: "all" },
      ),
    ).toBe(true);
  });

  it("matches provider draft-role messages, not local composition drafts", () => {
    expect(
      conversationMatchesPredicate([message({ roles: ["draft"] })], {
        kind: "mailbox",
        mailbox: "drafts",
      }),
    ).toBe(true);
  });

  it("keeps a conversation in drafts only through drafts that aren't excluded", () => {
    const withoutSending = {
      kind: "all",
      predicates: [
        { kind: "mailbox", mailbox: "drafts" },
        { kind: "not", predicate: { kind: "message", ids: ["d-sending"] } },
      ],
    } as const;
    expect(
      conversationMatchesPredicate(
        [
          message({ messageId: "m-1", roles: ["inbox"] }),
          message({ messageId: "d-sending", roles: ["draft"] }),
        ],
        withoutSending,
      ),
    ).toBe(false);
    expect(
      conversationMatchesPredicate(
        [
          message({ messageId: "d-sending", roles: ["draft"] }),
          message({ messageId: "d-kept", roles: ["draft"] }),
        ],
        withoutSending,
      ),
    ).toBe(true);
  });

  it("matches snoozed mail until the timestamp elapses", () => {
    expect(
      conversationMatchesPredicate(
        [message({ roles: ["inbox"], snoozedUntilMs: Date.now() + 60_000 })],
        { kind: "mailbox", mailbox: "snoozed" },
      ),
    ).toBe(true);
    expect(
      conversationMatchesPredicate(
        [message({ roles: ["inbox"], snoozedUntilMs: Date.now() - 1 })],
        { kind: "mailbox", mailbox: "snoozed" },
      ),
    ).toBe(false);
  });
});

describe("conversationMatchesAfterChange", () => {
  const inbox: MailPredicate = { kind: "mailbox", mailbox: "inbox" };
  const unread: MailPredicate = {
    kind: "all",
    predicates: [inbox, { kind: "read", value: false }],
  };
  const label: MailPredicate = {
    kind: "membership",
    membership: "label",
    id: "Label_1",
  };

  it("knows an archived conversation leaves the inbox", () => {
    expect(
      conversationMatchesAfterChange(inbox, { kind: "archive" }, "google"),
    ).toBe(false);
    expect(
      conversationMatchesAfterChange(
        { kind: "role", role: "inbox" },
        { kind: "archive" },
        "google",
      ),
    ).toBe(false);
  });

  it("cannot tell whether an archived conversation stays in a label", () => {
    expect(
      conversationMatchesAfterChange(label, { kind: "archive" }, "google"),
    ).toBe(null);
    expect(
      conversationMatchesAfterChange(
        { kind: "mailbox", mailbox: "archive" },
        { kind: "archive" },
        "google",
      ),
    ).toBe(null);
  });

  it("knows a conversation marked read leaves an unread view but not the inbox", () => {
    expect(
      conversationMatchesAfterChange(
        unread,
        { kind: "set_read", read: true },
        "google",
      ),
    ).toBe(false);
    expect(
      conversationMatchesAfterChange(
        inbox,
        { kind: "set_read", read: true },
        "google",
      ),
    ).toBe(null);
  });

  it("follows starring in and out of the starred mailbox", () => {
    const starred: MailPredicate = { kind: "mailbox", mailbox: "starred" };
    expect(
      conversationMatchesAfterChange(
        starred,
        {
          kind: "set_starred",
          starred: false,
        },
        "google",
      ),
    ).toBe(false);
    expect(
      conversationMatchesAfterChange(
        starred,
        {
          kind: "set_starred",
          starred: true,
        },
        "google",
      ),
    ).toBe(true);
  });

  it("knows trash leaves every mailbox but trash", () => {
    expect(
      conversationMatchesAfterChange(label, { kind: "trash" }, "google"),
    ).toBe(null);
    expect(
      conversationMatchesAfterChange(
        { kind: "mailbox", mailbox: "all" },
        { kind: "trash" },
        "google",
      ),
    ).toBe(false);
    expect(
      conversationMatchesAfterChange(
        { kind: "mailbox", mailbox: "trash" },
        { kind: "trash" },
        "google",
      ),
    ).toBe(true);
  });

  it("leaves fields no change touches unknown", () => {
    const fromAda: MailPredicate = {
      kind: "address",
      field: "from",
      value: "ada@example.com",
      match: "address",
    };
    expect(
      conversationMatchesAfterChange(
        { kind: "all", predicates: [inbox, fromAda] },
        { kind: "archive" },
        "google",
      ),
    ).toBe(false);
    expect(
      conversationMatchesAfterChange(
        { kind: "any", predicates: [inbox, fromAda] },
        { kind: "archive" },
        "google",
      ),
    ).toBe(null);
    expect(
      conversationMatchesAfterChange(
        { kind: "not", predicate: inbox },
        { kind: "archive" },
        "google",
      ),
    ).toBe(true);
  });
});

describe("typed searches", () => {
  const inbox: MailPredicate = { kind: "mailbox", mailbox: "inbox" };
  const words: MailPredicate = {
    kind: "text",
    field: "any",
    value: "invoice",
    match: "term",
  };
  const search = (
    local: MailPredicate,
    possible: MailPredicate = { kind: "all", predicates: [] },
  ): Extract<MailPredicate, { kind: "search" }> => ({
    kind: "search",
    query: "q",
    local,
    possible,
  });

  it("splices a search without provider matches into its parent", () => {
    expect(
      resolveSearchPredicates(
        {
          kind: "all",
          predicates: [
            search({ kind: "all", predicates: [words, inbox] }),
            { kind: "mailbox", mailbox: "all" },
          ],
        },
        () => [],
      ),
    ).toEqual({
      kind: "all",
      predicates: [words, inbox, { kind: "mailbox", mailbox: "all" }],
    });
  });

  it("lists each account's provider matches apart, under the search's possible part", () => {
    expect(
      resolveSearchPredicates(search(words, inbox), () => [
        { accountId: "a", messageIds: ["m1"] },
        { accountId: "b", messageIds: [] },
        { accountId: "c", messageIds: ["m1", "m2"] },
      ]),
    ).toEqual({
      kind: "any",
      predicates: [
        words,
        {
          kind: "all",
          predicates: [
            inbox,
            {
              kind: "any",
              predicates: [
                { kind: "message", accountId: "a", ids: ["m1"] },
                { kind: "message", accountId: "c", ids: ["m1", "m2"] },
              ],
            },
          ],
        },
      ],
    });
  });

  it("keeps every account's matches when there are more accounts than an any holds", () => {
    const accounts = Array.from({ length: 50 }, (_, index) => `acc-${index}`);
    const resolved = resolveSearchPredicates(search(words), () =>
      accounts.map((accountId) => ({ accountId, messageIds: ["m"] })),
    );
    expect(mailPredicateSchema.safeParse(resolved).success).toBe(true);
    const listed = JSON.stringify(resolved);
    for (const accountId of accounts)
      expect(listed).toContain(`"accountId":"${accountId}"`);
  });

  it("matches a provider match only in its own account", () => {
    const resolved = resolveSearchPredicates(search(words), () => [
      { accountId: "a", messageIds: ["m1"] },
    ]);
    expect(
      conversationMatchesPredicate(
        [message({ accountId: "a", roles: ["inbox"] })],
        resolved,
      ),
    ).toBe(true);
    expect(
      conversationMatchesPredicate(
        [message({ accountId: "b", roles: ["inbox"] })],
        resolved,
      ),
    ).toBe(false);
  });

  it("drops a provider match once a change rules out the whole query", () => {
    // Archiving under in:inbox.
    expect(
      conversationMatchesAfterChange(
        search(FALSE, inbox),
        { kind: "archive" },
        "google",
      ),
    ).toBe(false);
    // The provider may still match it on what the change leaves alone.
    expect(
      conversationMatchesAfterChange(
        search(FALSE, TRUE),
        { kind: "archive" },
        "google",
      ),
    ).toBe(null);
    const starred: MailPredicate = { kind: "mailbox", mailbox: "starred" };
    expect(
      conversationMatchesAfterChange(
        search(starred, starred),
        {
          kind: "set_starred",
          starred: true,
        },
        "google",
      ),
    ).toBe(true);
  });
});

const FALSE: MailPredicate = { kind: "any", predicates: [] };
const TRUE: MailPredicate = { kind: "all", predicates: [] };

function message(
  fields: Partial<EffectiveMessage> & { roles: EffectiveMessage["roles"] },
): EffectiveMessage {
  return {
    accountId: "acc-1",
    messageId: "m1",
    conversationId: "c1",
    subject: "Subject",
    preview: "Preview",
    from: "ada@example.com",
    to: ["me@example.com"],
    cc: [],
    receivedAtMs: 1,
    read: false,
    starred: false,
    folderId: "inbox",
    inboxSection: null,
    labelIds: [],
    categoryIds: [],
    hasAttachments: false,
    pendingOperationIds: [],
    ...fields,
  };
}
