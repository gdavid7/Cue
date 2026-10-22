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
import { useCatchUpMailbox } from "./use-catch-up-mailbox";

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
      useCatchUpMailbox(props(engine.client, ["c0", "c1"])),
    );
    await waitFor(() => expect(result.current.watch).not.toBeNull());
    expect(result.current.watch?.complete).toBe(true);
    expect(
      result.current.watch?.conversations.map((row) => row.key.conversationId),
    ).toContain("c0");
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

function props(client: MailClient, threadIds: string[] | null) {
  return {
    client,
    emailAccountId: "a",
    tabPredicate: INBOX,
    tabReady: true,
    batchRead: 3,
    threadIds,
  };
}

function ids(read: ReturnType<typeof useCatchUpMailbox>["batch"]) {
  return read.status === "ready"
    ? read.conversations.map((row) => row.key.conversationId)
    : [];
}

function unreadMail(count: number): ConversationSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    key: { accountId: "a", conversationId: `c${index}` },
    subject: `Subject ${index}`,
    preview: "",
    from: "dana@example.com",
    to: "me@example.com",
    senders: ["dana@example.com"],
    latestMessageAtMs: index,
    unread: true,
    starred: false,
    labelIds: [],
    roles: ["inbox"],
    pendingOperationIds: [],
    latestMessageId: `m${index}`,
  }));
}

/**
 * A mail engine over fixed mail. `legacy` refuses the query shapes a desktop
 * build from before Catch up doesn't know, as its IPC validation does;
 * `broken` refuses everything.
 */
function fakeEngine(
  mail: ConversationSummary[],
  { legacy, broken = false }: { legacy: boolean; broken?: boolean },
) {
  const seen: ConversationQuery[] = [];
  const observeMailboxWindow = (query: ConversationQuery) => {
    seen.push(query);
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
      const limit = query.pageSize * pages;
      return {
        status: "ready",
        revision: null,
        refreshing: false,
        error: null,
        data: {
          conversations: ordered.slice(0, limit),
          counts: {
            matchingConversations: mail.length,
            unreadConversations: mail.length,
            extent: "complete_scope",
          },
          nextPage: ordered.length > limit ? String(limit) : null,
          coverage: [
            {
              accountId: "a",
              scopeId: "account",
              metadata: "complete",
              content: "not_requested",
              indexedContent: "not_requested",
              lastCompletedSyncAtMs: 1,
            },
          ],
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
  };
}
