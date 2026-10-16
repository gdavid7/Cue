import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimitCount: vi.fn(),
  getThreadBrief: vi.fn(),
  getCachedThreadBrief: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/redis", () => ({
  redis: { eval: mocks.rateLimitCount },
}));
vi.mock("@/utils/home/get-thread-brief", () => ({
  getThreadBrief: mocks.getThreadBrief,
  getCachedThreadBrief: mocks.getCachedThreadBrief,
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailProviderTestMiddleware({}, { handleSafeErrors: true });
});

import { GET } from "./route";

const BRIEF = {
  summary: "Alice asks whether Friday still works.",
  keyPoints: [],
  source: "ai",
};

describe("GET /api/user/thread-brief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getThreadBrief.mockResolvedValue(null);
    mocks.getCachedThreadBrief.mockResolvedValue(null);
  });

  it("briefs threads for a user under the rate limit", async () => {
    mocks.rateLimitCount.mockResolvedValue(1);

    const response = await get();

    expect(response.status).toBe(200);
    expect(mocks.rateLimitCount).toHaveBeenCalledWith(
      expect.any(String),
      ["rate-limit:thread-brief:user-1"],
      ["300"],
    );
  });

  it("stops briefing threads for a user over the rate limit", async () => {
    mocks.rateLimitCount.mockResolvedValue(121);

    const response = await get();

    expect(response.status).toBe(429);
    expect(mocks.getThreadBrief).not.toHaveBeenCalled();
  });

  it("answers a reopened conversation from the cache alone", async () => {
    mocks.getCachedThreadBrief.mockResolvedValue(BRIEF);

    const response = await get("&messageId=m2");

    expect(await response.json()).toEqual({ brief: BRIEF });
    // Looked up under the signed-in account, never one the caller names.
    expect(mocks.getCachedThreadBrief).toHaveBeenCalledWith({
      emailAccountId: "email-account-1",
      threadId: "t1",
      messageId: "m2",
    });
    expect(mocks.getThreadBrief).not.toHaveBeenCalled();
    expect(mocks.rateLimitCount).not.toHaveBeenCalled();
  });

  it("writes a brief when the newest message has none yet", async () => {
    mocks.rateLimitCount.mockResolvedValue(1);
    mocks.getThreadBrief.mockResolvedValue(BRIEF);

    const response = await get("&messageId=m3");

    expect(await response.json()).toEqual({ brief: BRIEF });
    expect(mocks.getThreadBrief).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "email-account-1",
        threadId: "t1",
      }),
    );
  });
});

function get(query = "") {
  return GET(
    new NextRequest(
      `http://localhost:3000/api/user/thread-brief?threadId=t1${query}`,
    ),
    { params: Promise.resolve({}) },
  );
}
