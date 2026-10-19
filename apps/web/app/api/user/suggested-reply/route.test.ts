import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const mocks = vi.hoisted(() => ({
  rateLimitCount: vi.fn(),
  suggestReply: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/redis", () => ({
  redis: { eval: mocks.rateLimitCount },
}));
vi.mock("@/utils/exa/search", () => ({ isExaSearchEnabled: () => true }));
vi.mock("@/utils/thread-context/suggest-reply", () => ({
  getSuggestedReplySettings: async () => ({ webLookupEnabled: true }),
  suggestReply: mocks.suggestReply,
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailProviderTestMiddleware({}, { handleSafeErrors: true });
});

import { POST } from "./route";

describe("POST /api/user/suggested-reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.suggestReply.mockResolvedValue({ status: "insufficient" });
  });

  it("stops web lookups for a user over the rate limit", async () => {
    mocks.rateLimitCount.mockResolvedValue(41);

    const response = await get("threadId=t1&web=1");

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ isKnownError: true });
    expect(mocks.suggestReply).not.toHaveBeenCalled();
    expect(mocks.rateLimitCount).toHaveBeenCalledWith(
      expect.any(String),
      ["rate-limit:suggested-reply-web:user-1"],
      ["300"],
    );
  });

  // RD-3: the browser kept the abstention, so the web pass gets its query.
  it("hands the web pass the query the browser kept", async () => {
    mocks.rateLimitCount.mockResolvedValue(1);

    await get("threadId=t1&web=1&webQuery=venue%20opening%20hours");

    expect(mocks.suggestReply).toHaveBeenCalledWith(
      expect.objectContaining({
        searchWeb: true,
        webQuery: "venue opening hours",
      }),
    );
  });

  // RD-3g: the reader's context is reused, not gathered again.
  it("hands the suggestion the context the reader already has", async () => {
    const item = {
      id: "page-1",
      kind: "web",
      title: "Opening hours",
      snippet: "",
      at: "2026-10-01T00:00:00.000Z",
      reasons: [{ type: "linked" }],
      text: "Open 9 to 5.",
    };

    await get("threadId=t1", { context: [item] });

    expect(mocks.suggestReply).toHaveBeenCalledWith(
      expect.objectContaining({ context: [item] }),
    );
  });

  it("refuses context longer than the reader is ever given", async () => {
    const item = {
      id: "page-1",
      kind: "web",
      title: "Opening hours",
      snippet: "",
      at: "2026-10-01T00:00:00.000Z",
      reasons: [],
      text: "x".repeat(5000),
    };

    // withEmailProvider answers a ZodError with a 400.
    await expect(get("threadId=t1", { context: [item] })).rejects.toThrow(
      ZodError,
    );
    expect(mocks.suggestReply).not.toHaveBeenCalled();
  });

  it("limits suggestions from mail and calendar alone loosely, on their own count", async () => {
    mocks.rateLimitCount.mockResolvedValueOnce(60);
    expect((await get("threadId=t1")).status).toBe(200);
    expect(mocks.rateLimitCount).toHaveBeenCalledWith(
      expect.any(String),
      ["rate-limit:suggested-reply:user-1"],
      ["300"],
    );

    mocks.rateLimitCount.mockResolvedValueOnce(61);
    expect((await get("threadId=t1")).status).toBe(429);
  });

  it("drops a context link that isn't a web page", async () => {
    const item = {
      id: "page-1",
      kind: "web",
      title: "Opening hours",
      snippet: "",
      at: "2026-10-01T00:00:00.000Z",
      url: "javascript:alert(1)",
      reasons: [],
      text: "Open 9 to 5.",
    };
    mocks.rateLimitCount.mockResolvedValue(1);

    await get("threadId=t1", { context: [item] });

    const [{ context }] = mocks.suggestReply.mock.calls[0];
    expect(context[0].url).toBeUndefined();
    expect(context[0].title).toBe("Opening hours");
  });
});

function get(query: string, body: unknown = {}) {
  return POST(
    new NextRequest(`http://localhost:3000/api/user/suggested-reply?${query}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}
