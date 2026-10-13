import { describe, expect, it } from "vitest";
import type { ListThread } from "./types";
import {
  isThreadArchived,
  isThreadImportant,
  isThreadInInbox,
  isThreadOnlyIn,
  isThreadUnread,
  withThreadReadState,
} from "./read-state";

describe("thread read state", () => {
  it("is unread when any message in the thread is unread", () => {
    const thread = createThread([["INBOX", "UNREAD"], ["DRAFT"]]);

    expect(isThreadUnread(thread.messages)).toBe(true);
    expect(isThreadInInbox(thread.messages)).toBe(true);
  });

  it("is in the inbox when any message still has INBOX", () => {
    const thread = createThread([["UNREAD"], ["INBOX"]]);

    expect(isThreadInInbox(thread.messages)).toBe(true);
    expect(isThreadInInbox(createThread([["UNREAD"]]).messages)).toBe(false);
  });

  it("is archived only when no message is in the inbox, trash or spam", () => {
    expect(
      isThreadArchived(createThread([["SENT"], ["UNREAD"]]).messages),
    ).toBe(true);
    expect(isThreadArchived(createThread([["SENT"], ["INBOX"]]).messages)).toBe(
      false,
    );
    expect(isThreadArchived(createThread([["TRASH"]]).messages)).toBe(false);
    expect(isThreadArchived(createThread([["SPAM"]]).messages)).toBe(false);
    expect(isThreadArchived([])).toBe(false);
  });

  it("offers restore only when every message is in trash or spam", () => {
    expect(
      isThreadOnlyIn(
        createThread([["TRASH"], ["TRASH", "SENT"]]).messages,
        "TRASH",
      ),
    ).toBe(true);
    expect(
      isThreadOnlyIn(createThread([["TRASH"], ["INBOX"]]).messages, "TRASH"),
    ).toBe(false);
    expect(isThreadOnlyIn(createThread([["SPAM"]]).messages, "TRASH")).toBe(
      false,
    );
    expect(isThreadOnlyIn([], "SPAM")).toBe(false);
  });

  it("is important when any message is", () => {
    expect(
      isThreadImportant(createThread([["INBOX"], ["IMPORTANT"]]).messages),
    ).toBe(true);
    expect(isThreadImportant(createThread([["INBOX"]]).messages)).toBe(false);
  });

  it("removes the unread label from every message", () => {
    const thread = createThread([
      ["INBOX", "UNREAD"],
      ["SENT", "UNREAD"],
    ]);

    const updated = withThreadReadState(thread, true);

    expect(updated.messages.map((message) => message.labelIds)).toEqual([
      ["INBOX"],
      ["SENT"],
    ]);
    expect(isThreadUnread(updated.messages)).toBe(false);
  });

  it("adds the unread label without duplicates", () => {
    const thread = createThread([["INBOX", "UNREAD"], ["INBOX"]]);

    expect(
      withThreadReadState(thread, false).messages.map(
        (message) => message.labelIds,
      ),
    ).toEqual([
      ["INBOX", "UNREAD"],
      ["INBOX", "UNREAD"],
    ]);
  });

  it("preserves a thread that already has the requested state", () => {
    const thread = createThread([["INBOX"]]);

    expect(withThreadReadState(thread, true)).toBe(thread);
  });
});

function createThread(labelIdsByMessage: string[][]): ListThread {
  return {
    id: "thread",
    snippet: "snippet",
    plan: undefined,
    plans: [],
    messages: labelIdsByMessage.map((labelIds, index) => ({
      id: `message-${index}`,
      threadId: "thread",
      snippet: "snippet",
      subject: "Subject",
      date: "0",
      internalDate: "0",
      labelIds,
      headers: { subject: "Subject" },
    })),
  };
}
