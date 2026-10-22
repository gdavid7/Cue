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
