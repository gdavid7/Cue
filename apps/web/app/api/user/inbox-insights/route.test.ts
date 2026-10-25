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

  const { withEmailProvider } = createWithEmailProviderTestMiddleware(
    { getMessage: mocks.getMessage },
    { handleSafeErrors: true },
  );

  // The real middleware logs "Request completed" from the request's logger
  // once the handler returns, however it ended.
  return {
    withEmailProvider: (
      scope: string,
      handler: (request: any, ...context: any[]) => Promise<Response>,
    ) =>
      withEmailProvider(scope, async (request, ...context) => {
        try {
          return await handler(request, ...context);
        } finally {
          (request as any).logger.info("Request completed");
        }
      }),
  };
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
      // One per new email.
      ["300", "1"],
    );
    expect(mocks.getMessage).toHaveBeenCalledWith("m1");
  });

  it("stops building new insights for a user over the rate limit", async () => {
    mocks.rateLimitCount.mockResolvedValue(751);

    const response = await get();

    expect(response.status).toBe(429);
    expect(mocks.getMessage).not.toHaveBeenCalled();
  });

  // The rows go ten at a time (PF-9v), so the limit counts emails, not
  // requests: a long scroll's requests all answer, up to the same ceiling on
  // model calls as before.
  it("answers a long scroll's ten-row requests until the user's emails reach the limit", async () => {
    const counts = countingRateLimit();
    const statuses: number[] = [];
    for (let request = 0; request < 76; request++) {
      const items = Array.from(
        { length: 10 },
        (_, row) => `t${request}-${row}:m${request}-${row}`,
      ).join(",");
      statuses.push((await get("", items)).status);
    }

    expect(statuses.slice(0, 75).every((status) => status === 200)).toBe(true);
    expect(statuses[75]).toBe(429);
    expect(counts.get("rate-limit:inbox-insights:user-1")).toBe(760);
  });

  // D-086: the open conversation is what someone is waiting on, so the rows'
  // traffic can't spend its limit.
  it("answers the open conversation after the rows have spent their limit", async () => {
    const counts = countingRateLimit();
    counts.set("rate-limit:inbox-insights:user-1", 750);
    expect((await get()).status).toBe(429);

    const response = await get("&open=1");

    expect(response.status).toBe(200);
    expect(mocks.getMessage).toHaveBeenCalledWith("m1");
    expect(counts.get("rate-limit:inbox-insights-open:user-1")).toBe(1);
  });

  it("caps how often the open conversation asks for a new insight", async () => {
    const counts = countingRateLimit();
    counts.set("rate-limit:inbox-insights-open:user-1", 120);

    expect((await get("&open=1")).status).toBe(429);
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

  it("puts the chunk's size and lane on the request's completion line, with no mail data", async () => {
    mocks.rateLimitCount.mockResolvedValue(1);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await get("&known=m1", "t1:m1,t2:m2,t3:m3");

      const line = logSpy.mock.calls
        .map((args) => String(args[0]))
        .find((entry) => entry.includes("Request completed"));
      expect(line).toContain('"itemCount": 3');
      expect(line).toContain('"newCount": 2');
      expect(line).toContain('"priority": "background"');
      expect(line).not.toMatch(/alice|@example\.com/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("marks the open conversation's request interactive", async () => {
    mocks.rateLimitCount.mockResolvedValue(1);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await get("&open=1");

      const line = logSpy.mock.calls
        .map((args) => String(args[0]))
        .find((entry) => entry.includes("Request completed"));
      expect(line).toContain('"itemCount": 1');
      expect(line).toContain('"newCount": 1');
      expect(line).toContain('"priority": "interactive"');
    } finally {
      logSpy.mockRestore();
    }
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

// Redis's INCRBY on a counter per key, as the rate-limit script runs it.
function countingRateLimit() {
  const counts = new Map<string, number>();
  mocks.rateLimitCount.mockImplementation(
    async (_script: string, [key]: string[], [, cost = "1"]: string[]) => {
      const count = (counts.get(key) ?? 0) + Number(cost);
      counts.set(key, count);
      return count;
    },
  );
  return counts;
}

function get(query = "", items = "t1:m1") {
  return GET(
    new NextRequest(
      `http://localhost:3000/api/user/inbox-insights?items=${items}${query}`,
    ),
    { params: Promise.resolve({}) },
  );
}
