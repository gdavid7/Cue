import { describe, expect, it } from "vitest";
import {
  actOnCatchUp,
  type CatchUpItem,
  catchUpLeft,
  currentCatchUpItem,
  type CatchUpLive,
  reconcileCatchUp,
  revertCatchUp,
  startCatchUp,
  toCatchUpItems,
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

  it("stops after a batch of ten", () => {
    const state = startCatchUp(
      Array.from({ length: 25 }, (_, index) => item(`t${index}`, 1000 - index)),
    );
    expect(state.items).toHaveLength(10);
    expect(catchUpLeft(state)).toBe(10);
    // The ten oldest, not the first ten read.
    expect(state.items[0].key).toBe("t24");
    expect(state.items.at(-1)?.key).toBe("t15");
  });

  it("leaves out conversations already acted on, and fills the batch past them", () => {
    const state = startCatchUp(
      Array.from({ length: 12 }, (_, index) => item(`t${index}`, index)),
      new Set(["t0", "t2"]),
    );
    expect(state.items.map((entry) => entry.key)).toEqual([
      "t1",
      "t3",
      "t4",
      "t5",
      "t6",
      "t7",
      "t8",
      "t9",
      "t10",
      "t11",
    ]);
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

describe("revertCatchUp", () => {
  it("brings the last conversation back as the current one", () => {
    let state = startCatchUp([item("a", 1), item("b", 2), item("c", 3)]);
    state = actOnCatchUp(state, "a", "archive");
    state = actOnCatchUp(state, "b", "keep");
    state = revertCatchUp(state, "b");
    expect(currentCatchUpItem(state)?.key).toBe("b");
    expect(catchUpLeft(state)).toBe(2);
    expect(state.history).toEqual(["a"]);
  });

  it("returns to the finished batch's last conversation", () => {
    let state = startCatchUp([item("a", 1), item("b", 2)]);
    state = actOnCatchUp(state, "a", "archive");
    state = actOnCatchUp(state, "b", "archive");
    expect(currentCatchUpItem(state)).toBeNull();
    state = revertCatchUp(state, "b");
    expect(currentCatchUpItem(state)?.key).toBe("b");
  });

  it("takes back an action that isn't the latest, leaving later ones done", () => {
    let state = startCatchUp([item("a", 1), item("b", 2), item("c", 3)]);
    state = actOnCatchUp(state, "a", "archive");
    state = actOnCatchUp(state, "b", "snooze");
    state = revertCatchUp(state, "a");
    expect(currentCatchUpItem(state)?.key).toBe("a");
    expect(state.history).toEqual(["b"]);
    // Acting again skips past the conversation already done.
    state = actOnCatchUp(state, "a", "keep");
    expect(currentCatchUpItem(state)?.key).toBe("c");
  });

  it("leaves the batch alone for a conversation not acted on", () => {
    const state = startCatchUp([item("a", 1)]);
    expect(revertCatchUp(state, "a")).toBe(state);
  });
});

describe("reconcileCatchUp", () => {
  it("skips a conversation read or gone from the tab elsewhere", () => {
    const state = startCatchUp([item("a", 1), item("b", 2), item("c", 3)]);
    const next = reconcileCatchUp(state, live([item("c", 3)]));
    expect(currentCatchUpItem(next)?.key).toBe("c");
    expect(catchUpLeft(next)).toBe(1);
  });

  it("keeps a missing conversation when the mailbox only read part of the tab", () => {
    const state = startCatchUp([item("a", 1), item("b", 2)]);
    expect(reconcileCatchUp(state, live([item("b", 2)], false))).toBe(state);
  });

  it("shows the newer message of a conversation that got one", () => {
    const state = startCatchUp([item("a", 1), item("b", 2)]);
    const newer = {
      ...item("a", 5),
      latestMessageId: "a-reply",
      preview: "New",
    };
    const next = reconcileCatchUp(state, live([newer, item("b", 2)]));
    expect(currentCatchUpItem(next)).toEqual(newer);
    expect(next.items.map((entry) => entry.key)).toEqual(["a", "b"]);
  });

  it("changes nothing while the mailbox agrees, or hasn't answered", () => {
    const state = startCatchUp([item("a", 1)]);
    expect(reconcileCatchUp(state, null)).toBe(state);
    expect(reconcileCatchUp(state, live([item("a", 1)]))).toBe(state);
  });

  it("leaves acted conversations, and one an undo brought back, to the batch", () => {
    let state = startCatchUp([item("a", 1), item("b", 2)]);
    state = actOnCatchUp(state, "a", "archive");
    state = actOnCatchUp(state, "b", "keep");
    state = revertCatchUp(state, "b");
    // The mailbox hasn't shown the undo yet: neither card is skipped.
    const next = reconcileCatchUp(state, live([]));
    expect(currentCatchUpItem(next)?.key).toBe("b");
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

function live(entries: CatchUpItem[], complete = true): CatchUpLive {
  return {
    items: new Map(entries.map((entry) => [entry.key, entry])),
    complete,
  };
}

function item(key: string, atMs: number): CatchUpItem {
  return {
    key,
    threadId: key,
    accountId: "account",
    latestMessageId: key,
    sender: "Sender",
    subject: `Subject ${key}`,
    preview: "",
    atMs,
  };
}
