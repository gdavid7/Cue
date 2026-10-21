/** @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailClient } from "@inboxzero/mail-core/engine";
import {
  mailPredicateSchema,
  type Coverage,
  type MailboxView,
  type QuerySnapshot,
} from "@inboxzero/mail-core/queries";
import { MailEngineProvider } from "@inboxzero/mail-react/MailEngineProvider";
import {
  labelNamesToAccountScopedPredicate,
  useCombinedMailThreads,
} from "./use-combined-mail-threads";

const GMAIL = {
  id: "gmail",
  email: "ada@gmail.com",
  name: null,
  image: null,
  provider: "google",
};
const OUTLOOK = {
  id: "outlook",
  email: "david@brightline.io",
  name: null,
  image: null,
  provider: "microsoft",
};

// Each fake engine's live mailbox subscriptions, so a test can't leave a
// mounted hook behind to render after its jsdom environment is torn down.
const liveSubscriptions = new Set<Set<() => void>>();

describe("useCombinedMailThreads", () => {
  // Vitest globals are off, so Testing Library doesn't unmount on its own.
  afterEach(() => {
    cleanup();
    const leaked = [...liveSubscriptions].some((set) => set.size > 0);
    liveSubscriptions.clear();
    expect(leaked).toBe(false);
  });

  it("starts the first sync for an included account this browser has never synced, and shows its mail once it lands", async () => {
    const engine = fakeEngine(
      mailboxSnapshot({
        conversations: [conversation("gmail", "g-1")],
        coverage: [
          coverage("gmail", 10),
          // The engine has never seen the Outlook account in this browser.
          coverage("outlook", null),
        ],
      }),
    );

    const { result } = renderHook(
      () =>
        useCombinedMailThreads({
          accounts: [GMAIL, OUTLOOK],
          emailAccountId: "gmail",
          enabled: true,
          isUnread: false,
        }),
      { wrapper: engine.wrapper },
    );

    await waitFor(() =>
      expect(engine.client.ensureAccount).toHaveBeenCalledWith({
        accountId: "outlook",
        provider: "microsoft",
      }),
    );
    expect(engine.client.ensureAccount).not.toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "gmail" }),
    );
    await waitFor(() =>
      expect(engine.client.requestSync).toHaveBeenCalledWith(["outlook"]),
    );
    expect(result.current.firstSyncAccounts).toEqual([OUTLOOK]);
    expect(result.current.threads.map((thread) => thread.id)).toEqual(["g-1"]);

    act(() =>
      engine.push(
        mailboxSnapshot({
          conversations: [
            conversation("outlook", "o-1"),
            conversation("gmail", "g-1"),
          ],
          coverage: [coverage("gmail", 10), coverage("outlook", 20)],
        }),
      ),
    );

    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      "o-1",
      "g-1",
    ]);
    expect(result.current.firstSyncAccounts).toEqual([]);
  });

  it("does not report an account whose connection failed as still loading", async () => {
    const engine = fakeEngine(
      mailboxSnapshot({
        conversations: [],
        coverage: [coverage("gmail", 10), coverage("outlook", null)],
        connection: "blocked_auth",
      }),
      { blockedAccountIds: ["outlook"] },
    );

    const { result } = renderHook(
      () =>
        useCombinedMailThreads({
          accounts: [GMAIL, OUTLOOK],
          emailAccountId: "gmail",
          enabled: true,
          isUnread: false,
        }),
      { wrapper: engine.wrapper },
    );

    await waitFor(() =>
      expect(result.current.failedAccountIds).toEqual(["outlook"]),
    );
    expect(result.current.firstSyncAccounts).toEqual([]);
  });
});

describe("useCombinedMailThreads merged mailboxes", () => {
  afterEach(() => {
    cleanup();
    liveSubscriptions.clear();
    vi.unstubAllGlobals();
  });

  it.each([
    ["sent", "sent"],
    ["starred", "starred"],
  ] as const)("reads %s from every included account in place of the inbox, ahead of the open tab", async (mailboxType, mailbox) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const engine = fakeEngine(
      mailboxSnapshot({
        conversations: [
          conversation("outlook", "o-1"),
          conversation("gmail", "g-1"),
        ],
        coverage: [coverage("gmail", 10), coverage("outlook", 20)],
      }),
    );

    const { result } = renderHook(
      () =>
        useCombinedMailThreads({
          accounts: [GMAIL, OUTLOOK],
          emailAccountId: "gmail",
          enabled: true,
          // The inbox's unread tab and label tab don't narrow another mailbox.
          isUnread: true,
          labelNames: ["Customers"],
          mailboxType,
        }),
      { wrapper: engine.wrapper },
    );

    expect(engine.client.observeMailbox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        accountIds: ["gmail", "outlook"],
        predicate: { kind: "mailbox", mailbox },
      }),
    );
    expect(
      result.current.threads.map((thread) => [
        thread.id,
        (thread as { account?: { email: string } }).account?.email,
      ]),
    ).toEqual([
      ["o-1", OUTLOOK.email],
      ["g-1", GMAIL.email],
    ]);
    // Only Drafts reads the sends that hide their drafts.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves out each account's drafts that a waiting send stands in for, read as that account", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const accountId = new Headers(init?.headers).get("X-Email-Account-ID");
      return Response.json({
        scheduledEmails:
          accountId === "outlook"
            ? [
                {
                  id: "send-1",
                  status: "PENDING",
                  sendAt: new Date(Date.now() + 60_000).toISOString(),
                  draftMessageIds: ["outlook-draft"],
                },
              ]
            : [],
      });
    });
    vi.stubGlobal("fetch", fetch);
    const engine = fakeEngine(
      mailboxSnapshot({
        conversations: [conversation("gmail", "g-1")],
        coverage: [coverage("gmail", 10), coverage("outlook", 20)],
      }),
    );

    renderHook(
      () =>
        useCombinedMailThreads({
          accounts: [GMAIL, OUTLOOK],
          emailAccountId: "gmail",
          enabled: true,
          isUnread: false,
          mailboxType: "draft",
        }),
      { wrapper: engine.wrapper },
    );

    await waitFor(() =>
      expect(engine.client.observeMailbox).toHaveBeenLastCalledWith(
        expect.objectContaining({
          accountIds: ["gmail", "outlook"],
          predicate: {
            kind: "all",
            predicates: [
              { kind: "mailbox", mailbox: "drafts" },
              {
                kind: "not",
                predicate: {
                  kind: "any",
                  predicates: [
                    {
                      kind: "message",
                      accountId: "outlook",
                      ids: ["outlook-draft"],
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    );
    expect(
      fetch.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get("X-Email-Account-ID"),
      ),
    ).toEqual(["gmail", "outlook"]);
  });

  it("caps the hidden draft ids across accounts, keeping the newest of each", async () => {
    const idsFor = (prefix: string) =>
      Array.from({ length: 6000 }, (_, index) => `${prefix}-${index}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const accountId = new Headers(init?.headers).get("X-Email-Account-ID");
        return Response.json({
          scheduledEmails: [
            {
              id: `send-${accountId}`,
              status: "PENDING",
              sendAt: new Date(Date.now() + 60_000).toISOString(),
              draftMessageIds: idsFor(accountId ?? ""),
            },
          ],
        });
      }),
    );
    const engine = fakeEngine(
      mailboxSnapshot({
        conversations: [conversation("gmail", "g-1")],
        coverage: [coverage("gmail", 10), coverage("outlook", 20)],
      }),
    );

    renderHook(
      () =>
        useCombinedMailThreads({
          accounts: [GMAIL, OUTLOOK],
          emailAccountId: "gmail",
          enabled: true,
          isUnread: false,
          mailboxType: "draft",
        }),
      { wrapper: engine.wrapper },
    );

    await waitFor(() => {
      const [{ predicate }] = engine.client.observeMailbox.mock
        .lastCall as unknown as [
        {
          predicate: {
            predicates: {
              predicate?: {
                predicates: { accountId: string; ids: string[] }[];
              };
            }[];
          };
        },
      ];
      const messages = predicate.predicates[1]?.predicate?.predicates ?? [];
      expect(
        messages.map(({ accountId, ids }) => [accountId, ids.length]),
      ).toEqual([
        ["gmail", 6000],
        ["outlook", 4000],
      ]);
      expect(messages[1]?.ids[0]).toBe("outlook-2000");
    });
  });
});

describe("labelNamesToAccountScopedPredicate", () => {
  it("resolves the same label name to each account's own label id", () => {
    expect(
      labelNamesToAccountScopedPredicate({
        accountIds: ["acc-1", "acc-2"],
        labelNames: ["Customers"],
        labelsByAccount: {
          "acc-1": {
            "label-a": { id: "label-a", name: "Customers", type: "user" },
          },
          "acc-2": {
            "label-b": { id: "label-b", name: "Customers", type: "user" },
          },
        },
      }),
    ).toEqual({
      kind: "all",
      predicates: [
        { kind: "role", role: "inbox" },
        {
          kind: "any",
          predicates: [
            {
              kind: "membership",
              membership: "label",
              id: "label-a",
              accountId: "acc-1",
            },
            {
              kind: "membership",
              membership: "label",
              id: "label-b",
              accountId: "acc-2",
            },
          ],
        },
      ],
    });
  });

  it("does not let the same label id on another account match a different name", () => {
    expect(
      labelNamesToAccountScopedPredicate({
        accountIds: ["acc-1", "acc-2"],
        labelNames: ["Customers"],
        labelsByAccount: {
          "acc-1": {
            shared: { id: "shared", name: "Customers", type: "user" },
          },
          "acc-2": {
            shared: { id: "shared", name: "Suppliers", type: "user" },
          },
        },
      }),
    ).toEqual({
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
    });
  });

  it("matches no rows while selected label mappings are unloaded", () => {
    expect(
      labelNamesToAccountScopedPredicate({
        accountIds: ["acc-1"],
        labelNames: ["Customers"],
        labelsByAccount: {},
      }),
    ).toEqual({
      kind: "all",
      predicates: [
        { kind: "role", role: "inbox" },
        { kind: "any", predicates: [] },
      ],
    });
  });

  it("chunks more than 32 account labels into schema-valid OR groups", () => {
    const accountIds = Array.from({ length: 40 }, (_, index) => `acc-${index}`);
    const labelsByAccount = Object.fromEntries(
      accountIds.map((accountId) => [
        accountId,
        {
          label: { id: `label-${accountId}`, name: "Customers", type: "user" },
        },
      ]),
    );

    const predicate = labelNamesToAccountScopedPredicate({
      accountIds,
      labelNames: ["Customers"],
      labelsByAccount,
    });

    expect(mailPredicateSchema.parse(predicate)).toEqual(predicate);
  });
});

function fakeEngine(
  initial: QuerySnapshot<MailboxView>,
  { blockedAccountIds = [] }: { blockedAccountIds?: string[] } = {},
) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  liveSubscriptions.add(listeners);
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
    ensureAccount: vi.fn(async () => undefined),
    getDiagnostics: vi.fn(async (accountId: string) => ({
      accountId,
      connection: blockedAccountIds.includes(accountId)
        ? "blocked_auth"
        : "ready",
    })),
  };
  return {
    client,
    push(next: QuerySnapshot<MailboxView>) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    wrapper({ children }: { children: ReactNode }) {
      return (
        <SWRConfig value={{ provider: () => new Map() }}>
          <MailEngineProvider client={client as unknown as MailClient}>
            {children}
          </MailEngineProvider>
        </SWRConfig>
      );
    },
  };
}

function conversation(
  accountId: string,
  conversationId: string,
): MailboxView["conversations"][number] {
  return {
    key: { accountId, conversationId },
    subject: `Subject ${conversationId}`,
    preview: "Preview",
    from: "sender@example.com",
    to: "me@example.com",
    senders: ["sender@example.com"],
    latestMessageAtMs: 1,
    unread: false,
    starred: false,
    labelIds: [],
    roles: ["inbox"],
    pendingOperationIds: [],
  };
}

function coverage(
  accountId: string,
  lastCompletedSyncAtMs: number | null,
): Coverage {
  return {
    accountId,
    scopeId: "primary",
    metadata: lastCompletedSyncAtMs == null ? "partial" : "complete",
    content: "not_requested",
    indexedContent: "not_requested",
    lastCompletedSyncAtMs,
  };
}

function mailboxSnapshot({
  conversations,
  coverage,
  connection = "ready",
}: {
  conversations: MailboxView["conversations"];
  coverage: Coverage[];
  connection?: MailboxView["connection"];
}): QuerySnapshot<MailboxView> {
  return {
    status: "ready",
    revision: { databaseEpoch: "e1", sequence: 1 },
    refreshing: false,
    error: null,
    data: {
      conversations,
      counts: {
        matchingConversations: conversations.length,
        unreadConversations: 0,
        extent: "local_coverage",
      },
      nextPage: null,
      coverage,
      connection,
    },
  };
}
