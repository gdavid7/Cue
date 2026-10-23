import { describe, expect, it } from "vitest";
import { type MailPredicate, mailPredicateSchema } from "./queries";
import {
  conversationMatchesAfterChange,
  conversationMatchesPredicate,
  type EffectiveMessage,
  resolveSearchPredicates,
} from "./query-semantics";

describe("internet_message_id predicates", () => {
  const key = (
    messageId: string,
    internetMessageId: string,
    receivedAtMs: number,
    roles: EffectiveMessage["roles"] = ["inbox"],
  ) => message({ messageId, internetMessageId, receivedAtMs, roles });

  it("matches a conversation by its key, as summaries give it, in the account named", () => {
    const conversation = [key("m1", "<Shared@Example.com>", 1)];
    expect(
      conversationMatchesPredicate(conversation, {
        kind: "internet_message_id",
        ids: ["shared@example.com"],
      }),
    ).toBe(true);
    expect(
      conversationMatchesPredicate(conversation, {
        kind: "internet_message_id",
        ids: ["shared@example.com"],
        accountId: "elsewhere",
      }),
    ).toBe(false);
  });

  it("follows the key when the user replies, but not for a newer draft or trash", () => {
    const received = key("m1", "<shared@example.com>", 1);
    const draft = key("m2", "<draft@example.com>", 2, ["draft"]);
    const trashed = key("m3", "<gone@example.com>", 3, ["trash"]);
    const reply = key("m4", "<reply@example.com>", 4, ["sent"]);
    const ids = (conversation: EffectiveMessage[]) =>
      ["shared@example.com", "reply@example.com"].filter((id) =>
        conversationMatchesPredicate(conversation, {
          kind: "internet_message_id",
          ids: [id],
        }),
      );
    expect(ids([received, draft, trashed])).toEqual(["shared@example.com"]);
    expect(ids([received, draft, trashed, reply])).toEqual([
      "reply@example.com",
    ]);
  });

  it("compares keys as stored, so a key normalised once still matches", () => {
    // Normalising strips one pair of brackets; the stored key keeps the rest.
    const conversation = [key("m1", "<<a@b>>", 1)];
    const matches = (id: string) =>
      conversationMatchesPredicate(conversation, {
        kind: "internet_message_id",
        ids: [id],
      });
    expect(matches("<a@b>")).toBe(true);
    expect(matches("a@b")).toBe(false);
  });

  it("is a predicate the query schema accepts", () => {
    expect(
      mailPredicateSchema.safeParse({
        kind: "internet_message_id",
        ids: ["<a@b>"],
        accountId: "account",
      }).success,
    ).toBe(true);
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
    expect(conversationMatchesAfterChange(inbox, { kind: "archive" })).toBe(
      false,
    );
    expect(
      conversationMatchesAfterChange(
        { kind: "role", role: "inbox" },
        { kind: "archive" },
      ),
    ).toBe(false);
  });

  it("cannot tell whether an archived conversation stays in a label", () => {
    expect(conversationMatchesAfterChange(label, { kind: "archive" })).toBe(
      null,
    );
    expect(
      conversationMatchesAfterChange(
        { kind: "mailbox", mailbox: "archive" },
        { kind: "archive" },
      ),
    ).toBe(null);
  });

  it("knows a conversation marked read leaves an unread view but not the inbox", () => {
    expect(
      conversationMatchesAfterChange(unread, { kind: "set_read", read: true }),
    ).toBe(false);
    expect(
      conversationMatchesAfterChange(inbox, { kind: "set_read", read: true }),
    ).toBe(null);
  });

  it("follows starring in and out of the starred mailbox", () => {
    const starred: MailPredicate = { kind: "mailbox", mailbox: "starred" };
    expect(
      conversationMatchesAfterChange(starred, {
        kind: "set_starred",
        starred: false,
      }),
    ).toBe(false);
    expect(
      conversationMatchesAfterChange(starred, {
        kind: "set_starred",
        starred: true,
      }),
    ).toBe(true);
  });

  it("knows trash leaves every mailbox but trash", () => {
    expect(conversationMatchesAfterChange(label, { kind: "trash" })).toBe(null);
    expect(
      conversationMatchesAfterChange(
        { kind: "mailbox", mailbox: "all" },
        { kind: "trash" },
      ),
    ).toBe(false);
    expect(
      conversationMatchesAfterChange(
        { kind: "mailbox", mailbox: "trash" },
        { kind: "trash" },
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
      ),
    ).toBe(false);
    expect(
      conversationMatchesAfterChange(
        { kind: "any", predicates: [inbox, fromAda] },
        { kind: "archive" },
      ),
    ).toBe(null);
    expect(
      conversationMatchesAfterChange(
        { kind: "not", predicate: inbox },
        { kind: "archive" },
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
      conversationMatchesAfterChange(search(FALSE, inbox), { kind: "archive" }),
    ).toBe(false);
    // The provider may still match it on what the change leaves alone.
    expect(
      conversationMatchesAfterChange(search(FALSE, TRUE), { kind: "archive" }),
    ).toBe(null);
    const starred: MailPredicate = { kind: "mailbox", mailbox: "starred" };
    expect(
      conversationMatchesAfterChange(search(starred, starred), {
        kind: "set_starred",
        starred: true,
      }),
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
