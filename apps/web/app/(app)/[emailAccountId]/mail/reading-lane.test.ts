import { describe, expect, it } from "vitest";
import {
  type EffectiveMessage,
  messageMatchesPredicate,
} from "@inboxzero/mail-core/query-semantics";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import { threadsQueryToPredicate } from "@/utils/mail-engine/threads-query";
import { threadsQuery } from "@/utils/threads/validation";
import {
  findReadingLabelId,
  getReadingSummary,
  inboxWithoutReadingQuery,
  readingLaneQuery,
} from "./reading-lane";

const NEWSLETTER = "Label_42";

describe("findReadingLabelId", () => {
  it("finds the label Cue files newsletters under, as named in the mailbox", () => {
    expect(
      findReadingLabelId([
        { id: "Label_1", name: "Receipt" },
        { id: NEWSLETTER, name: " newsletter " },
      ]),
    ).toBe(NEWSLETTER);
  });

  it("is undefined when the account has no such label", () => {
    expect(findReadingLabelId([{ id: "Label_1", name: "Receipt" }])).toBe(
      undefined,
    );
  });
});

describe("the inbox and its Reading lane", () => {
  const inbox = threadsQueryToPredicate(
    threadsQuery.parse(inboxWithoutReadingQuery(NEWSLETTER)),
  );
  const lane = threadsQueryToPredicate(
    threadsQuery.parse(readingLaneQuery(NEWSLETTER)),
  );
  const shownIn = (fields: Partial<EffectiveMessage>) => {
    const msg = message(fields);
    return {
      inbox: messageMatchesPredicate(msg, inbox),
      lane: messageMatchesPredicate(msg, lane),
    };
  };

  it("shows a newsletter in the inbox only in Reading", () => {
    expect(shownIn({ roles: ["inbox"], labelIds: [NEWSLETTER] })).toEqual({
      inbox: false,
      lane: true,
    });
  });

  it("keeps a newsletter in Reading once it's read, so reading through doesn't lose its place", () => {
    expect(
      shownIn({ roles: ["inbox"], labelIds: [NEWSLETTER], read: true }),
    ).toEqual({ inbox: false, lane: true });
  });

  it("leaves other inbox mail in the inbox", () => {
    expect(shownIn({ roles: ["inbox"], labelIds: ["Label_1"] })).toEqual({
      inbox: true,
      lane: false,
    });
  });

  it("lets an archived newsletter leave both", () => {
    expect(shownIn({ roles: [], labelIds: [NEWSLETTER] })).toEqual({
      inbox: false,
      lane: false,
    });
  });
});

describe("getReadingSummary", () => {
  it("names who the newsletters are from, newest first, and counts the unread ones", () => {
    expect(
      getReadingSummary(
        [
          thread("Field Notes <hello@fieldnotes.example>", true),
          thread("Morning Brew <crew@morningbrew.example>", false),
          thread("Field Notes <hello@fieldnotes.example>", true),
        ],
        "me@example.com",
      ),
    ).toEqual({ senders: "Field Notes and Morning Brew", unreadCount: 2 });
  });
});

function message(fields: Partial<EffectiveMessage>): EffectiveMessage {
  return {
    accountId: "acc-1",
    messageId: "m1",
    conversationId: "c1",
    subject: "Subject",
    preview: "Preview",
    from: "news@example.com",
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
    roles: [],
    ...fields,
  };
}

function thread(from: string, unread: boolean): ListThread {
  return {
    id: from,
    snippet: "",
    messages: [
      {
        id: `${from}-1`,
        threadId: from,
        labelIds: unread ? ["INBOX", "UNREAD"] : ["INBOX"],
        headers: { from, to: "me@example.com", subject: "", date: "" },
      },
    ],
  } as unknown as ListThread;
}
