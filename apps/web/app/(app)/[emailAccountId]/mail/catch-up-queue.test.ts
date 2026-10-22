import { describe, expect, it } from "vitest";
import {
  actOnCatchUp,
  type CatchUpItem,
  catchUpLeft,
  currentCatchUpItem,
  startCatchUp,
  toCatchUpItems,
  undoCatchUp,
} from "./catch-up-queue";
import type { ConversationSummary } from "@inboxzero/mail-core/queries";

describe("startCatchUp", () => {
  it("starts from the oldest conversation", () => {
    const state = startCatchUp([
      item("new", 300),
      item("old", 100),
      item("mid", 200),
    ]);
    expect(state.items.map((entry) => entry.key)).toEqual([
      "old",
      "mid",
      "new",
    ]);
    expect(currentCatchUpItem(state)?.key).toBe("old");
  });

  it("keeps the order stable for conversations from the same moment", () => {
    const state = startCatchUp([item("b", 100), item("a", 100)]);
    expect(state.items.map((entry) => entry.key)).toEqual(["a", "b"]);
  });

  it("stops after a batch of ten by default", () => {
    const state = startCatchUp(
      Array.from({ length: 25 }, (_, index) => item(`t${index}`, 1000 - index)),
    );
    expect(state.items).toHaveLength(10);
    expect(catchUpLeft(state)).toBe(10);
    // The ten oldest, not the first ten read.
    expect(state.items[0].key).toBe("t24");
    expect(state.items.at(-1)?.key).toBe("t15");
  });

  it("takes a smaller batch when asked", () => {
    const state = startCatchUp([item("a", 1), item("b", 2), item("c", 3)], {
      batchSize: 2,
    });
    expect(state.items.map((entry) => entry.key)).toEqual(["a", "b"]);
  });

  it("leaves out conversations already acted on, and fills the batch past them", () => {
    const state = startCatchUp(
      [item("a", 1), item("b", 2), item("c", 3), item("d", 4)],
      { batchSize: 2, skip: new Set(["a", "c"]) },
    );
    expect(state.items.map((entry) => entry.key)).toEqual(["b", "d"]);
  });
});

describe("actOnCatchUp", () => {
  it("moves on to the next conversation and counts down", () => {
    let state = startCatchUp([item("a", 1), item("b", 2), item("c", 3)]);
    state = actOnCatchUp(state, "a", "archive");
    expect(currentCatchUpItem(state)?.key).toBe("b");
    expect(catchUpLeft(state)).toBe(2);
    state = actOnCatchUp(state, "b", "keep");
    state = actOnCatchUp(state, "c", "snooze");
    expect(currentCatchUpItem(state)).toBeNull();
    expect(catchUpLeft(state)).toBe(0);
    expect(state.history).toEqual(["a", "b", "c"]);
  });

  it("ignores a second action on a conversation already acted on", () => {
    let state = startCatchUp([item("a", 1), item("b", 2)]);
    state = actOnCatchUp(state, "a", "archive");
    const again = actOnCatchUp(state, "a", "keep");
    expect(again).toBe(state);
    expect(again.history).toEqual(["a"]);
  });

  it("ignores a conversation that isn't in the batch", () => {
    const state = startCatchUp([item("a", 1)]);
    expect(actOnCatchUp(state, "elsewhere", "archive")).toBe(state);
  });
});

describe("undoCatchUp", () => {
  it("brings the last conversation back as the current one", () => {
    let state = startCatchUp([item("a", 1), item("b", 2), item("c", 3)]);
    state = actOnCatchUp(state, "a", "archive");
    state = actOnCatchUp(state, "b", "keep");
    const { state: undone, undone: action } = undoCatchUp(state);
    expect(action).toEqual({ key: "b", action: "keep" });
    expect(currentCatchUpItem(undone)?.key).toBe("b");
    expect(catchUpLeft(undone)).toBe(2);
  });

  it("returns to the finished batch's last conversation", () => {
    let state = startCatchUp([item("a", 1), item("b", 2)]);
    state = actOnCatchUp(state, "a", "archive");
    state = actOnCatchUp(state, "b", "archive");
    expect(currentCatchUpItem(state)).toBeNull();
    const { state: undone } = undoCatchUp(state);
    expect(currentCatchUpItem(undone)?.key).toBe("b");
  });

  it("after an undo, acting again skips past conversations already done", () => {
    let state = startCatchUp([item("a", 1), item("b", 2), item("c", 3)]);
    state = actOnCatchUp(state, "a", "archive");
    state = actOnCatchUp(state, "b", "keep");
    state = undoCatchUp(state).state;
    state = undoCatchUp(state).state;
    expect(currentCatchUpItem(state)?.key).toBe("a");
    state = actOnCatchUp(state, "a", "snooze");
    expect(currentCatchUpItem(state)?.key).toBe("b");
    expect(state.history).toEqual(["a"]);
  });

  it("does nothing before any action", () => {
    const state = startCatchUp([item("a", 1)]);
    const result = undoCatchUp(state);
    expect(result.state).toBe(state);
    expect(result.undone).toBeNull();
  });
});

describe("toCatchUpItems", () => {
  it("names who the conversation is with, not the user who wrote last", () => {
    const [entry] = toCatchUpItems(
      [
        conversation({
          senders: ["Dana Example <dana@example.com>", "Me <me@example.com>"],
        }),
      ],
      "ME@example.com",
    );
    expect(entry.sender).toBe("Dana Example");
  });

  it("leaves out read conversations and drafts with nothing sent", () => {
    const items = toCatchUpItems(
      [
        conversation({ unread: false }),
        conversation({ latestMessageId: undefined }),
      ],
      "me@example.com",
    );
    expect(items).toEqual([]);
  });
});

function conversation(
  overrides: Partial<ConversationSummary>,
): ConversationSummary {
  return {
    key: { accountId: "account", conversationId: "thread" },
    subject: "Subject",
    preview: "Preview",
    from: "Dana Example <dana@example.com>",
    to: "me@example.com",
    senders: ["Dana Example <dana@example.com>"],
    latestMessageAtMs: 1,
    unread: true,
    starred: false,
    labelIds: [],
    roles: ["inbox"],
    pendingOperationIds: [],
    latestMessageId: "message",
    ...overrides,
  };
}

function item(key: string, atMs: number): CatchUpItem {
  return {
    key,
    threadId: key,
    accountId: "account",
    sender: "Sender",
    subject: `Subject ${key}`,
    preview: "",
    atMs,
  };
}
