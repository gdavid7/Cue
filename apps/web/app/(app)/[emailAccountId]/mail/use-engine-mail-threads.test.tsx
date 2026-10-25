/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MailClient } from "@inboxzero/mail-core/engine";
import { MailEngineProvider } from "@inboxzero/mail-react/MailEngineProvider";
import type {
  MailboxView,
  MailPredicate,
  QuerySnapshot,
} from "@inboxzero/mail-core/queries";
import type { ThreadsQuery } from "@/utils/threads/validation";
import { beginOptimisticTriage } from "@/utils/mail-engine/optimistic-triage";
import {
  getListThreadKey,
  isCombinedListThread,
  type ListThread,
} from "@/app/(app)/[emailAccountId]/mail/types";
import { useEngineMailThreads } from "./use-engine-mail-threads";

function wrapper({ children }: { children: ReactNode }) {
  return <MailEngineProvider client={null}>{children}</MailEngineProvider>;
}

const GMAIL = new Map([["acc-1", "google" as const]]);

describe("useEngineMailThreads", () => {
  it("keeps the disabled empty result stable across query identity changes", async () => {
    const { result, rerender } = renderHook(
      ({ query }: { query: ThreadsQuery }) =>
        useEngineMailThreads({
          emailAccountId: "acc-1",
          providers: GMAIL,
          query,
          enabled: false,
        }),
      {
        initialProps: { query: { type: "inbox" } as ThreadsQuery },
        wrapper,
      },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const emptyThreads = result.current.threads;

    rerender({ query: { type: "inbox" } as ThreadsQuery });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.threads).toBe(emptyThreads);
  });

  it("reads as loading, not empty, while the mail engine is still starting", () => {
    const { result } = renderHook(
      () =>
        useEngineMailThreads({
          emailAccountId: "acc-1",
          providers: GMAIL,
          query: { type: "inbox" } as ThreadsQuery,
        }),
      { wrapper },
    );

    // The mail screen shows before the engine is ready; an empty inbox now
    // would claim there's no mail.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.hasRemoteResponse).toBe(false);
    expect(result.current.threads).toEqual([]);
  });

  it("does not claim load-more support when the client only exposes a single mailbox page", async () => {
    const observeMailbox = vi.fn(() => staticMailboxHandle(mailboxSnapshot()));
    const client = {
      observeMailbox,
      observeConversation: vi.fn(),
      observeOperation: vi.fn(),
      submitMetadata: vi.fn(),
      submitConversations: vi.fn(),
      saveDraft: vi.fn(),
      readDraft: vi.fn(),
      submitSend: vi.fn(),
      cancelOperation: vi.fn(),
      requestSync: vi.fn(async () => ({ status: "scheduled" as const })),
      ensureMessageContent: vi.fn(),
      getDiagnostics: vi.fn(async () => ({
        accountId: "acc-1",
        revision: { databaseEpoch: "e1", sequence: 1 },
        connection: "ready" as const,
        coverage: [],
        pendingOperations: 0,
        uncertainOperations: 0,
        pendingJobs: 0,
        oldestPendingAtMs: null,
        commands: [],
      })),
      purgeAccount: vi.fn(),
    } as unknown as MailClient;
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <MailEngineProvider client={client}>{children}</MailEngineProvider>
    );

    const { result } = renderHook(
      () =>
        useEngineMailThreads({
          emailAccountId: "acc-1",
          providers: GMAIL,
          query: { type: "inbox" } as ThreadsQuery,
        }),
      { wrapper: clientWrapper },
    );

    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(result.current.hasMore).toBe(false);

    await result.current.loadMore();

    expect(observeMailbox).toHaveBeenCalledTimes(1);
  });

  it("counts a first sync as complete by the primary stream, like the last-synced time", async () => {
    const scope = (scopeId: string, lastCompletedSyncAtMs: number | null) => ({
      accountId: "acc-1",
      scopeId,
      metadata: "partial" as const,
      content: "not_requested" as const,
      indexedContent: "not_requested" as const,
      lastCompletedSyncAtMs,
    });
    const snapshot = (coverage: ReturnType<typeof scope>[]) => {
      const base = mailboxSnapshot();
      return { ...base, data: { ...base.data!, coverage } };
    };
    const render = (coverage: ReturnType<typeof scope>[]) =>
      renderHook(
        () =>
          useEngineMailThreads({
            emailAccountId: "acc-1",
            query: { type: "inbox" } as ThreadsQuery,
          }),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <MailEngineProvider
              client={
                {
                  observeMailbox: () => staticMailboxHandle(snapshot(coverage)),
                  getDiagnostics: vi.fn(async () => ({ coverage: [] })),
                  requestSync: vi.fn(async () => ({ status: "scheduled" })),
                } as unknown as MailClient
              }
            >
              {children}
            </MailEngineProvider>
          ),
        },
      );

    const otherScopeOnly = render([scope("primary", null), scope("other", 5)]);
    await waitFor(() =>
      expect(otherScopeOnly.result.current.threads).toHaveLength(1),
    );
    expect(otherScopeOnly.result.current.hasCompletedSync).toBe(false);
    expect(otherScopeOnly.result.current.lastSyncedAtMs).toBeNull();

    const primaryDone = render([scope("primary", 9), scope("other", null)]);
    await waitFor(() =>
      expect(primaryDone.result.current.threads).toHaveLength(1),
    );
    expect(primaryDone.result.current.hasCompletedSync).toBe(true);
  });

  type AccountSearch = NonNullable<MailboxView["providerSearch"]>[number];
  function renderSearch(q: string, providerSearch: AccountSearch[]) {
    const snapshot = mailboxSnapshot([]);
    if (snapshot.data) snapshot.data.providerSearch = providerSearch;
    const client = {
      observeMailbox: vi.fn(() => staticMailboxHandle(snapshot)),
      requestSync: vi.fn(async () => ({ status: "scheduled" as const })),
    } as unknown as MailClient;
    return renderHook(
      () =>
        useEngineMailThreads({
          emailAccountId: "acc-1",
          providers: GMAIL,
          query: { q },
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <MailEngineProvider client={client}>{children}</MailEngineProvider>
        ),
      },
    );
  }

  it.each([
    // Busy, out of reach and signed out are told apart, whatever the local
    // mail answers.
    ["busy", "from:amy", "busy"],
    ["unavailable", "from:amy", "unavailable"],
    ["reconnect", "from:amy", "reconnect"],
    ["unavailable", "larger:5M", "unavailable"],
    // Only a search the local mail can't answer at all needs the provider.
    ["unsupported", "larger:5M", "unsupported"],
    ["unsupported", "from:amy", null],
    ["searching", "larger:5M", null],
    ["complete", "larger:5M", null],
  ] as const)("reports a provider search that is %s for %s", async (state, q, kind) => {
    const { result } = renderSearch(q, [
      { accountId: "acc-1", state, answered: false },
    ]);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.providerSearchNotice).toEqual(
      kind ? { kind, accountId: "acc-1", partial: false } : null,
    );
  });

  it("names the most pressing account, and says when it already answered part", async () => {
    const { result } = renderSearch("larger:5M", [
      { accountId: "gmail", state: "busy", answered: true },
      { accountId: "outlook", state: "reconnect", answered: false },
      { accountId: "other", state: "complete", answered: true },
    ]);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.providerSearchNotice).toEqual({
      kind: "reconnect",
      accountId: "outlook",
      partial: false,
    });

    const partial = renderSearch("larger:5M", [
      { accountId: "gmail", state: "busy", answered: true },
    ]);
    await waitFor(() => expect(partial.result.current.isLoading).toBe(false));
    expect(partial.result.current.providerSearchNotice?.partial).toBe(true);
  });

  it("holds back an empty answer while a committed search is still running", async () => {
    const searching = renderSearch("larger:5M", [
      { accountId: "acc-1", state: "searching", answered: false },
    ]);
    await waitFor(() => expect(searching.result.current.isLoading).toBe(false));
    expect(searching.result.current.providerSearchPending).toBe(true);

    const answered = renderSearch("larger:5M", [
      { accountId: "acc-1", state: "complete", answered: true },
    ]);
    await waitFor(() => expect(answered.result.current.isLoading).toBe(false));
    expect(answered.result.current.providerSearchPending).toBe(false);
  });

  it("keeps a search still being typed off the provider", async () => {
    const observeMailbox = vi.fn(() =>
      staticMailboxHandle(mailboxSnapshot([])),
    );
    const client = {
      observeMailbox,
      requestSync: vi.fn(async () => ({ status: "scheduled" as const })),
    } as unknown as MailClient;
    renderHook(
      () =>
        useEngineMailThreads({
          emailAccountId: "acc-1",
          providers: GMAIL,
          query: { q: "is:unr" },
          providerSearch: false,
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <MailEngineProvider client={client}>{children}</MailEngineProvider>
        ),
      },
    );
    await waitFor(() => expect(observeMailbox).toHaveBeenCalled());
    expect(observeMailbox).toHaveBeenCalledWith(
      expect.objectContaining({ providerSearch: false }),
    );
  });

  it("passes explicit account-scoped predicates to the engine", async () => {
    const predicate: MailPredicate = {
      kind: "all",
      predicates: [
        { kind: "role", role: "inbox" },
        {
          kind: "any",
          predicates: [
            {
              kind: "membership",
              membership: "label",
              id: "shared",
              accountId: "acc-1",
            },
          ],
        },
      ],
    };
    const observeMailbox = vi.fn(() => staticMailboxHandle(mailboxSnapshot()));
    const client = {
      observeMailbox,
      observeConversation: vi.fn(),
      observeOperation: vi.fn(),
      submitMetadata: vi.fn(),
      submitConversations: vi.fn(),
      saveDraft: vi.fn(),
      readDraft: vi.fn(),
      submitSend: vi.fn(),
      cancelOperation: vi.fn(),
      requestSync: vi.fn(async () => ({ status: "scheduled" as const })),
      ensureMessageContent: vi.fn(),
      getDiagnostics: vi.fn(),
      purgeAccount: vi.fn(),
    } as unknown as MailClient;
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <MailEngineProvider client={client}>{children}</MailEngineProvider>
    );

    renderHook(
      () =>
        useEngineMailThreads({
          emailAccountId: "acc-1",
          providers: GMAIL,
          accountIds: ["acc-1", "acc-2"],
          query: { type: "inbox" } as ThreadsQuery,
          predicate,
        }),
      { wrapper: clientWrapper },
    );

    await waitFor(() => expect(observeMailbox).toHaveBeenCalled());
    expect(observeMailbox).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIds: ["acc-1", "acc-2"],
        predicate,
      }),
    );
  });

  it("keeps unchanged rows when a pushed snapshot edits another conversation", async () => {
    let snapshot = mailboxSnapshot([conversation("c-1"), conversation("c-2")]);
    const listeners = new Set<() => void>();
    const push = (next: QuerySnapshot<MailboxView>) => {
      snapshot = next;
      for (const listener of listeners) listener();
    };
    const client = {
      observeMailbox: vi.fn(() => ({
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close: () => undefined,
      })),
      requestSync: vi.fn(async () => ({ status: "scheduled" as const })),
    } as unknown as MailClient;
    const clientWrapper = ({ children }: { children: ReactNode }) => (
      <MailEngineProvider client={client}>{children}</MailEngineProvider>
    );
    const { result } = renderHook(
      () =>
        useEngineMailThreads({
          emailAccountId: "acc-1",
          providers: GMAIL,
          query: { type: "inbox" } as ThreadsQuery,
        }),
      { wrapper: clientWrapper },
    );
    await waitFor(() => expect(result.current.threads).toHaveLength(2));
    const [first, second] = result.current.threads;

    act(() =>
      push(
        mailboxSnapshot([
          conversation("c-1"),
          { ...conversation("c-2"), starred: true },
        ]),
      ),
    );

    expect(result.current.threads[0]).toBe(first);
    expect(result.current.threads[1]).not.toBe(second);

    const afterEdit = result.current.threads;
    act(() =>
      push(
        mailboxSnapshot([
          conversation("c-1"),
          { ...conversation("c-2"), starred: true },
        ]),
      ),
    );

    expect(result.current.threads).toBe(afterEdit);
  });

  it("shows triage at once and never lets an older snapshot bring the row back", async () => {
    const { client, push, result } = renderPushedInbox([
      conversation("c-1"),
      conversation("c-2"),
    ]);
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    let retireArchive: (() => void) | undefined;
    act(() => {
      retireArchive = beginOptimisticTriage(client, {
        accountId: "acc-1",
        conversationIds: ["c-2"],
        change: { kind: "archive" },
      });
      beginOptimisticTriage(client, {
        accountId: "acc-1",
        conversationIds: ["c-1"],
        change: { kind: "set_starred", starred: true },
      });
    });

    expect(result.current.threads.map((thread) => thread.id)).toEqual(["c-1"]);
    expect(result.current.threads[0].messages[0].labelIds).toContain("STARRED");

    // A sync that finished before the engine wrote the archive.
    act(() =>
      push(mailboxSnapshot([conversation("c-1"), conversation("c-2")])),
    );
    expect(result.current.threads.map((thread) => thread.id)).toEqual(["c-1"]);

    // The write failed: the row comes back where it was.
    act(() => retireArchive?.());
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      "c-1",
      "c-2",
    ]);
  });
});

describe("useEngineMailThreads unreachable accounts", () => {
  it("names no failed account until the check answers for the current connection", async () => {
    let snapshot = mailboxSnapshot();
    const listeners = new Set<() => void>();
    const push = (connection: "offline" | "blocked_auth") => {
      snapshot = {
        ...snapshot,
        data: { ...snapshot.data!, connection },
      };
      for (const listener of listeners) listener();
    };
    let answerSecondCheck: (() => void) | undefined;
    const getDiagnostics = vi
      .fn()
      .mockResolvedValueOnce({ connection: "offline" })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerSecondCheck = () => resolve({ connection: "ready" });
          }),
      );
    const client = {
      observeMailbox: () => ({
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close: () => undefined,
      }),
      getDiagnostics,
      requestSync: vi.fn(async () => ({ status: "scheduled" as const })),
    } as unknown as MailClient;
    const { result } = renderHook(
      () =>
        useEngineMailThreads({
          emailAccountId: "acc-1",
          providers: GMAIL,
          query: { type: "inbox" } as ThreadsQuery,
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <MailEngineProvider client={client}>{children}</MailEngineProvider>
        ),
      },
    );

    act(() => push("offline"));
    await waitFor(() =>
      expect(result.current.failedAccountIds).toEqual(["acc-1"]),
    );

    // The connection changed, and the account may well have recovered: the
    // earlier answer says nothing about it.
    act(() => push("blocked_auth"));
    expect(result.current.failedAccountIds).toEqual([]);

    await act(async () => answerSecondCheck?.());
    await waitFor(() => expect(getDiagnostics).toHaveBeenCalledTimes(2));
    expect(result.current.failedAccountIds).toEqual([]);
  });
});

describe("useEngineMailThreads in All inboxes", () => {
  it("shows a message delivered to two accounts once, saying where else it is", async () => {
    const { result } = renderAllInboxes([
      copy("acc-2", "c-new", "shared@example.com", 3),
      copy("acc-1", "c-old", "shared@example.com", 2),
      copy("acc-1", "c-other", "<other@example.com>", 1),
    ]);

    await waitFor(() => expect(result.current.threads).toHaveLength(2));
    // The newest copy stands for both, so the row keeps one key and one account.
    expect(rows(result.current.threads)).toEqual([
      { key: "acc-2:c-new", alsoIn: ["one@example.com"] },
      { key: "acc-1:c-other", alsoIn: [] },
    ]);
  });

  // The account the user is in stands for a message that reached several at
  // once, whichever the store happens to list first.
  it("shows the routed account's copy when the copies arrived together", async () => {
    const { result } = renderAllInboxes(
      [
        copy("acc-1", "c-1", "<same@example.com>", 2),
        copy("acc-2", "c-2", "<same@example.com>", 2),
      ],
      INBOX_QUERY,
      "acc-2",
    );

    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(rows(result.current.threads)).toEqual([
      { key: "acc-2:c-2", alsoIn: ["one@example.com"] },
    ]);
  });

  it("keeps the newer copy over the routed account's older one", async () => {
    const { result } = renderAllInboxes(
      [
        copy("acc-1", "c-1", "<same@example.com>", 3),
        copy("acc-2", "c-2", "<same@example.com>", 2),
      ],
      INBOX_QUERY,
      "acc-2",
    );

    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(rows(result.current.threads)).toEqual([
      { key: "acc-1:c-1", alsoIn: ["two@example.com"] },
    ]);
  });

  it("keeps rows of one account apart, even when they share a Message-ID", async () => {
    const { result } = renderAllInboxes([
      copy("acc-1", "c-1", "<dup@example.com>", 3),
      copy("acc-1", "c-2", "<dup@example.com>", 2),
      copy("acc-2", "c-3", "<dup@example.com>", 1),
      copy("acc-2", "c-4", "<dup@example.com>", 0),
    ]);

    await waitFor(() => expect(result.current.threads).toHaveLength(2));
    // Two conversations in one mailbox stay two rows; each takes in one copy
    // from the other account.
    expect(rows(result.current.threads)).toEqual([
      { key: "acc-1:c-1", alsoIn: ["two@example.com"] },
      { key: "acc-1:c-2", alsoIn: ["two@example.com"] },
    ]);
  });

  it("collapses only rows whose newest message has a Message-ID", async () => {
    const { result } = renderAllInboxes([
      copy("acc-1", "c-1", undefined, 2),
      copy("acc-2", "c-2", undefined, 1),
    ]);

    await waitFor(() => expect(result.current.threads).toHaveLength(2));
    expect(rows(result.current.threads)).toEqual([
      { key: "acc-1:c-1", alsoIn: [] },
      { key: "acc-2:c-2", alsoIn: [] },
    ]);
  });

  // A row in Drafts is the user's own draft in that account; two drafts
  // replying to one message are still two drafts.
  it("keeps each account's drafts apart in Drafts", async () => {
    const { result } = renderAllInboxes(
      [
        copy("acc-1", "c-1", "<asked@example.com>", 2),
        copy("acc-2", "c-2", "<asked@example.com>", 1),
      ],
      { type: "draft" },
    );

    await waitFor(() => expect(result.current.threads).toHaveLength(2));
  });

  // The row's actions archive every copy (useThreadActions), each in its own
  // account, so the message doesn't come back from the other account.
  it("stays gone once every copy is archived", async () => {
    const { client, result } = renderAllInboxes([
      copy("acc-2", "c-new", "<shared@example.com>", 2),
      copy("acc-1", "c-old", "<shared@example.com>", 1),
    ]);
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(
      isCombinedListThread(result.current.threads[0]) &&
        result.current.threads[0].copies,
    ).toEqual([{ accountId: "acc-1", threadId: "c-old", inInbox: true }]);

    act(() => {
      for (const [accountId, conversationId] of [
        ["acc-2", "c-new"],
        ["acc-1", "c-old"],
      ])
        beginOptimisticTriage(client, {
          accountId,
          conversationIds: [conversationId],
          change: { kind: "archive" },
        });
    });

    expect(result.current.threads).toEqual([]);
  });

  it("reads as unread while any copy is unread", async () => {
    const { result } = renderAllInboxes([
      { ...copy("acc-2", "c-new", "<shared@example.com>", 2), unread: false },
      { ...copy("acc-1", "c-old", "<shared@example.com>", 1), unread: true },
    ]);

    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(result.current.threads[0].messages[0].labelIds).toContain("UNREAD");
  });
});

const ALL_INBOXES_ACCOUNTS = {
  "acc-1": { id: "acc-1", email: "one@example.com", name: null, image: null },
  "acc-2": { id: "acc-2", email: "two@example.com", name: null, image: null },
};

function renderAllInboxes(
  conversations: MailboxView["conversations"],
  query: ThreadsQuery = INBOX_QUERY,
  emailAccountId = "acc-1",
) {
  const snapshot = mailboxSnapshot(conversations);
  const client = {
    observeMailbox: vi.fn(() => staticMailboxHandle(snapshot)),
    requestSync: vi.fn(async () => ({ status: "scheduled" as const })),
  } as unknown as MailClient;
  const { result } = renderHook(
    () =>
      useEngineMailThreads({
        emailAccountId,
        accountIds: ACCOUNT_IDS,
        accounts: ALL_INBOXES_ACCOUNTS,
        providers: ALL_INBOXES_PROVIDERS,
        query,
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MailEngineProvider client={client}>{children}</MailEngineProvider>
      ),
    },
  );
  return { client, result };
}

const ACCOUNT_IDS = ["acc-1", "acc-2"];
const ALL_INBOXES_PROVIDERS = new Map(
  ACCOUNT_IDS.map((id) => [id, "google" as const]),
);
const INBOX_QUERY: ThreadsQuery = { type: "inbox" };

function copy(
  accountId: string,
  conversationId: string,
  latestInternetMessageId: string | undefined,
  latestMessageAtMs: number,
): MailboxView["conversations"][number] {
  return {
    ...conversation(conversationId),
    key: { accountId, conversationId },
    latestMessageAtMs,
    ...(latestInternetMessageId ? { latestInternetMessageId } : {}),
  };
}

function rows(threads: ListThread[]) {
  return threads.map((thread) => ({
    key: getListThreadKey(thread),
    alsoIn: isCombinedListThread(thread)
      ? (thread.alsoIn ?? []).map((account) => account.email)
      : [],
  }));
}

function renderPushedInbox(initial: MailboxView["conversations"]) {
  let snapshot = mailboxSnapshot(initial);
  const listeners = new Set<() => void>();
  const push = (next: QuerySnapshot<MailboxView>) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const client = {
    observeMailbox: vi.fn(() => ({
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => undefined,
    })),
    requestSync: vi.fn(async () => ({ status: "scheduled" as const })),
  } as unknown as MailClient;
  const clientWrapper = ({ children }: { children: ReactNode }) => (
    <MailEngineProvider client={client}>{children}</MailEngineProvider>
  );
  const { result } = renderHook(
    () =>
      useEngineMailThreads({
        emailAccountId: "acc-1",
        providers: GMAIL,
        query: { type: "inbox" } as ThreadsQuery,
      }),
    { wrapper: clientWrapper },
  );
  return { client, push, result };
}

function conversation(
  conversationId: string,
): MailboxView["conversations"][number] {
  return {
    key: { accountId: "acc-1", conversationId },
    subject: `Subject ${conversationId}`,
    preview: "Preview",
    from: "ada@example.com",
    to: "me@example.com",
    senders: ["ada@example.com"],
    latestMessageAtMs: 1,
    unread: false,
    starred: false,
    labelIds: [],
    roles: ["inbox"],
    pendingOperationIds: [],
  };
}

function staticMailboxHandle(snapshot: QuerySnapshot<MailboxView>) {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    close: () => undefined,
  };
}

function mailboxSnapshot(
  conversations = [conversation("c-1")],
): QuerySnapshot<MailboxView> {
  return {
    status: "ready",
    revision: { databaseEpoch: "e1", sequence: 1 },
    refreshing: false,
    error: null,
    data: {
      conversations: conversations.map((item) => ({
        ...item,
        key: { ...item.key },
      })),
      counts: {
        matchingConversations: 2,
        unreadConversations: 0,
        extent: "local_coverage",
      },
      nextPage: "cursor-2",
      coverage: [],
      connection: "ready",
    },
  };
}
