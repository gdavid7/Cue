import { describe, expect, it } from "vitest";
import type {
  ConversationSummary,
  MailPredicate,
} from "@inboxzero/mail-core/queries";
import { applyOptimisticTriage } from "./optimistic-triage";

const inbox: MailPredicate = { kind: "mailbox", mailbox: "inbox" };
const GMAIL = new Map([["acc-1", "google" as const]]);
const label: MailPredicate = {
  kind: "membership",
  membership: "label",
  id: "Label_1",
};

describe("applyOptimisticTriage", () => {
  const rows = [summary("one"), summary("two"), summary("three")];

  it("hands back the engine's own list while nothing is pending", () => {
    expect(applyOptimisticTriage(rows, inbox, [], GMAIL)).toBe(rows);
  });

  it("drops an archived conversation from the inbox at once", () => {
    const shown = applyOptimisticTriage(
      rows,
      inbox,
      [entry(["two"], { kind: "archive" })],
      GMAIL,
    );

    expect(shown.map((row) => row.key.conversationId)).toEqual([
      "one",
      "three",
    ]);
    expect(shown[0]).toBe(rows[0]);
  });

  it("keeps an archived conversation in a view the change cannot decide", () => {
    const shown = applyOptimisticTriage(
      rows,
      label,
      [entry(["two"], { kind: "archive" })],
      GMAIL,
    );

    expect(shown.map((row) => row.key.conversationId)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("shows read and star changes on the row", () => {
    const shown = applyOptimisticTriage(
      rows,
      inbox,
      [
        entry(["one"], { kind: "set_read", read: true }),
        entry(["one", "three"], { kind: "set_starred", starred: true }),
      ],
      GMAIL,
    );

    expect(shown[0]).toMatchObject({ unread: false, starred: true });
    expect(shown[1]).toBe(rows[1]);
    expect(shown[2]).toMatchObject({ unread: true, starred: true });
  });

  it("only touches the account the change was made in", () => {
    const shown = applyOptimisticTriage(
      rows,
      inbox,
      [{ ...entry(["one"], { kind: "archive" }), accountId: "other" }],
      GMAIL,
    );

    expect(shown).toHaveLength(3);
  });

  it("keeps an Outlook conversation in Sent and Drafts when it is deleted", () => {
    const outlook = new Map([["acc-1", "microsoft" as const]]);
    for (const mailbox of ["sent", "drafts"] as const) {
      const shown = applyOptimisticTriage(
        rows,
        { kind: "mailbox", mailbox },
        [entry(["two"], { kind: "trash" })],
        outlook,
      );

      expect(shown.map((row) => row.key.conversationId)).toContain("two");
    }
  });

  it("leaves Sent to the engine while the account's provider is not known", () => {
    const shown = applyOptimisticTriage(
      rows,
      { kind: "mailbox", mailbox: "sent" },
      [entry(["two"], { kind: "trash" })],
      new Map(),
    );

    expect(shown.map((row) => row.key.conversationId)).toContain("two");
  });

  it("drops a Gmail conversation from Sent at once when it is deleted", () => {
    const shown = applyOptimisticTriage(
      rows,
      { kind: "mailbox", mailbox: "sent" },
      [entry(["two"], { kind: "trash" })],
      new Map([["acc-1", "google" as const]]),
    );

    expect(shown.map((row) => row.key.conversationId)).not.toContain("two");
  });

  it("follows the latest of several changes to one conversation", () => {
    const shown = applyOptimisticTriage(
      rows,
      inbox,
      [
        entry(["one"], { kind: "archive" }),
        entry(["one"], { kind: "unarchive" }),
      ],
      GMAIL,
    );

    expect(shown.map((row) => row.key.conversationId)).toContain("one");
  });
});

function entry(
  conversationIds: string[],
  change: Parameters<typeof applyOptimisticTriage>[2][number]["change"],
) {
  return {
    id: 1,
    accountId: "acc-1",
    conversationIds: new Set(conversationIds),
    change,
  };
}

function summary(conversationId: string): ConversationSummary {
  return {
    key: { accountId: "acc-1", conversationId },
    subject: conversationId,
    preview: "",
    from: "ada@example.com",
    to: "me@example.com",
    senders: ["ada@example.com"],
    latestMessageAtMs: 1,
    unread: true,
    starred: false,
    labelIds: ["INBOX"],
    roles: ["inbox"],
    pendingOperationIds: [],
  };
}
