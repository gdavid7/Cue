import { NextRequest } from "next/server";
import { ZodError } from "zod";
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

import { POST } from "./route";

describe("POST /api/user/search-intent", () => {
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

  it("reads the search against the labels the browser sent", async () => {
    await get("receipts from Acme", ["Receipts", "Trips"]);

    expect(mocks.interpretSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        labelNames: ["Receipts", "Trips"],
      }),
    );
  });

  it("rejects an oversize labels array before any model call", async () => {
    await expect(
      get(
        "receipts from Acme",
        Array.from({ length: 301 }, (_, i) => `l${i}`),
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(mocks.interpretSearch).not.toHaveBeenCalled();
  });

  it("rejects a label name that is too long, and a malformed body", async () => {
    await expect(get("receipts", ["x".repeat(201)])).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(
      POST(
        new NextRequest("http://localhost:3000/api/user/search-intent", {
          method: "POST",
          body: JSON.stringify({ q: "receipts", labels: "Receipts" }),
        }),
        { params: Promise.resolve({}) },
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(mocks.interpretSearch).not.toHaveBeenCalled();
  });

  it("makes no model call for a user over the limit", async () => {
    mocks.rateLimitCount.mockResolvedValue(61);

    await expect(get("the lease Sarah sent")).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(mocks.interpretSearch).not.toHaveBeenCalled();
  });
});

async function get(q: string, labels: string[] = []) {
  const response = await POST(
    new NextRequest("http://localhost:3000/api/user/search-intent", {
      method: "POST",
      body: JSON.stringify({ q, labels }),
    }),
    { params: Promise.resolve({}) },
  );
  return response.json();
}
