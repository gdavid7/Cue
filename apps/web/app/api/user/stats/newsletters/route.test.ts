import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import prisma from "@/utils/__mocks__/prisma";

const { mockGetSenderEmailStats, mockEmailProvider } = vi.hoisted(() => ({
  mockGetSenderEmailStats: vi.fn(),
  mockEmailProvider: {
    name: "google",
    getFiltersList: vi.fn(),
  },
}));

vi.mock("@/utils/prisma");
vi.mock("@/utils/sender-stats", async () => {
  const actual = await vi.importActual<typeof import("@/utils/sender-stats")>(
    "@/utils/sender-stats",
  );
  return {
    ...actual,
    getSenderEmailStats: mockGetSenderEmailStats,
  };
});
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailProviderTestMiddleware(mockEmailProvider);
});

import { currentGmailQuotaContext } from "@/utils/gmail/quota";
import { GET } from "./route";

function sender(from: string) {
  return {
    from,
    fromName: "News",
    minFromName: "News",
    count: 4,
    inboxEmails: 3,
    readEmails: 1,
    unsubscribeLink: "https://example.com/unsub",
    lastEmailAt: 1_710_000_000_000,
  };
}

describe("GET /api/user/stats/newsletters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmailProvider.getFiltersList.mockResolvedValue([]);
    prisma.newsletter.findMany.mockResolvedValue([] as never);
    mockGetSenderEmailStats.mockResolvedValue({
      senders: [sender("news@example.com")],
      nextCursor: "cursor-2",
    });
  });

  it("returns lastEmailAt and nextCursor with the existing newsletter fields", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/user/stats/newsletters?limit=50&cursor=cursor-1&orderBy=newest",
      ),
      {} as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      newsletters: [
        expect.objectContaining({
          name: "news@example.com",
          value: 4,
          inboxEmails: 3,
          readEmails: 1,
          lastEmailAt: 1_710_000_000_000,
          unsubscribeLink: "https://example.com/unsub",
        }),
      ],
      nextCursor: "cursor-2",
      searchedSenderStatus: undefined,
      filtersAvailable: true,
    });
    expect(mockGetSenderEmailStats).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 50,
        cursor: "cursor-1",
        orderBy: "newest",
      }),
    );
  });

  it("reports filters as unavailable when the provider filters cannot be read", async () => {
    mockEmailProvider.getFiltersList.mockRejectedValue(
      new Error("Backend Error"),
    );
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const response = await GET(
      new NextRequest("http://localhost/api/user/stats/newsletters"),
      {} as never,
    );

    expect(consoleErrorSpy.mock.calls.flat().join(" ")).toContain(
      "Error getting email filters",
    );
    consoleErrorSpy.mockRestore();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.filtersAvailable).toBe(false);
    expect(body.newsletters[0].autoArchived).toBeUndefined();
  });

  it("gives the provider filters a short Gmail wait so a busy gate cannot hold the list", async () => {
    let waitBudget: number | undefined;
    mockEmailProvider.getFiltersList.mockImplementation(async () => {
      waitBudget = currentGmailQuotaContext().maxTotalWaitMs;
      return [];
    });

    const response = await GET(
      new NextRequest("http://localhost/api/user/stats/newsletters"),
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(waitBudget).toBeLessThanOrEqual(5000);
  });

  it("waits for the provider filters when one sender is looked up, so their auto-archive status is known", async () => {
    let waitBudget: number | undefined = 0;
    mockEmailProvider.getFiltersList.mockImplementation(async () => {
      waitBudget = currentGmailQuotaContext().maxTotalWaitMs;
      return [];
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/user/stats/newsletters?search=news%40example.com",
      ),
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(waitBudget).toBeUndefined();
  });

  it("rejects a limit below 1", async () => {
    await expect(
      GET(
        new NextRequest("http://localhost/api/user/stats/newsletters?limit=-1"),
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(mockGetSenderEmailStats).not.toHaveBeenCalled();
  });

  it("lets a stats failure reject instead of looking like an empty list", async () => {
    mockGetSenderEmailStats.mockRejectedValue(new Error("stats failed"));

    await expect(
      GET(
        new NextRequest("http://localhost/api/user/stats/newsletters"),
        {} as never,
      ),
    ).rejects.toThrow("stats failed");
  });
});
