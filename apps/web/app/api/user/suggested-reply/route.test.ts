import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  getCachedSuggestedReply: async () => null,
  suggestReply: mocks.suggestReply,
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailProviderTestMiddleware({}, { handleSafeErrors: true });
});

import { GET } from "./route";

describe("GET /api/user/suggested-reply", () => {
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

  it("does not count suggestions from mail and calendar alone", async () => {
    mocks.rateLimitCount.mockResolvedValue(1000);

    const response = await get("threadId=t1");

    expect(response.status).toBe(200);
    expect(mocks.rateLimitCount).not.toHaveBeenCalled();
  });
});

function get(query: string) {
  return GET(
    new NextRequest(`http://localhost:3000/api/user/suggested-reply?${query}`),
    { params: Promise.resolve({}) },
  );
}
