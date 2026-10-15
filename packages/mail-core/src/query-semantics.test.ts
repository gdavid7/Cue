import { describe, expect, it } from "vitest";
import type { MailPredicate } from "./queries";
import {
  conversationMatchesAfterChange,
  conversationMatchesPredicate,
  type EffectiveMessage,
} from "./query-semantics";

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
