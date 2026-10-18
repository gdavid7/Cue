import { describe, expect, it, vi } from "vitest";
import {
  createHostRuntime,
  createMailEngine,
  type MailClient,
} from "@inboxzero/mail-core/engine";
import type { MailboxSource } from "@inboxzero/mail-core/ports/mailbox-source";
import type {
  Coverage,
  MessageSearchMatch,
  MessageSearchPage,
} from "@inboxzero/mail-core/queries";
import { createNodeSqliteDriver } from "@inboxzero/mail-sqlite/node";
import { createSqliteMailStore } from "@inboxzero/mail-sqlite/store";
import {
  answerAssistantSearch,
  gmailQueryToLocalSearch,
  outlookQueryToLocalSearch,
  searchLocalMail,
} from "./assistant-search";

const NOW = new Date("2026-10-15T15:00:00Z");
const ACCOUNT = "account-1";
const DAY = 86_400_000;

describe("gmailQueryToLocalSearch", () => {
  it("searches mail outside spam and trash for plain words, like Gmail", () => {
    expect(gmailQueryToLocalSearch("offer letter", NOW)).toEqual({
      predicate: {
        kind: "all",
        predicates: [
          { kind: "mailbox", mailbox: "all" },
          { kind: "text", field: "any", value: "offer letter", match: "term" },
        ],
      },
      fromAddress: null,
    });
  });

  it("maps an exact sender, subjects, read state and attachments", () => {
    expect(
      gmailQueryToLocalSearch(
        'from:Jobs@Acme.com subject:"next steps" is:unread has:attachment in:inbox',
        NOW,
      ),
    ).toEqual({
      predicate: {
        kind: "all",
        predicates: [
          { kind: "mailbox", mailbox: "inbox" },
          {
            kind: "text",
            field: "subject",
            value: "next steps",
            match: "phrase",
          },
          { kind: "read", value: false },
          { kind: "has_attachment", value: true },
        ],
      },
      fromAddress: "jobs@acme.com",
    });
  });

  it("reads dates the way the Gmail API does, at midnight Pacific time", () => {
    expect(
      gmailQueryToLocalSearch("after:2026/10/01 before:2026/10/08", NOW)
        ?.predicate,
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
    expect(gmailQueryToLocalSearch("newer_than:7d", NOW)?.predicate).toEqual({
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
    "from:a@x.com from:b@x.com",
    "to:me@example.com",
    "(interview offer)",
    "category:promotions",
    "larger:5M",
    "is:important",
  ])("leaves %s to Gmail, which understands it exactly", (query) => {
    expect(gmailQueryToLocalSearch(query, NOW)).toBeNull();
  });
});

// Chat's Outlook search, like Gmail's, leaves out Junk, Deleted Items and
// drafts.
const OUTLOOK_SCOPE = {
  kind: "all",
  predicates: [
    { kind: "mailbox", mailbox: "all" },
    { kind: "not", predicate: { kind: "role", role: "draft" } },
  ],
} as const;
const NEW_YORK = "America/New_York";

// Queries are written as Graph receives them: free text inside Graph's
// $search quotes, or one bare field restriction.
describe("outlookQueryToLocalSearch", () => {
  function outlook(
    query: string,
    options: { fromEmail?: string; readState?: "read" | "unread" } = {},
  ) {
    return outlookQueryToLocalSearch({ query, ...options, timeZone: NEW_YORK });
  }

  it("matches every word, in any folder but drafts, like Graph's free text", () => {
    expect(outlook('"offer letter"')).toEqual({
      predicate: {
        kind: "all",
        predicates: [
          OUTLOOK_SCOPE,
          { kind: "text", field: "any", value: "offer letter", match: "term" },
        ],
      },
      fromAddress: null,
    });
  });

  it("matches any clause of an OR", () => {
    expect(
      outlook('"reply OR respond OR subject:approval"')?.predicate,
    ).toEqual({
      kind: "all",
      predicates: [
        OUTLOOK_SCOPE,
        {
          kind: "any",
          predicates: [
            { kind: "text", field: "any", value: "reply", match: "term" },
            { kind: "text", field: "any", value: "respond", match: "term" },
            {
              kind: "text",
              field: "subject",
              value: "approval",
              match: "term",
            },
          ],
        },
      ],
    });
  });

  it("restricts words and phrases to the subject or body", () => {
    expect(outlook('subject:"next steps"')?.predicate).toEqual({
      kind: "all",
      predicates: [
        OUTLOOK_SCOPE,
        {
          kind: "text",
          field: "subject",
          value: "next steps",
          match: "phrase",
        },
      ],
    });
    expect(outlook('"body:invoice AND subject:march"')?.predicate).toEqual({
      kind: "all",
      predicates: [
        OUTLOOK_SCOPE,
        { kind: "text", field: "body", value: "invoice", match: "term" },
        { kind: "text", field: "subject", value: "march", match: "term" },
      ],
    });
  });

  it.each([
    ["received>=2026-10-01", "2026-10-01T04:00:00Z", null],
    ["received>2026-10-01", "2026-10-02T04:00:00Z", null],
    ["received<2026-10-08", null, "2026-10-08T04:00:00Z"],
    ["received<=2026-10-08", null, "2026-10-09T04:00:00Z"],
    ["received:2026-11-01", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
  ])("reads %s as whole days in the user's time zone", (clause, after, before) => {
    expect(outlook(`"${clause}"`)?.predicate).toEqual({
      kind: "all",
      predicates: [
        OUTLOOK_SCOPE,
        {
          kind: "received",
          afterMs: after && Date.parse(after),
          beforeMs: before && Date.parse(before),
        },
      ],
    });
  });

  it("maps attachments and the structured sender and read state", () => {
    expect(
      outlook('"hasattachments:true invoice"', {
        fromEmail: "Billing@Acme.com",
        readState: "unread",
      }),
    ).toEqual({
      predicate: {
        kind: "all",
        predicates: [
          OUTLOOK_SCOPE,
          { kind: "has_attachment", value: true },
          { kind: "text", field: "any", value: "invoice", match: "term" },
          { kind: "read", value: false },
        ],
      },
      fromAddress: "billing@acme.com",
    });
    expect(outlook("", { readState: "read" })?.predicate).toEqual({
      kind: "all",
      predicates: [OUTLOOK_SCOPE, { kind: "read", value: true }],
    });
  });

  it("takes a whole sender address from the query when it agrees", () => {
    expect(
      outlook('"from:jobs@acme.com offer"', { fromEmail: "jobs@acme.com" })
        ?.fromAddress,
    ).toBe("jobs@acme.com");
    expect(
      outlook('"from:jobs@acme.com offer"', { fromEmail: "hr@acme.com" }),
    ).toBeNull();
  });

  it.each([
    "",
    '"NOT newsletter"',
    '"-newsletter"',
    '"reply OR respond invoice"',
    '"reply or respond"',
    '"from:greenhouse"',
    '"from:a@x.com OR invoice"',
    '"to:me@example.com"',
    "participants:me@example.com",
    '"sent>=2026-01-01"',
    '"received>=2026/10/01"',
    '"received>=today"',
    '"subject: question"',
    '"category:Red invoice"',
    '"importance:high"',
    '"inv*"',
    '"interview \\\\ offer"',
    'subject:"say \\"hi\\""',
  ])("leaves %s to Graph, which understands it exactly", (query) => {
    expect(outlook(query)).toBeNull();
  });
});

describe("searchLocalMail against the local store", () => {
  it("returns the sender's message in a thread, not the reply after it", async () => {
    const { client, close } = await engineWith([
      message("alice-1", "c-1", {
        from: "Alice <alice@example.com>",
        receivedAtMs: Date.parse("2026-10-01T12:00:00Z"),
        read: false,
      }),
      message("my-reply", "c-1", {
        from: "me@example.com",
        receivedAtMs: Date.parse("2026-10-02T12:00:00Z"),
        roles: ["sent"],
      }),
    ]);
    try {
      const result = await searchLocalMail({
        client,
        accountId: ACCOUNT,
        query: "from:alice@example.com",
        limit: 20,
        now: NOW,
      });

      expect(result).toEqual({
        status: "ok",
        messages: [
          {
            id: "alice-1",
            threadId: "c-1",
            subject: "Subject alice-1",
            from: "Alice <alice@example.com>",
            to: "me@example.com",
            snippet: "Preview alice-1",
            date: "2026-10-01T12:00:00.000Z",
            labelIds: ["INBOX", "UNREAD"],
            hasAttachments: false,
          },
        ],
      });
    } finally {
      await close();
    }
  });

  it.each([
    ["in:drafts", ["draft"]],
    ["in:sent", ["sent"]],
    ["is:unread", ["unread"]],
    ["after:2026/10/03", ["draft"]],
    ["before:2026/10/02", ["unread"]],
  ])("answers %s with the matching messages only", async (query, expected) => {
    const { client, close } = await engineWith([
      message("unread", "c-1", {
        receivedAtMs: Date.parse("2026-10-01T12:00:00Z"),
        read: false,
      }),
      message("sent", "c-1", {
        receivedAtMs: Date.parse("2026-10-02T12:00:00Z"),
        roles: ["sent"],
      }),
      message("draft", "c-1", {
        receivedAtMs: Date.parse("2026-10-03T12:00:00Z"),
        roles: ["draft"],
      }),
    ]);
    try {
      const result = await searchLocalMail({
        client,
        accountId: ACCOUNT,
        query,
        limit: 20,
        now: NOW,
      });

      expect(
        result.status === "ok" && result.messages.map((m) => m.id),
      ).toEqual(expected);
    } finally {
      await close();
    }
  });

  it("counts messages toward the limit and pages with a local token", async () => {
    const { client, close } = await engineWith(
      ["a", "b", "c"].map((id, i) =>
        message(`m-${id}`, "c-1", {
          receivedAtMs: Date.parse("2026-10-01T12:00:00Z") + i * DAY,
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
      expect(first.status === "ok" && first.messages.map((m) => m.id)).toEqual([
        "m-c",
        "m-b",
      ]);
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
      ).toEqual(["m-a"]);
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
});

describe("searchLocalMail for Outlook against the local store", () => {
  // Outlook sync stores every folder but Drafts, Junk and Deleted Items;
  // mail the user just deleted in Cue is in the trash locally until the
  // provider confirms the move.
  it("searches every synced folder and leaves out mail just deleted, as Graph's chat search does", async () => {
    const { client, close } = await engineWith([
      message("inbox", "c-1", {
        receivedAtMs: Date.parse("2026-10-01T12:00:00Z"),
        read: false,
      }),
      message("sent", "c-2", {
        receivedAtMs: Date.parse("2026-10-02T12:00:00Z"),
        roles: ["sent"],
        read: false,
      }),
      message("custom-folder", "c-3", {
        receivedAtMs: Date.parse("2026-10-03T12:00:00Z"),
        roles: [],
        read: false,
      }),
      message("just-deleted", "c-4", {
        receivedAtMs: Date.parse("2026-10-04T12:00:00Z"),
        roles: ["trash"],
        read: false,
      }),
    ]);
    try {
      const result = await searchLocalMail({
        client,
        accountId: ACCOUNT,
        query: "",
        syntax: "outlook",
        readState: "unread",
        limit: 20,
        now: NOW,
        timeZone: NEW_YORK,
      });

      expect(
        result.status === "ok" && result.messages.map((m) => m.id),
      ).toEqual(["custom-folder", "sent", "inbox"]);
    } finally {
      await close();
    }
  });

  it("finds an exact sender's mail from a date on", async () => {
    const { client, close } = await engineWith([
      message("before", "c-1", {
        from: "Jobs <jobs@acme.com>",
        receivedAtMs: Date.parse("2026-10-01T03:59:00Z"),
      }),
      message("in-range", "c-2", {
        from: "Jobs <jobs@acme.com>",
        receivedAtMs: Date.parse("2026-10-01T04:00:00Z"),
      }),
      message("other-sender", "c-3", {
        receivedAtMs: Date.parse("2026-10-02T12:00:00Z"),
      }),
    ]);
    try {
      const result = await searchLocalMail({
        client,
        accountId: ACCOUNT,
        query: '"received>=2026-10-01"',
        syntax: "outlook",
        fromEmail: "jobs@acme.com",
        limit: 20,
        now: NOW,
        timeZone: NEW_YORK,
      });

      expect(
        result.status === "ok" && result.messages.map((m) => m.id),
      ).toEqual(["in-range"]);
    } finally {
      await close();
    }
  });

  it("leaves Outlook queries it can't answer exactly to Graph", async () => {
    expect(
      await searchLocalMail({
        client: clientWith({ coverage: [coverage({})] }),
        accountId: ACCOUNT,
        query: '"to:me@example.com"',
        syntax: "outlook",
        limit: 20,
        now: NOW,
      }),
    ).toEqual({ status: "unavailable", reason: "unsupported_query" });
  });
});

describe("searchLocalMail gating", () => {
  it("leaves the search to Gmail until the mailbox has fully synced", async () => {
    const result = await searchLocalMail({
      client: clientWith({ coverage: [coverage({ metadata: "partial" })] }),
      accountId: ACCOUNT,
      query: "from:jobs@acme.com",
      limit: 20,
      now: NOW,
    });

    expect(result).toEqual({ status: "unavailable", reason: "not_synced" });
  });

  it("answers only searches inside the window a first sync covered", async () => {
    // A first Gmail sync keeps the last 30 days (and the inbox), so older
    // mail may exist that the store has never seen.
    const client = clientWith({
      coverage: [
        coverage({}),
        coverage({
          scopeId: "history",
          windowStartMs: NOW.getTime() - 30 * 24 * 60 * 60 * 1000,
        }),
      ],
    });
    const search = (query: string) =>
      searchLocalMail({
        client,
        accountId: ACCOUNT,
        query,
        limit: 20,
        now: NOW,
      });

    expect(await search("from:jobs@acme.com")).toEqual({
      status: "unavailable",
      reason: "not_synced",
    });
    expect(await search("from:jobs@acme.com newer_than:60d")).toEqual({
      status: "unavailable",
      reason: "not_synced",
    });
    expect((await search("from:jobs@acme.com newer_than:7d")).status).toBe(
      "ok",
    );
  });

  it("leaves word searches to Gmail until message bodies are indexed", async () => {
    const client = clientWith({
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

  it("leaves the search to Gmail when this tab's engine can't search messages", async () => {
    expect(
      await searchLocalMail({
        client: {} as MailClient,
        accountId: ACCOUNT,
        query: "from:jobs@acme.com",
        limit: 20,
        now: NOW,
      }),
    ).toEqual({ status: "unavailable", reason: "no_engine" });
  });

  it("gives up rather than keep the assistant waiting on a stalled store", async () => {
    const stalled = {
      searchMessages: () => new Promise(() => {}),
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

  it("shortens oversized fields instead of losing the answer", async () => {
    const result = await searchLocalMail({
      client: clientWith({
        coverage: [coverage({})],
        messages: [
          match({
            subject: "s".repeat(5000),
            preview: "p".repeat(5000),
            to: Array.from({ length: 500 }, (_, i) => `person${i}@example.com`),
            labelIds: Array.from({ length: 300 }, (_, i) => `Label_${i}`),
          }),
        ],
      }),
      accountId: ACCOUNT,
      query: "from:jobs@acme.com",
      limit: 20,
      now: NOW,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.messages[0].subject.length).toBeLessThanOrEqual(500);
    expect(result.messages[0].snippet.length).toBeLessThanOrEqual(500);
    expect(result.messages[0].to.length).toBeLessThanOrEqual(2000);
    expect(result.messages[0].labelIds.length).toBeLessThanOrEqual(50);
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
      client: clientWith({ coverage: [coverage({})] }),
      submit,
    });

    expect(submit).toHaveBeenCalledWith({
      requestId: request.requestId,
      result: { status: "ok", messages: [] },
    });
  });

  it("hands the search back when the answer wouldn't pass the server's checks", async () => {
    const submit = vi.fn(async () => {});

    await answerAssistantSearch({
      request,
      accountId: ACCOUNT,
      client: clientWith({
        coverage: [coverage({})],
        messages: [match({ receivedAtMs: Number.NaN })],
      }),
      submit,
    });

    expect(submit).toHaveBeenCalledWith({
      requestId: request.requestId,
      result: { status: "unavailable", reason: "error" },
    });
  });

  it("searches this tab's account whatever else the streamed request carries", async () => {
    const searchMessages = vi.fn(
      async (): Promise<MessageSearchPage> => ({
        messages: [],
        nextPage: null,
        coverage: [coverage({})],
      }),
    );

    await answerAssistantSearch({
      request: {
        ...request,
        accountId: "someone-else",
        client: null,
        timeoutMs: 1,
      } as typeof request,
      accountId: ACCOUNT,
      client: { searchMessages } as unknown as MailClient,
      submit: vi.fn(async () => {}),
    });

    expect(searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT }),
    );
  });

  it("hands the search back when the local store fails", async () => {
    const submit = vi.fn(async () => {});
    const broken = {
      searchMessages: async () => {
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

function message(
  messageId: string,
  conversationId: string,
  fields: {
    subject?: string;
    from?: string;
    receivedAtMs: number;
    read?: boolean;
    roles?: Array<"inbox" | "sent" | "draft" | "trash" | "spam">;
  },
) {
  const roles = fields.roles ?? ["inbox"];
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
      subject: fields.subject ?? `Subject ${messageId}`,
      preview: `Preview ${messageId}`,
      from: fields.from ?? "ada@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs: fields.receivedAtMs,
      read: fields.read ?? true,
      starred: false,
      folderId: null,
      labelIds: [],
      categoryIds: [],
      roles,
      hasAttachments: false,
    },
  };
}

function match(overrides: Partial<MessageSearchMatch>): MessageSearchMatch {
  return {
    messageId: "m1",
    conversationId: "c1",
    subject: "Next steps",
    preview: "Thanks",
    from: "jobs@acme.com",
    to: ["me@example.com"],
    receivedAtMs: Date.parse("2026-10-01T12:00:00Z"),
    read: true,
    starred: false,
    labelIds: [],
    categoryIds: [],
    roles: ["inbox"],
    hasAttachments: false,
    ...overrides,
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
    searchMessages: async (query) => {
      const page = await engine.searchMessages!(query);
      return {
        ...page,
        coverage: page.coverage.map((item) => ({
          ...item,
          metadata: "complete" as const,
          indexedContent: "complete" as const,
        })),
      };
    },
  };
  return { client, close: () => engine.close() };
}

function clientWith({
  coverage,
  messages = [],
}: {
  coverage: Coverage[];
  messages?: MessageSearchMatch[];
}): MailClient {
  const page: MessageSearchPage = { messages, nextPage: null, coverage };
  return { searchMessages: async () => page } as unknown as MailClient;
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
