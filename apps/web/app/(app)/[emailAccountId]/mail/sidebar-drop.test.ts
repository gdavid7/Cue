import { describe, expect, it } from "vitest";
import {
  type DraggedConversation,
  resolveSidebarDrop,
  type SidebarDropTarget,
} from "./sidebar-drop";

describe("resolveSidebarDrop", () => {
  it("never drops on the view the conversations are in", () => {
    expect(
      resolveSidebarDrop({
        target: { kind: "trash" },
        conversations: [conversation("a", ["INBOX"])],
        isCurrentView: true,
      }),
    ).toBeNull();
  });

  it("drops nothing when nothing is dragged", () => {
    expect(
      resolveSidebarDrop({
        target: { kind: "trash" },
        conversations: [],
        isCurrentView: false,
      }),
    ).toBeNull();
  });

  describe("Inbox", () => {
    it("moves archived conversations back to the inbox", () => {
      expect(
        resolveSidebarDrop({
          target: { kind: "inbox" },
          conversations: [conversation("a", []), conversation("b", ["INBOX"])],
          isCurrentView: false,
        }),
      ).toEqual({ kind: "move_to_inbox" });
    });

    it("restores conversations dragged out of Trash", () => {
      expect(
        resolveSidebarDrop({
          target: { kind: "inbox" },
          conversations: [conversation("a", ["TRASH"])],
          isCurrentView: false,
        }),
      ).toEqual({ kind: "restore" });
    });

    it("marks conversations dragged out of Spam as not spam", () => {
      expect(
        resolveSidebarDrop({
          target: { kind: "inbox" },
          conversations: [conversation("a", ["SPAM"])],
          isCurrentView: false,
        }),
      ).toEqual({ kind: "not_spam" });
    });

    it("refuses a mix of trashed and other mail, which no one action brings back", () => {
      expect(
        resolveSidebarDrop({
          target: { kind: "inbox" },
          conversations: [conversation("a", ["TRASH"]), conversation("b", [])],
          isCurrentView: false,
        }),
      ).toBeNull();
    });

    it("refuses mail that is already all in the inbox", () => {
      expect(
        resolveSidebarDrop({
          target: { kind: "inbox" },
          conversations: [conversation("a", ["INBOX", "Label_1"])],
          isCurrentView: false,
        }),
      ).toBeNull();
    });
  });

  describe("Archive", () => {
    it("archives inbox mail", () => {
      expect(
        resolveSidebarDrop({
          target: { kind: "archive" },
          conversations: [conversation("a", ["INBOX"]), conversation("b", [])],
          isCurrentView: false,
        }),
      ).toEqual({ kind: "archive" });
    });

    it("refuses mail with nothing in the inbox to archive", () => {
      expect(
        resolveSidebarDrop({
          target: { kind: "archive" },
          conversations: [conversation("a", ["Label_1"])],
          isCurrentView: false,
        }),
      ).toBeNull();
    });

    it("refuses trashed or spam mail, which archiving would leave where it is", () => {
      expect(
        resolveSidebarDrop({
          target: { kind: "archive" },
          conversations: [
            conversation("a", ["INBOX"]),
            conversation("b", ["SPAM"]),
          ],
          isCurrentView: false,
        }),
      ).toBeNull();
    });
  });

  it("trashes, reports spam and stars unless every conversation is already there", () => {
    const inbox = [conversation("a", ["INBOX"]), conversation("b", ["INBOX"])];
    expect(
      resolveSidebarDrop({
        target: { kind: "trash" },
        conversations: inbox,
        isCurrentView: false,
      }),
    ).toEqual({ kind: "trash" });
    expect(
      resolveSidebarDrop({
        target: { kind: "spam" },
        conversations: inbox,
        isCurrentView: false,
      }),
    ).toEqual({ kind: "spam" });
    expect(
      resolveSidebarDrop({
        target: { kind: "starred" },
        conversations: [
          conversation("a", ["INBOX", "STARRED"]),
          conversation("b", ["INBOX"]),
        ],
        isCurrentView: false,
      }),
    ).toEqual({ kind: "star" });

    expect(
      resolveSidebarDrop({
        target: { kind: "trash" },
        conversations: [conversation("a", ["TRASH"])],
        isCurrentView: false,
      }),
    ).toBeNull();
    expect(
      resolveSidebarDrop({
        target: { kind: "spam" },
        conversations: [conversation("a", ["SPAM"])],
        isCurrentView: false,
      }),
    ).toBeNull();
    expect(
      resolveSidebarDrop({
        target: { kind: "starred" },
        conversations: [conversation("a", ["INBOX", "STARRED"])],
        isCurrentView: false,
      }),
    ).toBeNull();
  });

  describe("labels", () => {
    const projectLabel: SidebarDropTarget = {
      kind: "label",
      accountId: "acc-1",
      labelId: "Label_project",
    };

    it("applies the label the way the picker does", () => {
      expect(
        resolveSidebarDrop({
          target: projectLabel,
          conversations: [conversation("a", ["INBOX"])],
          isCurrentView: false,
        }),
      ).toEqual({
        kind: "label",
        accountId: "acc-1",
        labelId: "Label_project",
      });
    });

    it("refuses when every conversation already has the label", () => {
      expect(
        resolveSidebarDrop({
          target: projectLabel,
          conversations: [conversation("a", ["INBOX", "Label_project"])],
          isCurrentView: false,
        }),
      ).toBeNull();
    });

    it("allows an All inboxes drop when every conversation's account has the label", () => {
      expect(
        resolveSidebarDrop({
          target: projectLabel,
          conversations: [
            conversation("acc-1:a", ["INBOX"], "acc-1"),
            conversation("acc-1:b", ["INBOX"], "acc-1"),
          ],
          isCurrentView: false,
        }),
      ).toEqual({
        kind: "label",
        accountId: "acc-1",
        labelId: "Label_project",
      });
    });

    it("refuses an All inboxes drop when any conversation's account lacks the label", () => {
      expect(
        resolveSidebarDrop({
          target: projectLabel,
          conversations: [
            conversation("acc-1:a", ["INBOX"], "acc-1"),
            conversation("acc-2:b", ["INBOX"], "acc-2"),
          ],
          isCurrentView: false,
        }),
      ).toBeNull();
    });

    it("still allows system targets for conversations from several accounts", () => {
      expect(
        resolveSidebarDrop({
          target: { kind: "starred" },
          conversations: [
            conversation("acc-1:a", ["INBOX"], "acc-1"),
            conversation("acc-2:b", ["INBOX"], "acc-2"),
          ],
          isCurrentView: false,
        }),
      ).toEqual({ kind: "star" });
    });
  });

  it("refuses Outlook folders, which have no move the picker offers", () => {
    expect(
      resolveSidebarDrop({
        target: { kind: "folder" },
        conversations: [conversation("a", ["INBOX"])],
        isCurrentView: false,
      }),
    ).toBeNull();
  });
});

function conversation(
  key: string,
  labelIds: string[],
  accountId = "acc-1",
): DraggedConversation {
  return { key, threadId: key, accountId, messages: [{ labelIds }] };
}
