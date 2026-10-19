import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimitCount: vi.fn(),
  getMessage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({
  redis: { eval: mocks.rateLimitCount },
}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: async () => ({ events: [] }),
}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAi: async () => null,
}));
vi.mock("@/utils/thread-context/suggest-reply", () => ({
  getSuggestedReplySettings: async () => ({
    draftReplies: "off" as const,
    webLookupEnabled: false,
  }),
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailProviderTestMiddleware(
    { getMessage: mocks.getMessage },
    { handleSafeErrors: true },
  );
});

import { GET } from "./route";

describe("GET /api/user/inbox-insights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMessage.mockResolvedValue({
      id: "m1",
      headers: { from: "alice@example.com" },
      labelIds: ["INBOX"],
    });
  });

  it("builds new insights for a user under the rate limit", async () => {
    mocks.rateLimitCount.mockResolvedValue(1);

    const response = await get();

    expect(response.status).toBe(200);
    expect(mocks.rateLimitCount).toHaveBeenCalledWith(
      expect.any(String),
      ["rate-limit:inbox-insights:user-1"],
      ["300"],
    );
    expect(mocks.getMessage).toHaveBeenCalledWith("m1");
  });

  it("stops building new insights for a user over the rate limit", async () => {
    mocks.rateLimitCount.mockResolvedValue(31);

    const response = await get();

    expect(response.status).toBe(429);
    expect(mocks.getMessage).not.toHaveBeenCalled();
  });

  // RD-3: the browser keeps what it was given and names those messages.
  it("answers a page the browser already holds without charging the rate limit", async () => {
    const response = await get("&known=m1");

    expect(response.status).toBe(200);
    expect((await response.json()).insights).toEqual({});
    expect(mocks.rateLimitCount).not.toHaveBeenCalled();
    expect(mocks.getMessage).not.toHaveBeenCalled();
  });
});

function get(query = "") {
  return GET(
    new NextRequest(
      `http://localhost:3000/api/user/inbox-insights?items=t1:m1${query}`,
    ),
    { params: Promise.resolve({}) },
  );
}
