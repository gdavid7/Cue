import { describe, expect, it, vi } from "vitest";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type {
  Coverage,
  MessageSearchMatch,
  MessageSearchQuery,
} from "@inboxzero/mail-core/queries";
import { answerAssistantCount, countLocalMail } from "./assistant-count";

const ACCOUNT = "account-1";
const OTHER = "account-2";
const NOW = new Date("2026-10-15T15:00:00Z");
const HOUR = 3_600_000;

describe("countLocalMail", () => {
  it("counts every match across pages and lists the biggest senders without their addresses", async () => {
    const messages = [
      ...many(1500, (index) => ({
        from: "News <news@shop.example>",
        receivedAtMs: NOW.getTime() - index * HOUR,
      })),
      ...many(800, (index) => ({
        from: "ada@example.com",
        receivedAtMs: NOW.getTime() - index * HOUR - 30_000,
      })),
      // Mail the user sent is counted but isn't anyone's sender group.
      ...many(45, (index) => ({
        from: "me@example.com",
        roles: ["sent" as const],
        receivedAtMs: NOW.getTime() - index * HOUR - 60_000,
      })),
    ];
    const client = pagedClient({ [ACCOUNT]: messages });

    const result = await countLocalMail({
      client,
      searches: [{ accountId: ACCOUNT, query: "", syntax: "gmail" }],
      groupBy: "sender",
      now: NOW,
      timeZone: "UTC",
    });

    expect(result).toMatchObject({
      status: "counted",
      accounts: [{ accountId: ACCOUNT, total: 2345 }],
      groupCount: 2,
      groups: [
        { count: 1500, accountId: ACCOUNT, messageId: "m-0" },
        { count: 800, accountId: ACCOUNT, messageId: "m-1500" },
      ],
    });
    if (result.status !== "counted") throw new Error("not counted");
    expect(result.newest).toHaveLength(5);
    // R-1: the server only ever sees ids and numbers.
    expect(JSON.stringify(result)).not.toContain("@");
    expect(result.groups.every((group) => group.key === undefined)).toBe(true);
  });

  it("buckets months and weeks in the user's time zone, newest first", async () => {
    const client = pagedClient({
      [ACCOUNT]: [
        // Early on 1 October in UTC is still 30 September in Los Angeles.
        msg({ receivedAtMs: Date.parse("2026-10-01T02:00:00Z") }),
        msg({ receivedAtMs: Date.parse("2026-10-14T18:00:00Z") }),
        msg({ receivedAtMs: Date.parse("2026-09-03T18:00:00Z") }),
      ],
    });
    const search = [
      { accountId: ACCOUNT, query: "", syntax: "gmail" as const },
    ];

    const months = await countLocalMail({
      client,
      searches: search,
      groupBy: "month",
      now: NOW,
      timeZone: "America/Los_Angeles",
    });
    const weeks = await countLocalMail({
      client,
      searches: search,
      groupBy: "week",
      now: NOW,
      timeZone: "America/Los_Angeles",
    });

    expect(months).toMatchObject({
      groups: [
        { key: "2026-10", count: 1 },
        { key: "2026-09", count: 2 },
      ],
    });
    expect(weeks).toMatchObject({
      groups: [
        { key: "2026-10-12", count: 1 },
        { key: "2026-09-28", count: 1 },
        { key: "2026-08-31", count: 1 },
      ],
    });
  });

  it("counts a message once for each of its labels", async () => {
    const client = pagedClient({
      [ACCOUNT]: [
        msg({ labelIds: ["Label_1", "Label_2"] }),
        msg({ labelIds: ["Label_1"], categoryIds: ["CATEGORY_PROMOTIONS"] }),
      ],
    });

    const result = await countLocalMail({
      client,
      searches: [{ accountId: ACCOUNT, query: "", syntax: "gmail" }],
      groupBy: "label",
      now: NOW,
    });

    expect(result).toMatchObject({
      accounts: [{ accountId: ACCOUNT, total: 2 }],
      groupCount: 3,
    });
    if (result.status !== "counted") throw new Error("not counted");
    expect(result.groups.map(({ key, count }) => [key, count])).toEqual([
      ["Label_1", 2],
      ["Label_2", 1],
      ["CATEGORY_PROMOTIONS", 1],
    ]);
  });

  it("lists an account it can't count exactly as unavailable and still counts the rest", async () => {
    const client = pagedClient(
      { [ACCOUNT]: [msg({})], [OTHER]: [msg({}), msg({})] },
      { [ACCOUNT]: { metadata: "partial" } },
    );

    const result = await countLocalMail({
      client,
      searches: [
        { accountId: ACCOUNT, query: "", syntax: "gmail" },
        { accountId: OTHER, query: "", syntax: "gmail" },
        // Gmail matches partial sender names, which the store can't.
        { accountId: OTHER, query: "from:ada", syntax: "gmail" },
      ],
      now: NOW,
    });

    expect(result).toMatchObject({
      accounts: [
        { accountId: ACCOUNT, unavailable: "not_synced" },
        { accountId: OTHER, total: 2 },
        { accountId: OTHER, unavailable: "unsupported_query" },
      ],
    });
  });

  it("gives up on an account rather than answer a partial count", async () => {
    const client = pagedClient({ [ACCOUNT]: many(3000, () => ({})) });

    const result = await countLocalMail({
      client,
      searches: [{ accountId: ACCOUNT, query: "", syntax: "gmail" }],
      now: NOW,
      budgetMs: 0,
    });

    expect(result).toMatchObject({
      accounts: [{ accountId: ACCOUNT, unavailable: "timeout" }],
      newest: [],
    });
  });
});

describe("answerAssistantCount", () => {
  it("counts only the browser's own accounts, whatever the request names", async () => {
    const client = pagedClient({ [ACCOUNT]: [msg({})], [OTHER]: [msg({})] });
    const submit = vi.fn(async () => undefined);

    await answerAssistantCount({
      request: {
        requestId: "request-1",
        searches: [
          { accountId: ACCOUNT, query: "", syntax: "gmail" },
          { accountId: OTHER, query: "", syntax: "gmail" },
        ],
      },
      accountIds: [ACCOUNT],
      client,
      submit,
    });

    expect(submit).toHaveBeenCalledWith({
      requestId: "request-1",
      result: expect.objectContaining({
        status: "counted",
        accounts: [{ accountId: ACCOUNT, total: 1 }],
      }),
    });
  });

  it("says when no local store can count", async () => {
    const submit = vi.fn(async () => undefined);
    await answerAssistantCount({
      request: { requestId: "request-1", searches: [] },
      accountIds: [ACCOUNT],
      client: null,
      submit,
    });
    expect(submit).toHaveBeenCalledWith({
      requestId: "request-1",
      result: { status: "unavailable", reason: "no_engine" },
    });
  });
});

let nextId = 0;

function msg(overrides: Partial<MessageSearchMatch>): MessageSearchMatch {
  const id = `x-${nextId++}`;
  return {
    messageId: id,
    conversationId: `c-${id}`,
    subject: "Subject",
    preview: "Preview",
    from: "ada@example.com",
    to: ["me@example.com"],
    receivedAtMs: NOW.getTime(),
    read: true,
    starred: false,
    labelIds: [],
    categoryIds: [],
    roles: ["inbox"],
    hasAttachments: false,
    ...overrides,
  };
}

function many(
  count: number,
  fields: (index: number) => Partial<MessageSearchMatch>,
): MessageSearchMatch[] {
  return Array.from({ length: count }, (_, index) => fields(index));
}

/**
 * A store that pages newest first, as the real one does, and numbers the
 * matches m-0, m-1... in the order they were given.
 */
function pagedClient(
  byAccount: Record<string, Array<Partial<MessageSearchMatch>>>,
  coverageByAccount: Record<string, Partial<Coverage>> = {},
): MailClient {
  const stored = Object.fromEntries(
    Object.entries(byAccount).map(([accountId, messages]) => [
      accountId,
      messages
        .map((fields, index) => ({
          ...msg({}),
          messageId: `m-${index}`,
          ...fields,
        }))
        .sort((a, b) => b.receivedAtMs - a.receivedAtMs),
    ]),
  );
  return {
    searchMessages: async (query: MessageSearchQuery) => {
      const messages = stored[query.accountId] ?? [];
      const start = query.after ? Number(query.after) : 0;
      const page = messages.slice(start, start + query.pageSize);
      const end = start + page.length;
      return {
        messages: page,
        nextPage: end < messages.length ? String(end) : null,
        coverage: [
          {
            accountId: query.accountId,
            scopeId: "primary",
            metadata: "complete",
            content: "complete",
            indexedContent: "complete",
            lastCompletedSyncAtMs: NOW.getTime(),
            ...coverageByAccount[query.accountId],
          },
        ],
      };
    },
  } as unknown as MailClient;
}
