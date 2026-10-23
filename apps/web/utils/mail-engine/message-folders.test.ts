import { describe, expect, it, vi } from "vitest";
import type { MailClient } from "@inboxzero/mail-core/engine";
import { moveBackChanges, readMessageFolders } from "./message-folders";

describe("readMessageFolders", () => {
  it("reads every page of a long conversation once the engine has it", async () => {
    const pages: Record<string, { ids: string[]; next: string | null }> = {
      first: { ids: ["m1", "m2"], next: "p2" },
      p2: { ids: ["m3"], next: null },
    };
    const observeConversation = vi.fn(
      (_key: unknown, page: { after: string | null }) => {
        const { ids, next } = pages[page.after ?? "first"];
        let ready = false;
        return {
          // Loading until the store answers, as a fresh query is.
          getSnapshot: () => ({
            status: ready ? "ready" : "loading",
            revision: null,
            refreshing: false,
            error: null,
            data: ready
              ? {
                  messages: ids.map((messageId) => ({
                    key: { accountId: "acc", messageId },
                    metadata: {
                      folderId: `${messageId}-folder`,
                      roles: messageId === "m1" ? ["inbox"] : [],
                    },
                  })),
                  nextPage: next,
                }
              : null,
          }),
          subscribe: (listener: () => void) => {
            queueMicrotask(() => {
              ready = true;
              listener();
            });
            return () => {};
          },
          close: vi.fn(),
        };
      },
    );

    const folders = await readMessageFolders(
      {
        observeConversation,
        ensureConversationMessages: async () => ({ status: "complete" }),
      } as unknown as MailClient,
      { accountId: "acc", conversationId: "c1" },
    );

    expect(folders).toEqual([
      { messageId: "m1", folderId: "m1-folder", inbox: true },
      { messageId: "m2", folderId: "m2-folder", inbox: false },
      { messageId: "m3", folderId: "m3-folder", inbox: false },
    ]);
  });
});

describe("moveBackChanges", () => {
  it("returns inbox mail to the inbox and the rest to their own folders", () => {
    expect(
      moveBackChanges(
        [
          { messageId: "a", folderId: "inbox-id", inbox: true },
          { messageId: "b", folderId: "sent", inbox: false },
          { messageId: "c", folderId: "sent", inbox: false },
          { messageId: "d", folderId: "dest", inbox: false },
        ],
        "dest",
      ),
    ).toEqual([
      { change: { kind: "unarchive" }, messageIds: ["a"] },
      { change: { kind: "move", folderId: "sent" }, messageIds: ["b", "c"] },
    ]);
  });

  it("sends messages moved without being seen where most of the conversation came from", () => {
    expect(
      moveBackChanges(
        [
          { messageId: "a", folderId: "receipts", inbox: false },
          { messageId: "b", folderId: "receipts", inbox: false },
          { messageId: "c", folderId: "inbox-id", inbox: true },
        ],
        "dest",
        [
          { messageId: "a", folderId: "dest", inbox: false },
          { messageId: "late", folderId: "dest", inbox: false },
          { messageId: "elsewhere", folderId: "other", inbox: false },
        ],
      ),
    ).toEqual([
      {
        change: { kind: "move", folderId: "receipts" },
        messageIds: ["a", "b", "late"],
      },
      { change: { kind: "unarchive" }, messageIds: ["c"] },
    ]);
  });
});
