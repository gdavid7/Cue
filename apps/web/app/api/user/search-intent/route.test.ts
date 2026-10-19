import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";

const mocks = vi.hoisted(() => ({
  interpretSearch: vi.fn(),
  rateLimitCount: vi.fn(),
}));

vi.mock("@/utils/redis", () => ({
  redis: { eval: mocks.rateLimitCount },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/utils/middleware", () => ({
  withEmailProvider:
    (_scope: string, handler: (request: NextRequest) => unknown) =>
    (request: NextRequest) =>
      handler(
        Object.assign(request, {
          auth: { userId: "user-1", emailAccountId: "account-1" },
          emailProvider: { name: "google" },
          logger: createScopedLogger("search-intent-test"),
        }),
      ),
}));
vi.mock("@/utils/ai/mail-search/interpret-search", () => ({
  interpretSearch: mocks.interpretSearch,
}));

import { GET } from "./route";

describe("GET /api/user/search-intent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimitCount.mockResolvedValue(1);
    mocks.interpretSearch.mockResolvedValue(null);
  });

  it("reads the search under its own rate limit", async () => {
    await get("the lease Sarah sent last month");

    expect(mocks.rateLimitCount).toHaveBeenCalledWith(
      expect.any(String),
      ["rate-limit:search-intent:user-1"],
      ["300"],
    );
    expect(mocks.interpretSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "account-1",
        query: "the lease Sarah sent last month",
      }),
    );
  });

  it("makes no model call for a user over the limit", async () => {
    mocks.rateLimitCount.mockResolvedValue(61);

    await expect(get("the lease Sarah sent")).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(mocks.interpretSearch).not.toHaveBeenCalled();
  });
});

async function get(q: string) {
  const response = await GET(
    new NextRequest(
      `http://localhost:3000/api/user/search-intent?q=${encodeURIComponent(q)}`,
    ),
    { params: Promise.resolve({}) },
  );
  return response.json();
}
