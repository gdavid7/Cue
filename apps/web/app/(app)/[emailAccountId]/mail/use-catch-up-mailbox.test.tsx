/** @vitest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type {
  ConversationQuery,
  ConversationSummary,
  MailboxView,
  MailPredicate,
  QuerySnapshot,
} from "@inboxzero/mail-core/queries";
import type { CatchUpItem } from "./catch-up-queue";
import {
  type CatchUpCopiesRead,
  useCatchUpCopies,
  useCatchUpMailbox,
} from "./use-catch-up-mailbox";

const INBOX: MailPredicate = { kind: "role", role: "inbox" };

describe("useCatchUpMailbox", () => {
  it("reads the oldest unread from an engine that orders oldest first", async () => {
    const engine = fakeEngine(unreadMail(30), { legacy: false });
    const { result } = renderHook(() =>
      useCatchUpMailbox(props(engine.client, null)),
    );
    await waitFor(() => expect(result.current.batch.status).toBe("ready"));
    expect(ids(result.current.batch)).toEqual(["c0", "c1", "c2"]);
    expect(engine.orders()).toEqual(["oldest_first"]);
  });

  it("still finds the oldest unread on an engine that refuses oldest_first", async () => {
    // Older than one page, so only reading every page finds it.
    const engine = fakeEngine(unreadMail(250), { legacy: true });
    const { result } = renderHook(() =>
      useCatchUpMailbox(props(engine.client, null)),
    );
    await waitFor(() => expect(result.current.batch.status).toBe("ready"));
    const found = ids(result.current.batch);
    expect(found).toHaveLength(250);
    expect(found).toContain("c0");
    expect(engine.orders()).toEqual(["oldest_first", "newest_first"]);
  });

  it("watches the batch on an engine that refuses conversation queries", async () => {
    const engine = fakeEngine(unreadMail(5), { legacy: true });
    const { result } = renderHook(() =>
      useCatchUpMailbox(props(engine.client, watching("a", ["c0", "c1"]))),
    );
    await waitFor(() => expect(result.current.watch).not.toBeNull());
    expect(result.current.watch?.complete).toBe(true);
    expect(
      result.current.watch?.conversations.map((row) => row.key.conversationId),
    ).toContain("c0");
  });

  it("reads every included account's oldest unread in one order", async () => {
    const engine = fakeEngine(
      [
        ...unreadMail(3, "work", [10, 40, 50]),
        ...unreadMail(3, "home", [20, 30, 60]),
      ],
      { legacy: false },
    );
    const { result } = renderHook(() =>
      useCatchUpMailbox({
        ...props(engine.client, null),
        accountIds: ["work", "home"],
        batchRead: 4,
      }),
    );
    await waitFor(() => expect(result.current.batch.status).toBe("ready"));
    expect(keys(result.current.batch)).toEqual([
      "work:c0",
      "home:c0",
      "home:c1",
      "work:c1",
    ]);
  });

  it("watches each card's conversation within its own account", async () => {
    // Both accounts have a c0; only work's is in the batch.
    const engine = fakeEngine(
      [...unreadMail(2, "work", [1, 2]), ...unreadMail(2, "home", [3, 4])],
      { legacy: false },
    );
    const { result } = renderHook(() =>
      useCatchUpMailbox({
        ...props(engine.client, [
          { accountId: "work", threadId: "c0" },
          { accountId: "home", threadId: "c1" },
        ]),
        accountIds: ["work", "home"],
      }),
    );
    await waitFor(() => expect(result.current.watch).not.toBeNull());
    expect(
      result.current.watch?.conversations.map(
        (row) => `${row.key.accountId}:${row.key.conversationId}`,
      ),
    ).toEqual(["work:c0", "home:c1"]);
    expect(result.current.watch?.complete).toBe(true);
  });

  it("waits for an included account's first sync before fixing a batch", async () => {
    const engine = fakeEngine(
      [...unreadMail(2, "work", [1, 2]), ...unreadMail(2, "home", [3, 4])],
      { legacy: false, unsynced: ["home"] },
    );
    const { result } = renderHook(() =>
      useCatchUpMailbox({
        ...props(engine.client, null),
        accountIds: ["work", "home"],
      }),
    );
    await waitFor(() => expect(engine.reads()).toBeGreaterThan(0));
    expect(result.current.batch.status).toBe("loading");
  });

  it("reads nothing without an account to read", () => {
    const engine = fakeEngine(unreadMail(2), { legacy: false });
    const { result } = renderHook(() =>
      useCatchUpMailbox({ ...props(engine.client, null), accountIds: [] }),
    );
    expect(result.current.batch.status).toBe("loading");
    expect(engine.reads()).toBe(0);
  });

  it("says the batch is unavailable, rather than loading for ever, when nothing answers", async () => {
    const engine = fakeEngine(unreadMail(5), { legacy: true, broken: true });
    const { result } = renderHook(() =>
      useCatchUpMailbox(props(engine.client, null)),
    );
    await waitFor(() =>
      expect(result.current.batch.status).toBe("unavailable"),
    );
  });
});

describe("useCatchUpCopies", () => {
  it("reads the cards' Message-IDs in every account, read or not, in one query", async () => {
    const engine = fakeEngine(
      [
        ...unreadMail(1, "work", [1000]),
        { ...unreadMail(1, "home", [1000])[0], unread: false },
      ],
      { legacy: false },
    );
    const { result } = renderHook(() =>
      useCatchUpCopies({
        client: engine.client,
        accountIds: ["work", "home"],
        cards: [card("work:c0", "one@example.com"), card("work:c1", "two@x")],
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const read = found(result.current, "work:c0");
    expect(read?.complete).toBe(true);
    expect(read?.conversations.map((row) => row.key.accountId).sort()).toEqual([
      "home",
      "work",
    ]);
    expect(engine.queries()).toHaveLength(1);
    const [query] = engine.queries();
    expect(query.accountIds).toEqual(["work", "home"]);
    expect(query.predicate).toEqual({
      kind: "internet_message_id",
      ids: ["one@example.com", "two@x"],
    });
  });

  it("follows every page past the first", async () => {
    const engine = fakeEngine(unreadMail(230, "home", range(230, 1000)), {
      legacy: false,
    });
    const { result } = renderHook(() =>
      useCatchUpCopies({
        client: engine.client,
        accountIds: ["home"],
        cards: [card("work:c0")],
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const read = found(result.current, "work:c0");
    expect(read?.complete).toBe(true);
    expect(read?.conversations).toHaveLength(230);
  });

  it("says a read that doesn't end within its pages is incomplete", async () => {
    const engine = fakeEngine(unreadMail(600, "home", range(600, 1000)), {
      legacy: false,
    });
    const { result } = renderHook(() =>
      useCatchUpCopies({
        client: engine.client,
        accountIds: ["home"],
        cards: [card("work:c0")],
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(found(result.current, "work:c0")?.complete).toBe(false);
  });

  it("says a read the engine refuses or throws on is incomplete", async () => {
    const refusing = fakeEngine(unreadMail(1), { legacy: true, broken: true });
    const refused = renderHook(() =>
      useCatchUpCopies({
        client: refusing.client,
        accountIds: ["a"],
        cards: [card("a:c0")],
      }),
    );
    await waitFor(() =>
      expect(found(refused.result.current, "a:c0")).toEqual({
        conversations: [],
        complete: false,
      }),
    );
    const throwing = {
      observeMailbox: () => {
        throw new Error("engine gone");
      },
    } as unknown as MailClient;
    const thrown = renderHook(() =>
      useCatchUpCopies({
        client: throwing,
        accountIds: ["a"],
        cards: [card("a:c0")],
      }),
    );
    await waitFor(() =>
      expect(found(thrown.result.current, "a:c0")?.complete).toBe(false),
    );
  });

  it("reads nothing until the cards are known, nor for a card without a Message-ID", () => {
    const engine = fakeEngine(unreadMail(1), { legacy: false });
    const waiting = renderHook(() =>
      useCatchUpCopies({
        client: engine.client,
        accountIds: ["a"],
        cards: null,
      }),
    );
    expect(waiting.result.current.status).toBe("loading");
    const none = renderHook(() =>
      useCatchUpCopies({
        client: engine.client,
        accountIds: ["a"],
        cards: [{ ...card("a:c0"), messageKey: null }],
      }),
    );
    expect(none.result.current.status).toBe("ready");
    expect(engine.reads()).toBe(0);
  });
});

function card(key: string, messageKey = "shared@example.com"): CatchUpItem {
  return {
    key,
    threadId: key.split(":")[1] ?? key,
    accountId: key.split(":")[0] ?? "a",
    latestMessageId: "m",
    messageKey,
    inInbox: true,
    unread: true,
    copies: [],
    sender: "Dana",
    subject: "Subject",
    preview: "",
    atMs: 1000,
  };
}

function found(read: CatchUpCopiesRead, key: string) {
  return read.status === "ready" ? read.found.get(key) : undefined;
}

/** Times counting down to `oldest`, newest first. */
function range(count: number, oldest: number) {
  return Array.from(
    { length: count },
    (_, index) => oldest + count - 1 - index,
  );
}

function props(
  client: MailClient,
  watched: Array<{ accountId: string; threadId: string }> | null,
) {
  return {
    client,
    accountIds: ["a"],
    tabPredicate: INBOX,
    tabReady: true,
    batchRead: 3,
    watched,
  };
}

function watching(accountId: string, threadIds: string[]) {
  return threadIds.map((threadId) => ({ accountId, threadId }));
}

function keys(read: ReturnType<typeof useCatchUpMailbox>["batch"]) {
  return read.status === "ready"
    ? read.conversations.map(
        (row) => `${row.key.accountId}:${row.key.conversationId}`,
      )
    : [];
}

function ids(read: ReturnType<typeof useCatchUpMailbox>["batch"]) {
  return read.status === "ready"
    ? read.conversations.map((row) => row.key.conversationId)
    : [];
}

function unreadMail(
  count: number,
  accountId = "a",
  times?: number[],
): ConversationSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    key: { accountId, conversationId: `c${index}` },
    subject: `Subject ${index}`,
    preview: "",
    from: "dana@example.com",
    to: "me@example.com",
    senders: ["dana@example.com"],
    latestMessageAtMs: times?.[index] ?? index,
    unread: true,
    starred: false,
    labelIds: [],
    roles: ["inbox"],
    pendingOperationIds: [],
    latestMessageId: `m${index}`,
  }));
}

/**
 * A mail engine over fixed mail, read from the queried accounts in time
 * order. `legacy` refuses the query shapes a desktop build from before Catch
 * up doesn't know, as its IPC validation does; `broken` refuses everything;
 * `unsynced` accounts have no finished sync.
 */
function fakeEngine(
  allMail: ConversationSummary[],
  {
    legacy,
    broken = false,
    unsynced = [],
  }: { legacy: boolean; broken?: boolean; unsynced?: string[] },
) {
  const seen: ConversationQuery[] = [];
  const observeMailboxWindow = (query: ConversationQuery) => {
    seen.push(query);
    const watched = conversationPredicates(query.predicate);
    const mail = allMail
      .filter(
        (row) =>
          query.accountIds.includes(row.key.accountId) &&
          (!watched ||
            watched.some(
              (predicate) =>
                predicate.accountId === row.key.accountId &&
                predicate.ids.includes(row.key.conversationId),
            )),
      )
      .sort((a, b) => a.latestMessageAtMs - b.latestMessageAtMs);
    let pages = 1;
    const refused =
      broken ||
      (legacy &&
        (query.order !== "newest_first" ||
          JSON.stringify(query.predicate).includes('"conversation"')));
    const read = (): QuerySnapshot<MailboxView> => {
      if (refused)
        return {
          status: "error",
          revision: null,
          data: null,
          refreshing: false,
          error: { code: "unavailable", retryable: true },
        };
      const ordered =
        query.order === "oldest_first" ? [...mail] : [...mail].reverse();
      const start = query.after ? Number(query.after) : 0;
      const limit = start + query.pageSize * pages;
      return {
        status: "ready",
        revision: null,
        refreshing: false,
        error: null,
        data: {
          conversations: ordered.slice(start, limit),
          counts: {
            matchingConversations: mail.length,
            unreadConversations: mail.length,
            extent: "complete_scope",
          },
          nextPage: ordered.length > limit ? String(limit) : null,
          coverage: query.accountIds.map((accountId) => ({
            accountId,
            scopeId: "account",
            metadata: "complete",
            content: "not_requested",
            indexedContent: "not_requested",
            lastCompletedSyncAtMs: unsynced.includes(accountId) ? null : 1,
          })),
          connection: "ready",
        },
      };
    };
    let snapshot = read();
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => listeners.clear(),
      loadMore: async () => {
        pages += 1;
        snapshot = read();
        for (const listener of listeners) listener();
      },
    };
  };
  return {
    client: {
      observeMailboxWindow,
      observeMailbox: observeMailboxWindow,
    } as unknown as MailClient,
    orders: () => [...new Set(seen.map((query) => query.order))],
    reads: () => seen.length,
    queries: () => [...seen],
  };
}

/** The conversation predicates a query names, or null for none. */
function conversationPredicates(
  predicate: MailPredicate,
): Array<{ ids: string[]; accountId?: string }> | null {
  if (predicate.kind === "conversation") return [predicate];
  if (predicate.kind !== "all" && predicate.kind !== "any") return null;
  const found = predicate.predicates.flatMap(
    (child) => conversationPredicates(child) ?? [],
  );
  return found.length ? found : null;
}
