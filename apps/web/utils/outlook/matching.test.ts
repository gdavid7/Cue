import { describe, expect, it } from "vitest";
import {
  keepMatchingOutlookMessage,
  outlookMatchingRequest,
} from "@/utils/outlook/matching";

describe("outlookMatchingRequest", () => {
  it("lists a well-known folder's messages for a view type", () => {
    expect(outlookMatchingRequest({}, {})).toEqual({
      kind: "list",
      endpoint: "/me/mailFolders/inbox/messages",
      filter: undefined,
    });
    expect(outlookMatchingRequest({ type: "trash" }, {})).toMatchObject({
      endpoint: "/me/mailFolders/deleteditems/messages",
    });
  });

  it("lists a folder by id", () => {
    expect(outlookMatchingRequest({ folderId: "AAMk/1=" }, {})).toMatchObject({
      endpoint: "/me/mailFolders/AAMk%2F1%3D/messages",
    });
  });

  it("filters read state and flags on the server for a folder view", () => {
    expect(
      outlookMatchingRequest({ type: "starred" }, { unread: true }),
    ).toEqual({
      kind: "list",
      endpoint: "/me/messages",
      filter: "flag/flagStatus eq 'flagged' and isRead eq false",
    });
    expect(
      outlookMatchingRequest({ type: "unread" }, { unread: false }).filter,
    ).toBe("isRead eq false and isRead eq true");
  });

  it("keeps an archive to the inbox when the view spans every folder", () => {
    expect(
      outlookMatchingRequest({ type: "all" }, { inInbox: true }),
    ).toMatchObject({ endpoint: "/me/mailFolders/inbox/messages" });
    expect(
      outlookMatchingRequest({ q: "invoice" }, { inInbox: true }),
    ).toMatchObject({ kind: "search", folderKey: "inbox" });
  });

  it("searches the whole mailbox for a search scope", () => {
    expect(outlookMatchingRequest({ q: "invoice" }, {})).toEqual({
      kind: "search",
      query: "invoice",
      folderKey: undefined,
    });
  });

  it("does not support category views", () => {
    expect(outlookMatchingRequest({ labelId: "Blue" }, {})).toEqual({
      kind: "unsupported",
    });
  });
});

describe("keepMatchingOutlookMessage", () => {
  it("filters read state locally where a search cannot", () => {
    const unread = { id: "1", conversationId: "c", isRead: false };
    const read = { id: "2", conversationId: "c", isRead: true };
    expect(keepMatchingOutlookMessage(unread, { unread: true })).toBe(true);
    expect(keepMatchingOutlookMessage(read, { unread: true })).toBe(false);
    expect(keepMatchingOutlookMessage(read, { unread: false })).toBe(true);
    expect(keepMatchingOutlookMessage(read, {})).toBe(true);
    expect(keepMatchingOutlookMessage({ id: "3", isRead: false }, {})).toBe(
      false,
    );
  });
});
