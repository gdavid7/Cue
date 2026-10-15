import { describe, expect, it, vi } from "vitest";
import {
  createHostRuntime,
  createMailEngine,
  type MailClient,
} from "@inboxzero/mail-core/engine";
import type { MailboxSource } from "@inboxzero/mail-core/ports/mailbox-source";
import type {
  Coverage,
  MailboxView,
  QuerySnapshot,
} from "@inboxzero/mail-core/queries";
import { createNodeSqliteDriver } from "@inboxzero/mail-sqlite/node";
import { createSqliteMailStore } from "@inboxzero/mail-sqlite/store";
import {
  answerAssistantSearch,
  gmailQueryToLocalPredicate,
  searchLocalMail,
} from "./assistant-search";

const NOW = new Date("2026-10-15T15:00:00Z");
const ACCOUNT = "account-1";

describe("gmailQueryToLocalPredicate", () => {
  it("searches mail outside spam and trash for plain words, like Gmail", () => {
    expect(gmailQueryToLocalPredicate("offer letter", NOW)).toEqual({
      kind: "all",
      predicates: [
        { kind: "mailbox", mailbox: "all" },
        { kind: "text", field: "any", value: "offer letter", match: "term" },
      ],
    });
  });

  it("maps exact senders, subjects, read state and attachments", () => {
    expect(
      gmailQueryToLocalPredicate(
        'from:jobs@acme.com subject:"next steps" is:unread has:attachment in:inbox',
        NOW,
      ),
    ).toEqual({
      kind: "all",
      predicates: [
        { kind: "mailbox", mailbox: "inbox" },
        {
          kind: "address",
          field: "from",
          value: "jobs@acme.com",
          match: "address",
        },
        {
          kind: "text",
          field: "subject",
          value: "next steps",
          match: "phrase",
        },
        { kind: "read", value: false },
        { kind: "has_attachment", value: true },
      ],
    });
  });

  it("reads dates the way the Gmail API does, at midnight Pacific time", () => {
    expect(
      gmailQueryToLocalPredicate("after:2026/10/01 before:2026/10/08", NOW),
    ).toEqual({
      kind: "all",
      predicates: [
        { kind: "mailbox", mailbox: "all" },
        {
          kind: "received",
          afterMs: Date.parse("2026-10-01T07:00:00Z"),
          beforeMs: null,
        },
        {
          kind: "received",
          afterMs: null,
          beforeMs: Date.parse("2026-10-08T07:00:00Z"),
        },
      ],
    });
  });

  it("counts relative ages back from now", () => {
    expect(gmailQueryToLocalPredicate("newer_than:7d", NOW)).toEqual({
      kind: "all",
      predicates: [
        { kind: "mailbox", mailbox: "all" },
        {
          kind: "received",
          afterMs: Date.parse("2026-10-08T15:00:00Z"),
          beforeMs: null,
        },
      ],
    });
  });

  it.each([
    "jobs OR careers",
    "-newsletter",
    "label:Recruiting",
    "from:greenhouse",
    "(interview offer)",
    "category:promotions",
    "larger:5M",
    "is:important",
  ])("leaves %s to the provider, which understands it exactly", (query) => {
    expect(gmailQueryToLocalPredicate(query, NOW)).toBeNull();
  });
});

describe("answerAssistantSearch", () => {
  const request = {
    requestId: "8d4a1f8e-5f5c-4b9b-9a51-4f1f0e7a2c11",
    query: "from:jobs@acme.com",
    limit: 20,
  };

  it("tells the assistant at once when this tab has no local mail", async () => {
    const submit = vi.fn(async () => {});

    await answerAssistantSearch({
      request,
      accountId: ACCOUNT,
      client: null,
      submit,
    });

    expect(submit).toHaveBeenCalledWith({
      requestId: request.requestId,
      result: { status: "unavailable", reason: "no_engine" },
    });
  });

  it("sends the local answer back for the request", async () => {
    const submit = vi.fn(async () => {});

    await answerAssistantSearch({
      request,
      accountId: ACCOUNT,
      client: clientWithView({ coverage: [coverage({})] }),
      submit,
    });

    expect(submit).toHaveBeenCalledWith({
      requestId: request.requestId,
      result: { status: "ok", messages: [] },
    });
  });

  it("hands the search back when the local store fails", async () => {
    const submit = vi.fn(async () => {});
    const broken = {
      observeMailbox: () => {
        throw new Error("worker gone");
      },
    } as unknown as MailClient;

    await answerAssistantSearch({
      request,
      accountId: ACCOUNT,
      client: broken,
      submit,
    });

    expect(submit).toHaveBeenCalledWith({
      requestId: request.requestId,
      result: { status: "unavailable", reason: "error" },
    });
  });
});

describe("searchLocalMail", () => {
  it("answers from the local store in the shape the server search uses", async () => {
    const { client, close } = await engineWith([
      message("m-old", "c-1", {
        subject: "Interview",
        from: "jobs@acme.com",
        receivedAtMs: Date.parse("2026-10-01T12:00:00Z"),
        read: true,
      }),
      message("m-new", "c-1", {
        subject: "Re: Interview",
        from: "jobs@acme.com",
        receivedAtMs: Date.parse("2026-10-02T12:00:00Z"),
        read: false,
        hasAttachments: true,
      }),
      message("m-other", "c-2", {
        subject: "Lunch",
        from: "ada@example.com",
        receivedAtMs: Date.parse("2026-10-03T12:00:00Z"),
      }),
    ]);
    try {
      const result = await searchLocalMail({
        client,
        accountId: ACCOUNT,
        query: "from:jobs@acme.com",
        limit: 20,
        now: NOW,
      });

      expect(result).toEqual({
        status: "ok",
        messages: [
          {
            id: "m-new",
            threadId: "c-1",
            subject: "Re: Interview",
            from: "jobs@acme.com",
            to: "me@example.com",
            snippet: "Re: Interview preview",
            date: "2026-10-02T12:00:00.000Z",
            labelIds: ["INBOX", "UNREAD"],
            hasAttachments: true,
          },
        ],
      });
    } finally {
      await close();
    }
  });

  it("pages with a token that names the local store", async () => {
    const { client, close } = await engineWith(
      Array.from({ length: 3 }, (_, i) =>
        message(`m-${i}`, `c-${i}`, {
          subject: `Update ${i}`,
          from: "ada@example.com",
          receivedAtMs: Date.parse("2026-10-01T12:00:00Z") + i * 1000,
        }),
      ),
    );
    try {
      const first = await searchLocalMail({
        client,
        accountId: ACCOUNT,
        query: "from:ada@example.com",
        limit: 2,
        now: NOW,
      });
      expect(first.status).toBe("ok");
      if (first.status !== "ok") return;
      expect(first.nextPageToken).toMatch(/^local:/);

      const second = await searchLocalMail({
        client,
        accountId: ACCOUNT,
        query: "from:ada@example.com",
        limit: 2,
        pageToken: first.nextPageToken,
        now: NOW,
      });

      expect(
        second.status === "ok" && second.messages.map((m) => m.id),
      ).toEqual(["m-0"]);
    } finally {
      await close();
    }
  });

  it("finds a sender's mail among ten thousand messages in well under 100 ms", async () => {
    const { client, close } = await engineWith(
      Array.from({ length: 10_000 }, (_, i) =>
        message(`m-${i}`, `c-${i}`, {
          subject: `Message ${i}`,
          from: i % 500 === 0 ? "jobs@acme.com" : `sender${i % 97}@example.com`,
          receivedAtMs: Date.parse("2025-01-01T00:00:00Z") + i * 60_000,
        }),
      ),
    );
    try {
      // Warm the statement cache as an open app would have.
      await searchLocalMail({
        client,
        accountId: ACCOUNT,
        query: "from:ada@example.com",
        limit: 20,
        now: NOW,
      });
      const startedAt = performance.now();
      const result = await searchLocalMail({
        client,
        accountId: ACCOUNT,
        query: "from:jobs@acme.com newer_than:2y",
        limit: 20,
        now: NOW,
      });
      const elapsedMs = performance.now() - startedAt;

      const wordsStartedAt = performance.now();
      const words = await searchLocalMail({
        client,
        accountId: ACCOUNT,
        query: "message 9999",
        limit: 20,
        now: NOW,
      });
      const wordsElapsedMs = performance.now() - wordsStartedAt;

      expect(result.status === "ok" && result.messages).toHaveLength(20);
      expect(words.status === "ok" && words.messages[0]?.id).toBe("m-9999");
      console.info(
        `Local assistant search over 10,000 messages: sender ${elapsedMs.toFixed(1)} ms, words ${wordsElapsedMs.toFixed(1)} ms`,
      );
      expect(elapsedMs).toBeLessThan(100);
      expect(wordsElapsedMs).toBeLessThan(100);
    } finally {
      await close();
    }
  }, 60_000);

  it("leaves the search to the server until the mailbox has fully synced", async () => {
    const result = await searchLocalMail({
      client: clientWithView({ coverage: [coverage({ metadata: "partial" })] }),
      accountId: ACCOUNT,
      query: "from:jobs@acme.com",
      limit: 20,
      now: NOW,
    });

    expect(result).toEqual({ status: "unavailable", reason: "not_synced" });
  });

  it("leaves word searches to the server until message bodies are indexed", async () => {
    const client = clientWithView({
      coverage: [coverage({ indexedContent: "partial" })],
    });

    expect(
      await searchLocalMail({
        client,
        accountId: ACCOUNT,
        query: "offer letter",
        limit: 20,
        now: NOW,
      }),
    ).toEqual({ status: "unavailable", reason: "not_indexed" });
    expect(
      (
        await searchLocalMail({
          client,
          accountId: ACCOUNT,
          query: "from:jobs@acme.com",
          limit: 20,
          now: NOW,
        })
      ).status,
    ).toBe("ok");
  });

  it("leaves queries it can't answer exactly to the server", async () => {
    expect(
      await searchLocalMail({
        client: clientWithView({ coverage: [coverage({})] }),
        accountId: ACCOUNT,
        query: "label:Recruiting",
        limit: 20,
        now: NOW,
      }),
    ).toEqual({ status: "unavailable", reason: "unsupported_query" });
  });

  it("gives up rather than keep the assistant waiting on a stalled store", async () => {
    const stalled: MailClient = {
      observeMailbox: () => ({
        getSnapshot: () => snapshot("loading", null),
        subscribe: () => () => {},
        close: () => {},
      }),
    } as unknown as MailClient;

    expect(
      await searchLocalMail({
        client: stalled,
        accountId: ACCOUNT,
        query: "from:jobs@acme.com",
        limit: 20,
        now: NOW,
        timeoutMs: 50,
      }),
    ).toEqual({ status: "unavailable", reason: "timeout" });
  });
});

function message(
  messageId: string,
  conversationId: string,
  fields: {
    subject: string;
    from: string;
    receivedAtMs: number;
    read?: boolean;
    hasAttachments?: boolean;
  },
) {
  return {
    kind: "message_patch" as const,
    key: { accountId: ACCOUNT, messageId },
    reference: {
      provider: "google" as const,
      messageId,
      conversationId,
      version: "1",
    },
    fields: {
      subject: fields.subject,
      preview: `${fields.subject} preview`,
      from: fields.from,
      to: ["me@example.com"],
      cc: [],
      receivedAtMs: fields.receivedAtMs,
      read: fields.read ?? true,
      starred: false,
      folderId: "inbox",
      labelIds: ["INBOX"],
      categoryIds: [],
      roles: ["inbox" as const],
      hasAttachments: fields.hasAttachments ?? false,
    },
  };
}

async function engineWith(changes: ReturnType<typeof message>[]) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId: ACCOUNT,
    provider: "google",
    generation: "g1",
  });
  for (let start = 0; start < changes.length; start += 1000) {
    await store.applySyncPage({
      ownerId: "owner",
      page: {
        session: { accountId: ACCOUNT, generation: "g1" },
        requestId: `boot-${start}`,
        from: {
          streamId: "primary",
          generation: "g1",
          checkpoint: start === 0 ? null : String(start),
        },
        to: {
          streamId: "primary",
          generation: "g1",
          checkpoint: String(start + 1000),
        },
        changes: changes.slice(start, start + 1000),
        requiredHydration: [],
        roundComplete: start + 1000 >= changes.length,
      },
    });
  }
  const engine = createMailEngine({
    store,
    source: idleSource(),
    executor: {
      async execute() {
        return { status: "uncertain", receiptId: null };
      },
      async inspect() {
        return { status: "uncertain", receiptId: null };
      },
    },
    runtime: createHostRuntime(),
  });
  // The store reports what this test's sync covered; the gate on coverage is
  // tested separately.
  const client: MailClient = {
    ...engine,
    observeMailbox: (query) => {
      const handle = engine.observeMailbox(query);
      return {
        ...handle,
        getSnapshot: () => {
          const current = handle.getSnapshot();
          return current.data
            ? {
                ...current,
                data: {
                  ...current.data,
                  coverage: current.data.coverage.map((item) => ({
                    ...item,
                    metadata: "complete" as const,
                    indexedContent: "complete" as const,
                  })),
                },
              }
            : current;
        },
      };
    },
  };
  return { client, close: () => engine.close() };
}

function clientWithView({ coverage }: { coverage: Coverage[] }): MailClient {
  const view: MailboxView = {
    conversations: [],
    counts: {
      matchingConversations: 0,
      unreadConversations: 0,
      extent: "local_coverage",
    },
    nextPage: null,
    coverage,
  };
  return {
    observeMailbox: () => ({
      getSnapshot: () => snapshot("ready", view),
      subscribe: () => () => {},
      close: () => {},
    }),
  } as unknown as MailClient;
}

function coverage(overrides: Partial<Coverage>): Coverage {
  return {
    accountId: ACCOUNT,
    scopeId: "primary",
    metadata: "complete",
    content: "complete",
    indexedContent: "complete",
    lastCompletedSyncAtMs: NOW.getTime(),
    ...overrides,
  };
}

function snapshot(
  status: QuerySnapshot<MailboxView>["status"],
  data: MailboxView | null,
): QuerySnapshot<MailboxView> {
  return { status, revision: null, data, refreshing: false, error: null };
}

function idleSource(): MailboxSource {
  const paused = {
    status: "paused" as const,
    retryAfterMs: 60_000,
    reason: "unavailable" as const,
  };
  return {
    async describe() {
      return {
        status: "ok",
        value: {
          strategy: "account_history",
          supportedChanges: [],
          maxPageSize: 10,
          maxHydrationBatch: 10,
        },
      };
    },
    async discoverScopes() {
      return { status: "ok", value: { scopes: [], nextPage: null } };
    },
    async beginBootstrap() {
      return paused;
    },
    async enumerate() {
      return paused;
    },
    async readChanges() {
      return paused;
    },
    async hydrate() {
      return paused;
    },
    async readConversationMembership() {
      return paused;
    },
    async search() {
      return paused;
    },
  } as unknown as MailboxSource;
}
