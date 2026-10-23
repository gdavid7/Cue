import { describe, expect, it } from "vitest";
import {
  actOnCatchUp,
  type CatchUpItem,
  catchUpLeft,
  currentCatchUpItem,
  type CatchUpLive,
  type CatchUpScope,
  reconcileCatchUp,
  revertCatchUp,
  type CatchUpCopiesFound,
  catchUpUnreadConversations,
  keepCatchUpAccounts,
  setAsideCatchUpAccounts,
  startCatchUp,
  toCatchUpItems,
  toCatchUpLive,
  withCatchUpCopies,
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

  it("keeps the copies a card was found with when it shows a newer message", () => {
    const copies = [
      { accountId: "home", threadId: "h1", inInbox: true, unread: true },
    ];
    const state = startCatchUp([{ ...item("work:a", 1, "work"), copies }]);
    const newer = { ...item("work:a", 5, "work"), latestMessageId: "reply" };
    const next = reconcileCatchUp(state, live([newer]));
    expect(currentCatchUpItem(next)?.latestMessageId).toBe("reply");
    expect(currentCatchUpItem(next)?.copies).toEqual(copies);
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
      singleAccount("ME@example.com"),
    );
    expect(entry.sender).toBe("Dana Example");
  });

  it("leaves out read conversations and drafts with nothing sent", () => {
    const items = toCatchUpItems(
      [
        conversation({ unread: false }),
        conversation({ latestMessageId: undefined }),
      ],
      singleAccount("me@example.com"),
    );
    expect(items).toEqual([]);
  });

  it("keys All inboxes cards by account, as the list keys its rows", () => {
    const items = toCatchUpItems(
      [
        conversation({ key: { accountId: "work", conversationId: "t1" } }),
        conversation({ key: { accountId: "home", conversationId: "t1" } }),
      ],
      ALL_INBOXES,
    );
    expect(items.map((entry) => [entry.key, entry.accountId])).toEqual([
      ["work:t1", "work"],
      ["home:t1", "home"],
    ]);
  });

  it("names who mail is with by each account's own address", () => {
    // The home address wrote last: the user in home's inbox, but someone
    // else in work's.
    const senders = ["Dana <dana@example.com>", "Home Me <me@home.example>"];
    const items = toCatchUpItems(
      [
        conversation({
          key: { accountId: "home", conversationId: "t1" },
          senders,
        }),
        conversation({
          key: { accountId: "work", conversationId: "t2" },
          senders,
        }),
      ],
      ALL_INBOXES,
    );
    expect(items.map((entry) => entry.sender)).toEqual(["Dana", "Home Me"]);
  });

  it("groups an unread message in several accounts into one card, from the routed account", () => {
    // What the batch read returns: unread only, oldest first, so home's
    // copy, received a moment earlier, comes first.
    const items = toCatchUpItems(
      [
        conversation({
          key: { accountId: "home", conversationId: "h1" },
          latestInternetMessageId: "<same@example.com>",
          latestMessageAtMs: 1,
        }),
        conversation({
          key: { accountId: "work", conversationId: "w1" },
          latestInternetMessageId: "<SAME@example.com>",
          latestMessageAtMs: 2,
        }),
      ],
      ALL_INBOXES,
    );
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("work:w1");
    expect(items[0].copies).toEqual([
      { accountId: "home", threadId: "h1", inInbox: true, unread: true },
    ]);
  });
});

describe("withCatchUpCopies", () => {
  const SHARED = "<shared@example.com>";

  function workCard() {
    return startCatchUp(
      toCatchUpItems(
        [
          conversation({
            key: { accountId: "work", conversationId: "w1" },
            latestInternetMessageId: SHARED,
          }),
        ],
        ALL_INBOXES,
      ),
    );
  }

  it("adds a copy already read in another account, which the unread read can't return", () => {
    const state = workCard();
    const next = withCatchUpCopies(
      state,
      found("work:w1", [
        conversation({
          key: { accountId: "work", conversationId: "w1" },
          latestInternetMessageId: SHARED,
        }),
        conversation({
          key: { accountId: "home", conversationId: "h1" },
          latestInternetMessageId: SHARED,
          unread: false,
        }),
        conversation({
          key: { accountId: "home", conversationId: "other" },
          latestInternetMessageId: "<other@example.com>",
        }),
      ]),
      ALL_INBOXES,
    );
    expect(next.items.map((entry) => [entry.key, entry.copies])).toEqual([
      [
        "work:w1",
        [{ accountId: "home", threadId: "h1", inInbox: true, unread: false }],
      ],
    ]);
    expect(next.incomplete).toBe(0);
  });

  it("leaves out a card whose read didn't reach every possible copy", () => {
    const next = withCatchUpCopies(
      workCard(),
      found("work:w1", [], false),
      ALL_INBOXES,
    );
    expect(next.items).toEqual([]);
    expect(next.incomplete).toBe(1);
  });

  it("leaves out a card when one account has two conversations for its message", () => {
    const next = withCatchUpCopies(
      workCard(),
      found("work:w1", [
        conversation({
          key: { accountId: "home", conversationId: "h1" },
          latestInternetMessageId: SHARED,
        }),
        conversation({
          key: { accountId: "home", conversationId: "h2" },
          latestInternetMessageId: SHARED,
        }),
      ]),
      ALL_INBOXES,
    );
    expect(next.items).toEqual([]);
    expect(next.incomplete).toBe(1);
  });

  it("shows the card from the routed account once its copy is found there", () => {
    const state = startCatchUp(
      toCatchUpItems(
        [
          conversation({
            key: { accountId: "home", conversationId: "h1" },
            latestInternetMessageId: SHARED,
          }),
        ],
        ALL_INBOXES,
      ),
    );
    const next = withCatchUpCopies(
      state,
      found("home:h1", [
        conversation({
          key: { accountId: "work", conversationId: "w1" },
          latestInternetMessageId: SHARED,
          unread: false,
          roles: [],
        }),
      ]),
      ALL_INBOXES,
    );
    expect(next.items[0]).toMatchObject({
      key: "work:w1",
      inInbox: false,
      unread: false,
      copies: [
        { accountId: "home", threadId: "h1", inInbox: true, unread: true },
      ],
    });
  });

  it("drops a card that became one already acted on, or already in the batch", () => {
    const routedCopy = conversation({
      key: { accountId: "work", conversationId: "w1" },
      latestInternetMessageId: SHARED,
    });
    const homeCard = startCatchUp(
      toCatchUpItems(
        [
          conversation({
            key: { accountId: "home", conversationId: "h1" },
            latestInternetMessageId: SHARED,
          }),
        ],
        ALL_INBOXES,
      ),
    );
    expect(
      withCatchUpCopies(
        homeCard,
        found("home:h1", [routedCopy]),
        ALL_INBOXES,
        new Set(["work:w1"]),
      ).items,
    ).toEqual([]);
    const twice = {
      ...homeCard,
      items: [...workCard().items, ...homeCard.items],
    };
    expect(
      withCatchUpCopies(
        twice,
        found("home:h1", [routedCopy]),
        ALL_INBOXES,
      ).items.map((entry) => entry.key),
    ).toEqual(["work:w1"]);
  });

  it("keeps a card with no Message-ID, and changes nothing for one account", () => {
    const state = startCatchUp([item("a", 1)]);
    expect(withCatchUpCopies(state, new Map(), ALL_INBOXES).items).toEqual(
      state.items,
    );
    expect(
      withCatchUpCopies(state, found("a", [], false), singleAccount("me@x")),
    ).toBe(state);
  });
});

describe("catchUpUnreadConversations", () => {
  it("names only the conversations that were unread when the card was made", () => {
    const card = {
      ...item("work:w1", 1, "work"),
      threadId: "w1",
      unread: false,
      copies: [
        { accountId: "home", threadId: "h1", inInbox: true, unread: true },
        { accountId: "side", threadId: "s1", inInbox: true, unread: false },
      ],
    };
    expect(catchUpUnreadConversations(card)).toEqual([
      { accountId: "home", threadId: "h1" },
    ]);
  });
});

describe("toCatchUpLive", () => {
  it("keeps a card while a copy is still unread, though its own conversation was read", () => {
    const card = {
      ...item("work:w1", 1, "work"),
      threadId: "w1",
      copies: [
        { accountId: "home", threadId: "h1", inInbox: true, unread: true },
      ],
    };
    const state = startCatchUp([card]);
    const live = toCatchUpLive(
      state,
      [conversation({ key: { accountId: "home", conversationId: "h1" } })],
      ALL_INBOXES,
      true,
    );
    expect(reconcileCatchUp(state, live)).toBe(state);
    expect(
      currentCatchUpItem(
        reconcileCatchUp(state, toCatchUpLive(state, [], ALL_INBOXES, true)),
      ),
    ).toBeNull();
  });
});

describe("keepCatchUpAccounts", () => {
  it("drops a removed account's cards and its copies behind others", () => {
    const state = startCatchUp([
      {
        ...item("work:a", 1, "work"),
        copies: [
          { accountId: "home", threadId: "h", inInbox: true, unread: true },
        ],
      },
      item("home:b", 2, "home"),
    ]);
    const next = keepCatchUpAccounts(state, ["work"]);
    expect(next.items.map((entry) => [entry.key, entry.copies])).toEqual([
      ["work:a", []],
    ]);
    expect(keepCatchUpAccounts(next, ["work"])).toBe(next);
  });
});

describe("setAsideCatchUpAccounts", () => {
  it("sets aside one account's open cards, and the others carry on", () => {
    let state = startCatchUp([
      item("work:a", 1, "work"),
      item("home:b", 2, "home"),
      item("work:c", 3, "work"),
      item("home:d", 4, "home"),
    ]);
    state = actOnCatchUp(state, "work:a", "archive");
    state = setAsideCatchUpAccounts(state, ["work"], "refused");
    expect(currentCatchUpItem(state)?.key).toBe("home:b");
    expect(catchUpLeft(state)).toBe(2);
    // Already done stays done, and undoable.
    expect(state.history).toEqual(["work:a"]);
    state = actOnCatchUp(state, "home:b", "keep");
    expect(currentCatchUpItem(state)?.key).toBe("home:d");
    // A set-aside card can't be acted on from the batch.
    expect(actOnCatchUp(state, "work:c", "archive")).toBe(state);
  });

  it("changes nothing for an account already set aside, or without cards", () => {
    const state = setAsideCatchUpAccounts(
      startCatchUp([item("work:a", 1, "work")]),
      ["work"],
      "refused",
    );
    // The first reason stays.
    expect(
      setAsideCatchUpAccounts(state, ["work", "elsewhere"], "unreachable"),
    ).toBe(state);
    expect(state.setAside).toEqual({ work: "refused" });
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

const ALL_INBOXES: CatchUpScope = {
  ownEmail: (accountId) =>
    accountId === "home" ? "me@home.example" : "me@work.example",
  combined: { routedAccountId: "work" },
};

function singleAccount(email: string): CatchUpScope {
  return { ownEmail: () => email, combined: null };
}

function item(key: string, atMs: number, accountId = "account"): CatchUpItem {
  return {
    key,
    threadId: key,
    accountId,
    latestMessageId: key,
    messageKey: null,
    inInbox: true,
    unread: true,
    fromAddress: "sender@example.com",
    copies: [],
    sender: "Sender",
    subject: `Subject ${key}`,
    preview: "",
    atMs,
  };
}

function found(
  key: string,
  conversations: ConversationSummary[],
  complete = true,
): ReadonlyMap<string, CatchUpCopiesFound> {
  return new Map([[key, { conversations, complete }]]);
}
