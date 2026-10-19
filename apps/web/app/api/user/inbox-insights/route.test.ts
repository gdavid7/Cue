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
    draftRepliesEnabled: false,
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

import { runWithAuditContext } from "@/utils/audit/context";
import { currentGmailQuotaContext } from "@/utils/gmail/quota";
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

  // D-086: the conversation on screen is what someone is looking at; the
  // rows' insights are work nobody asked for yet.
  it("reads the open conversation at interactive priority and the rows at background", async () => {
    mocks.rateLimitCount.mockResolvedValue(1);
    const priorities: string[] = [];
    mocks.getMessage.mockImplementation(async () => {
      priorities.push(currentGmailQuotaContext().priority);
      return {
        id: "m1",
        headers: { from: "alice@example.com" },
        labelIds: ["INBOX"],
      };
    });

    await runWithAuditContext({ source: "user/inbox-insights" }, () =>
      get("&open=1"),
    );
    await runWithAuditContext({ source: "user/inbox-insights" }, () => get());
    // Open only means one conversation; a page of rows can't claim it.
    await runWithAuditContext({ source: "user/inbox-insights" }, () =>
      get(",t2:m2&open=1"),
    );

    expect(priorities).toEqual([
      "interactive",
      "background",
      "background",
      "background",
    ]);
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
