import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  getGmailHistoryCatchUp,
  getGmailHistoryCatchUpTarget,
} from "@/utils/redis/gmail-history-catch-up";
import { processHistoryForUser } from "@/utils/webhook/google/process-history";
import { POST } from "./route";

vi.mock("@/utils/prisma");
vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithErrorTestMiddleware();
});
vi.mock("@/utils/qstash", () => ({
  withQstashOrInternal: (handler: unknown) => handler,
}));
vi.mock("@/utils/redis/gmail-history-catch-up", () => ({
  getGmailHistoryCatchUp: vi.fn(),
  getGmailHistoryCatchUpTarget: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/utils/webhook/google/process-history", () => ({
  processHistoryForUser: vi.fn(),
}));

describe("Gmail history catch-up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "user@example.com",
    } as never);
  });

  it("processes the account's history from where it stopped when a deferred range is still pending", async () => {
    vi.mocked(getGmailHistoryCatchUp).mockResolvedValue("token-1");

    const response = await POST(catchUp(), {} as never);

    expect(response.status).toBe(200);
    expect(processHistoryForUser).toHaveBeenCalledWith(
      { emailAddress: "user@example.com", historyId: "1200" },
      // Only this delivery may start a mailbox without a cursor from here.
      { fromCatchUp: true },
      expect.anything(),
    );
  });

  it("does nothing when a push already caught the account up", async () => {
    vi.mocked(getGmailHistoryCatchUp).mockResolvedValue(null);

    const response = await POST(catchUp(), {} as never);

    expect(response.status).toBe(200);
    expect(processHistoryForUser).not.toHaveBeenCalled();
  });

  it.each([
    "1200",
    "1300",
  ])("does nothing when the account's cursor (%s) already covers the history", async (lastSyncedHistoryId) => {
    vi.mocked(getGmailHistoryCatchUp).mockResolvedValue("token-1");
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "user@example.com",
      lastSyncedHistoryId,
    } as never);

    const response = await POST(catchUp(), {} as never);

    expect(response.status).toBe(200);
    expect(processHistoryForUser).not.toHaveBeenCalled();
  });

  it("keeps catching up while history past this delivery was asked for", async () => {
    // A lower delivery won the scheduling window over a higher request, or
    // the cursor passed the history this delivery names mid-backlog.
    vi.mocked(getGmailHistoryCatchUp).mockResolvedValue("token-1");
    vi.mocked(getGmailHistoryCatchUpTarget).mockResolvedValueOnce("1500");
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "user@example.com",
      lastSyncedHistoryId: "1300",
    } as never);

    await POST(catchUp(), {} as never);

    expect(processHistoryForUser).toHaveBeenCalledWith(
      { emailAddress: "user@example.com", historyId: "1500" },
      { fromCatchUp: true },
      expect.anything(),
    );
  });

  it("rejects a malformed delivery", async () => {
    const response = await POST(
      catchUp({ emailAccountId: "account-1", historyId: "abc" }),
      {} as never,
    );

    expect(response.status).toBe(400);
    expect(processHistoryForUser).not.toHaveBeenCalled();
  });
});

function catchUp(
  body: unknown = { emailAccountId: "account-1", historyId: "1200" },
) {
  return new Request("http://localhost/api/google/webhook/catch-up", {
    method: "POST",
    body: JSON.stringify(body),
  }) as never;
}
