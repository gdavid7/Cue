// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WaitingOnYouConversation } from "@inboxzero/mail-core/queries";
import {
  clearBrowserCaches,
  clearBrowserCachesForAccount,
  resetBrowserCacheForTesting,
  setBrowserCacheUser,
} from "@/utils/browser-cache";
import {
  dismissWaitingOnYou,
  isWaitingOnYouDismissed,
  keepShownOrder,
  rememberShownOrder,
  useWaitingOnYou,
  waitingOnYouScope,
} from "./use-waiting-on-you";

const mail = vi.hoisted(() => ({
  // What the local store answers, newest first.
  rows: [] as WaitingOnYouConversation[],
  // Accounts whose first sync hasn't finished.
  syncing: new Set<string>(),
  queries: [] as { accountIds: string[] }[],
  client: {} as { queryWaitingOnYou?: unknown },
}));

vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => mail.client,
}));
vi.mock("@inboxzero/mail-react/use-mailbox-window", () => ({
  useMailboxWindow: (query: { accountIds: string[] }) => ({
    status: "ready",
    revision: { databaseEpoch: 1, sequence: mail.rows.length },
    data: {
      conversations: [],
      connection: "ready",
      coverage: query.accountIds.map((accountId) => ({
        accountId,
        scopeId: "account",
        metadata: mail.syncing.has(accountId) ? "partial" : "complete",
        content: "not_requested",
        indexedContent: "not_requested",
        lastCompletedSyncAtMs: mail.syncing.has(accountId) ? null : 1,
      })),
    },
  }),
}));

const ROW = { conversationId: "t1", messageId: "m1" };

describe("Waiting on you dismissals", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserCacheForTesting("user-1");
  });

  it("keeps a dismissal for that account and message only", () => {
    dismissWaitingOnYou("account-a", ROW);

    expect(isWaitingOnYouDismissed("account-a", ROW)).toBe(true);
    expect(isWaitingOnYouDismissed("account-b", ROW)).toBe(false);
    // A newer message brings the conversation back.
    expect(
      isWaitingOnYouDismissed("account-a", { ...ROW, messageId: "m2" }),
    ).toBe(false);
  });

  it("forgets dismissals on sign-out", () => {
    dismissWaitingOnYou("account-a", ROW);

    clearBrowserCaches();
    setBrowserCacheUser("user-1");

    expect(isWaitingOnYouDismissed("account-a", ROW)).toBe(false);
  });

  it("forgets a removed account's dismissals only", () => {
    dismissWaitingOnYou("account-a", ROW);
    dismissWaitingOnYou("account-b", ROW);

    clearBrowserCachesForAccount("account-a");

    expect(isWaitingOnYouDismissed("account-a", ROW)).toBe(false);
    expect(isWaitingOnYouDismissed("account-b", ROW)).toBe(true);
  });

  it("keeps another user's dismissals from showing", () => {
    dismissWaitingOnYou("account-a", ROW);

    setBrowserCacheUser("user-2");

    expect(isWaitingOnYouDismissed("account-a", ROW)).toBe(false);
  });
});

describe("keepShownOrder", () => {
  // Newest first, as the store answers: e at 50 down to a at 10.
  const at = (id: string, receivedAtMs: number, messageId = `${id}-1`) => ({
    accountId: "account-a",
    conversationId: id,
    messageId,
    receivedAtMs,
  });
  const ids = (rows: { conversationId: string }[]) =>
    rows.map((row) => row.conversationId);
  const keys = (rows: ReturnType<typeof at>[]) =>
    rows.map(
      (row) => `${row.accountId}:${row.conversationId}:${row.messageId}`,
    );

  it("shows the newest first when nothing showed before", () => {
    expect(
      ids(keepShownOrder([], [at("c", 30), at("b", 20), at("a", 10)], 2)),
    ).toEqual(["c", "b"]);
  });

  it("keeps a row that synced in late below the rows already shown", () => {
    const shown = [at("c", 30), at("a", 10)];
    // b was older mail the store didn't hold yet; it sits between the two.
    const next = [at("c", 30), at("b", 20), at("a", 10)];

    expect(ids(keepShownOrder(keys(shown), next, 5))).toEqual(["c", "a", "b"]);
  });

  it("puts new mail on top and lets the oldest shown row go past the limit", () => {
    const shown = [at("c", 30), at("b", 20)];
    const next = [at("d", 40), at("c", 30), at("b", 20)];

    expect(ids(keepShownOrder(keys(shown), next, 2))).toEqual(["d", "c"]);
  });

  it("moves a conversation with a newer message to the top", () => {
    const shown = [at("c", 30), at("b", 20)];
    const next = [at("b", 45, "b-2"), at("c", 30)];

    expect(ids(keepShownOrder(keys(shown), next, 5))).toEqual(["b", "c"]);
  });

  it("closes the gap a row leaves without reordering the rest", () => {
    const shown = [at("c", 30), at("a", 10), at("b", 20)];
    const next = [at("c", 30), at("b", 20), at("a", 10)].filter(
      (row) => row.conversationId !== "a",
    );

    expect(ids(keepShownOrder(keys(shown), next, 5))).toEqual(["c", "b"]);
  });

  it("puts a row that left and came back, as an undo does, in its place again", () => {
    const all = [at("e", 50), at("d", 40), at("c", 30), at("b", 20)];
    const shown = keepShownOrder([], all, 3);
    const order = rememberShownOrder([], shown, all);
    // c is archived: b fills its place.
    const withoutC = all.filter((row) => row.conversationId !== "c");
    const filled = keepShownOrder(order, withoutC, 3);
    expect(ids(filled)).toEqual(["e", "d", "b"]);

    // The undo brings c back where it was.
    const remembered = rememberShownOrder(order, filled, withoutC);
    expect(ids(keepShownOrder(remembered, all, 3))).toEqual(["e", "d", "c"]);
  });

  it("gives the same order when remembering what it remembered", () => {
    const all = [at("e", 50), at("d", 40), at("c", 30), at("b", 20)];
    const order = rememberShownOrder([], keepShownOrder([], all, 3), all);
    const withoutC = all.filter((row) => row.conversationId !== "c");
    const remembered = rememberShownOrder(
      order,
      keepShownOrder(order, withoutC, 3),
      withoutC,
    );

    expect(
      rememberShownOrder(
        remembered,
        keepShownOrder(remembered, withoutC, 3),
        withoutC,
      ),
    ).toEqual(remembered);
  });

  it("lets go of a row still there but not shown, as only an undo brings one back", () => {
    const all = [at("c", 30), at("b", 20), at("a", 10)];
    const shown = [at("c", 30)];

    expect(rememberShownOrder(keys(all), shown, all)).toEqual(keys(shown));
  });

  it("keeps the shown rows and lets the lowest remembered go past fifty", () => {
    const left = Array.from({ length: 60 }, (_, index) =>
      at(`left-${index}`, 100 - index),
    );
    const shown = [at("b", 20), at("a", 10)];
    const order = rememberShownOrder(
      [...keys(left), ...keys(shown)],
      shown,
      shown,
    );

    expect(order).toHaveLength(50);
    expect(order.slice(-2)).toEqual(keys(shown));
    expect(order.slice(0, 48)).toEqual(keys(left.slice(0, 48)));
  });
});

describe("useWaitingOnYou", () => {
  const A = { id: "a", email: "a@example.com" };
  const B = { id: "b", email: "b@example.com" };
  const C = { id: "c", email: "c@example.com" };
  const ACCOUNTS = [A, B, C];

  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserCacheForTesting("user-1");
    mail.rows = [];
    mail.syncing = new Set();
    mail.queries = [];
    mail.client = {
      queryWaitingOnYou: async (query: { accountIds: string[] }) => {
        mail.queries.push(query);
        return mail.rows.filter((row) =>
          query.accountIds.includes(row.accountId),
        );
      },
    };
  });

  it("reads only the accounts it is given, even while another first syncs", async () => {
    mail.syncing = new Set(["c"]);
    mail.rows = [conversation("c", "other", 40), conversation("a", "ask", 30)];

    const { result } = renderWaitingOnYou({ handledLabelIds: { a: [] } });

    await waitFor(() => expect(threadIds(result.current)).toEqual(["ask"]));
    expect(mail.queries.at(-1)?.accountIds).toEqual(["a"]);
  });

  it("waits for an account whose Needs reply is coming to sync, to know its copies", async () => {
    mail.syncing = new Set(["b"]);
    mail.rows = [conversation("a", "ask", 30)];
    const { result, rerender } = renderWaitingOnYou({
      handledLabelIds: { a: [] },
      pendingAccountIds: new Set(["b"]),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(threadIds(result.current)).toEqual([]);

    mail.syncing = new Set();
    rerender({ handledLabelIds: { a: [] }, pendingAccountIds: new Set(["b"]) });

    await waitFor(() => expect(threadIds(result.current)).toEqual(["ask"]));
  });

  it("shows a message in two of the accounts once, saying where else it is", async () => {
    mail.rows = [
      conversation("a", "ask", 30, { messageKey: "k@x", copies: ["b"] }),
      conversation("b", "ask-copy", 30, { messageKey: "k@x", copies: ["a"] }),
    ];

    const { result } = renderWaitingOnYou({
      handledLabelIds: { a: [], b: [] },
    });

    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(result.current.threads[0]).toMatchObject({
      threadId: "ask",
      rfcMessageId: "k@x",
      account: A,
      alsoIn: [B],
    });
  });

  it("dismisses every copy of a message, and keeps them dismissed after a reload", async () => {
    mail.rows = [
      conversation("a", "ask", 30, { messageKey: "k@x", copies: ["b"] }),
      conversation("b", "ask-copy", 30, { messageKey: "k@x", copies: ["a"] }),
      conversation("a", "lunch", 20),
    ];
    const first = renderWaitingOnYou({ handledLabelIds: { a: [], b: [] } });
    await waitFor(() =>
      expect(threadIds(first.result.current)).toEqual(["ask", "lunch"]),
    );

    act(() => first.result.current.dismiss(first.result.current.threads[0]));

    expect(threadIds(first.result.current)).toEqual(["lunch"]);
    first.unmount();
    // A reload: nothing kept in memory, only what this browser stored.
    resetBrowserCacheForTesting("user-1");
    const reloaded = renderWaitingOnYou({ handledLabelIds: { a: [], b: [] } });
    await waitFor(() =>
      expect(threadIds(reloaded.result.current)).toEqual(["lunch"]),
    );
    // Only while no newer message has come in.
    expect(
      isWaitingOnYouDismissed("b", {
        conversationId: "ask-copy",
        messageId: "ask-copy-2",
        messageKey: "<newer@x>",
      }),
    ).toBe(false);
  });

  it("holds a row whose copy may yet show in another account's Needs reply", async () => {
    mail.rows = [
      conversation("a", "ask", 30, { messageKey: "k@x", copies: ["b"] }),
      conversation("a", "lunch", 20),
    ];

    const { result, rerender } = renderWaitingOnYou({
      handledLabelIds: { a: [] },
      pendingAccountIds: new Set(["b"]),
    });

    await waitFor(() => expect(threadIds(result.current)).toEqual(["lunch"]));

    // b answered without it in Needs reply: the row joins below the one
    // already shown, though newer, so that one doesn't move.
    rerender({ handledLabelIds: { a: [] }, pendingAccountIds: new Set() });

    await waitFor(() =>
      expect(threadIds(result.current)).toEqual(["lunch", "ask"]),
    );
  });

  it("keeps rows in place as older mail syncs in, across renders", async () => {
    mail.rows = [conversation("a", "new", 30), conversation("a", "old", 10)];
    const { result, rerender } = renderWaitingOnYou({
      handledLabelIds: { a: [] },
    });
    await waitFor(() =>
      expect(threadIds(result.current)).toEqual(["new", "old"]),
    );

    // Mail between the two arrives late, as a backfill brings it.
    mail.rows = [
      conversation("a", "new", 30),
      conversation("a", "middle", 20),
      conversation("a", "old", 10),
    ];
    rerender({ handledLabelIds: { a: [] } });
    rerender({ handledLabelIds: { a: [] } });

    await waitFor(() =>
      expect(threadIds(result.current)).toEqual(["new", "old", "middle"]),
    );
  });

  it("puts an archived row back in its place when the archive is undone", async () => {
    const all = [
      conversation("a", "new", 30),
      conversation("a", "middle", 20),
      conversation("a", "old", 10),
    ];
    mail.rows = all;
    const { result, rerender } = renderWaitingOnYou({
      handledLabelIds: { a: [] },
    });
    await waitFor(() =>
      expect(threadIds(result.current)).toEqual(["new", "middle", "old"]),
    );

    mail.rows = all.filter((row) => row.conversationId !== "middle");
    rerender({ handledLabelIds: { a: [] } });
    await waitFor(() =>
      expect(threadIds(result.current)).toEqual(["new", "old"]),
    );

    mail.rows = all;
    rerender({ handledLabelIds: { a: [] } });
    await waitFor(() =>
      expect(threadIds(result.current)).toEqual(["new", "middle", "old"]),
    );
  });

  it("shows the same account's copy of a message that reached two at once", async () => {
    // The store lists copies that arrived together in no set order.
    const copy = conversation("b", "ask-copy", 30, {
      messageKey: "k@x",
      copies: ["a"],
    });
    mail.rows = [
      copy,
      {
        ...conversation("a", "ask", 30, { messageKey: "k@x", copies: ["b"] }),
        receivedAtMs: copy.receivedAtMs,
      },
    ];

    const { result } = renderWaitingOnYou({
      handledLabelIds: { a: [], b: [] },
    });

    await waitFor(() => expect(threadIds(result.current)).toEqual(["ask"]));
    expect(result.current.threads[0]).toMatchObject({ account: A });
  });

  it("drops an account no longer read, without waiting for the store", async () => {
    mail.rows = [conversation("b", "b-ask", 40), conversation("a", "ask", 30)];
    const { result, rerender } = renderWaitingOnYou({
      handledLabelIds: { a: [], b: [] },
    });
    await waitFor(() =>
      expect(threadIds(result.current)).toEqual(["b-ask", "ask"]),
    );

    act(() => rerender({ handledLabelIds: { a: [] } }));

    expect(threadIds(result.current)).toEqual(["ask"]);
  });

  function renderWaitingOnYou(initial: {
    handledLabelIds: Record<string, string[]>;
    pendingAccountIds?: ReadonlySet<string>;
  }) {
    const cache = new Map();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SWRConfig, { value: { provider: () => cache } }, children);
    return renderHook(
      (props: typeof initial) =>
        useWaitingOnYou({ accounts: ACCOUNTS, named: true, ...props }),
      { initialProps: initial, wrapper },
    );
  }
});

describe("waitingOnYouScope", () => {
  const ACCOUNTS = [{ id: "new" }, { id: "read" }, { id: "unknown" }];

  it("reads a mailbox Cue hasn't read from the early answer, before its Today", () => {
    expect(
      waitingOnYouScope(ACCOUNTS, {
        new: { hasReadMail: false },
        read: { hasReadMail: true },
      }),
    ).toEqual({
      handledLabelIds: { new: [] },
      pendingAccountIds: new Set(["read", "unknown"]),
    });
  });

  it("follows each account's Today once it answers", () => {
    expect(
      waitingOnYouScope(ACCOUNTS, {
        new: {
          home: home({ hasReadMail: false, handledLabelIds: ["Label_1"] }),
          // Today's answer wins over the early one.
          hasReadMail: true,
        },
        read: { home: home({ hasReadMail: true, pending: ["needsYou"] }) },
        unknown: { home: home({ hasReadMail: true }) },
      }),
    ).toEqual({
      handledLabelIds: { new: ["Label_1"] },
      pendingAccountIds: new Set(["read"]),
    });
  });

  it("leaves to Cue a new mailbox whose Needs reply has conversations", () => {
    expect(
      waitingOnYouScope([{ id: "new" }], {
        new: { home: home({ hasReadMail: false, needsYou: 1 }) },
      }).handledLabelIds,
    ).toEqual({});
  });

  it("stops waiting for an account whose Today failed or gave up", () => {
    expect(
      waitingOnYouScope(ACCOUNTS, {
        new: { hasReadMail: false },
        read: {
          home: home({ hasReadMail: true, pending: ["needsYou"] }),
          gaveUp: true,
        },
        unknown: { failed: true },
      }).pendingAccountIds,
    ).toEqual(new Set());
  });

  function home({
    hasReadMail,
    needsYou = 0,
    pending = [],
    handledLabelIds = [],
  }: {
    hasReadMail: boolean;
    needsYou?: number;
    pending?: "needsYou"[];
    handledLabelIds?: string[];
  }) {
    return {
      cue: { aiAccess: true, replyTracking: true, hasReadMail },
      needsYou: Array.from({ length: needsYou }, () => ({}) as never),
      pending,
      handledLabelIds,
    };
  }
});

function conversation(
  accountId: string,
  conversationId: string,
  receivedAtMs: number,
  {
    messageKey = null,
    copies = [],
  }: { messageKey?: string | null; copies?: string[] } = {},
): WaitingOnYouConversation {
  return {
    accountId,
    conversationId,
    messageId: `${conversationId}-1`,
    from: "Ana Lima <ana@example.com>",
    subject: "Lunch?",
    preview: "",
    receivedAtMs: Date.now() - 1000 + receivedAtMs,
    unread: true,
    starred: false,
    messageKey,
    copyAccountIds: copies,
  };
}

function threadIds(result: { threads: { threadId: string }[] }) {
  return result.threads.map((thread) => thread.threadId);
}
