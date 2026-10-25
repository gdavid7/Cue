import { describe, expect, it } from "vitest";
import type { ListThread } from "./types";
import {
  getListThreadSelection,
  getRepliedThreadEmailAccountId,
  getThreadSelectionKey,
} from "./types";

describe("thread selection identity", () => {
  it("keeps identical provider thread ids distinct across accounts", () => {
    const left = getListThreadSelection(
      createCombinedThread("account-1", "shared-thread"),
      "route-account",
    );
    const right = getListThreadSelection(
      createCombinedThread("account-2", "shared-thread"),
      "route-account",
    );

    expect(getThreadSelectionKey(left)).toBe("account-1:shared-thread");
    expect(getThreadSelectionKey(right)).toBe("account-2:shared-thread");
  });

  it("uses the route account for a single-account row", () => {
    expect(
      getListThreadSelection(createThread("thread-1"), "route-account"),
    ).toEqual({
      emailAccountId: "route-account",
      threadId: "thread-1",
    });
  });
});

describe("getRepliedThreadEmailAccountId", () => {
  const threads = [
    createCombinedThread("work", "thread-w"),
    createCombinedThread("home", "thread-h"),
  ];

  it("credits the account of the thread that was replied to, not the open one", () => {
    expect(
      getRepliedThreadEmailAccountId({
        repliedThreadId: "thread-h",
        openSelection: { emailAccountId: "work", threadId: "thread-w" },
        threads,
        currentEmailAccountId: "route-account",
      }),
    ).toBe("home");
  });

  it("uses the open thread's account when it is the one replied to", () => {
    expect(
      getRepliedThreadEmailAccountId({
        repliedThreadId: "gone",
        openSelection: { emailAccountId: "work", threadId: "gone" },
        threads: [],
        currentEmailAccountId: "route-account",
      }),
    ).toBe("work");
  });

  it("falls back to the mailbox on screen for a plain list", () => {
    expect(
      getRepliedThreadEmailAccountId({
        repliedThreadId: "thread-1",
        openSelection: null,
        threads: [createThread("thread-1")],
        currentEmailAccountId: "route-account",
      }),
    ).toBe("route-account");
  });
});

function createThread(id: string): ListThread {
  return {
    id,
    messageIds: [],
    messages: [],
    plan: undefined,
    plans: [],
    snippet: id,
  };
}

function createCombinedThread(accountId: string, id: string): ListThread {
  return {
    ...createThread(id),
    account: {
      email: `${accountId}@example.com`,
      id: accountId,
      image: null,
      name: accountId,
    },
  };
}
