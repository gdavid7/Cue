import type { UIMessageStreamWriter } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import {
  createLocalMailSearch,
  saveLocalMailSearchResult,
} from "./local-mail-search";

const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
  },
}));

const ACCOUNT = "account-1";
const answer = {
  status: "ok" as const,
  messages: [
    {
      id: "m1",
      threadId: "t1",
      subject: "Next steps",
      from: "jobs@acme.com",
      to: "me@example.com",
      snippet: "Thanks",
      date: "2026-10-02T12:00:00.000Z",
      labelIds: ["INBOX"],
      hasAttachments: false,
    },
  ],
};

describe("createLocalMailSearch", () => {
  beforeEach(() => {
    store.clear();
  });

  function browserAnswering(result: unknown, accountId = ACCOUNT) {
    const parts: Array<{ type: string; data: { requestId: string } }> = [];
    const writer = {
      write: vi.fn((part: (typeof parts)[number]) => {
        parts.push(part);
        setTimeout(() => {
          saveLocalMailSearchResult({
            emailAccountId: accountId,
            requestId: part.data.requestId,
            result: result as never,
          });
        }, 5);
      }),
    } as unknown as UIMessageStreamWriter;
    return { writer, parts };
  }

  it("asks the browser through the reply stream and returns its answer", async () => {
    const search = createLocalMailSearch({
      emailAccountId: ACCOUNT,
      logger: createTestLogger(),
      pollIntervalMs: 5,
    });
    const { writer } = browserAnswering(answer);
    search.attach(writer);

    const result = await search.search({
      query: "from:jobs@acme.com",
      limit: 20,
    });

    expect(result).toEqual(answer);
    expect(writer.write).toHaveBeenCalledWith({
      type: "data-local-mail-search",
      data: {
        requestId: expect.any(String),
        query: "from:jobs@acme.com",
        limit: 20,
      },
      transient: true,
    });
  });

  it("hands back to the provider as soon as the browser says it can't answer", async () => {
    const search = createLocalMailSearch({
      emailAccountId: ACCOUNT,
      logger: createTestLogger(),
      pollIntervalMs: 5,
      waitMs: 5000,
    });
    search.attach(
      browserAnswering({ status: "unavailable", reason: "not_synced" }).writer,
    );
    const startedAt = Date.now();

    expect(await search.search({ query: "x", limit: 20 })).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("hands back to the provider when the browser doesn't answer in time", async () => {
    const search = createLocalMailSearch({
      emailAccountId: ACCOUNT,
      logger: createTestLogger(),
      pollIntervalMs: 5,
      waitMs: 50,
    });
    search.attach({ write: vi.fn() } as unknown as UIMessageStreamWriter);

    expect(await search.search({ query: "x", limit: 20 })).toBeNull();
  });

  it("ignores an answer saved for another account", async () => {
    const search = createLocalMailSearch({
      emailAccountId: ACCOUNT,
      logger: createTestLogger(),
      pollIntervalMs: 5,
      waitMs: 100,
    });
    search.attach(browserAnswering(answer, "someone-else").writer);

    expect(await search.search({ query: "x", limit: 20 })).toBeNull();
  });

  it("doesn't trust an answer that isn't a search result", async () => {
    const search = createLocalMailSearch({
      emailAccountId: ACCOUNT,
      logger: createTestLogger(),
      pollIntervalMs: 5,
    });
    search.attach(
      browserAnswering({ status: "ok", messages: [{ id: "m1" }] }).writer,
    );

    expect(await search.search({ query: "x", limit: 20 })).toBeNull();
  });

  it("asks nothing before the reply stream is attached", async () => {
    const search = createLocalMailSearch({
      emailAccountId: ACCOUNT,
      logger: createTestLogger(),
    });

    expect(await search.search({ query: "x", limit: 20 })).toBeNull();
  });
});
