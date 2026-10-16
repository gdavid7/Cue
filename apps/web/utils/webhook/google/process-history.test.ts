import { describe, it, expect, vi, beforeEach } from "vitest";
import { processHistoryForUser } from "./process-history";
import { cleanupInvalidTokens } from "@/utils/auth/cleanup-invalid-tokens";
import { getHistory } from "@/utils/gmail/history";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";
import prisma from "@/utils/prisma";
import { getEmailProviderRateLimitState } from "@/utils/email/rate-limit";
import { createTestLogger } from "@/__tests__/helpers";
import { captureException } from "@/utils/error";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import { processHistoryItem } from "@/utils/webhook/google/process-history-item";
import { publishToQstashAt } from "@/utils/upstash";
import {
  clearGmailHistoryCatchUp,
  getGmailHistoryCatchUp,
  markGmailHistoryCatchUp,
} from "@/utils/redis/gmail-history-catch-up";
import {
  acquireGmailHistoryLease,
  releaseGmailHistoryLease,
} from "@/utils/redis/gmail-history-lease";

const logger = createTestLogger();

beforeEach(() => {
  vi.mocked(acquireGmailHistoryLease).mockResolvedValue({
    acquired: true,
    token: "lease-token",
  });
});

vi.mock("@/utils/gmail/client", () => ({
  getGmailClientWithRefresh: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/utils/gmail/history", () => ({
  getHistory: vi.fn(),
}));

vi.mock("@/utils/webhook/validate-webhook-account", () => ({
  getWebhookEmailAccount: vi.fn(),
  validateWebhookAccount: vi.fn(),
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    emailAccount: {
      update: vi.fn().mockResolvedValue({}),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock("@/utils/error", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/error")>()),
  captureException: vi.fn(),
}));

vi.mock("@/utils/auth/cleanup-invalid-tokens", () => ({
  cleanupInvalidTokens: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/email/rate-limit", () => ({
  getEmailProviderRateLimitState: vi.fn().mockResolvedValue(null),
  withRateLimitRecording: vi.fn(async (context, operation) => {
    try {
      return await operation();
    } catch (error) {
      await context.onRateLimitRecorded?.(null, error);
      throw error;
    }
  }),
}));

vi.mock("@/utils/redis/gmail-history-catch-up", () => ({
  markGmailHistoryCatchUp: vi.fn().mockResolvedValue(undefined),
  getGmailHistoryCatchUp: vi.fn().mockResolvedValue(null),
  clearGmailHistoryCatchUp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/redis/gmail-history-lease", () => ({
  acquireGmailHistoryLease: vi.fn(),
  releaseGmailHistoryLease: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/webhook/google/process-history-item", () => ({
  MESSAGE_HELD_ELSEWHERE: "held-elsewhere",
  processHistoryItem: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/upstash", () => ({
  publishToQstashAt: vi.fn().mockResolvedValue(true),
}));

describe("processHistoryForUser - 404 Handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(processHistoryItem).mockReset().mockResolvedValue(undefined);
    vi.mocked(getEmailProviderRateLimitState).mockResolvedValue(null);
  });

  it("should reset lastSyncedHistoryId when Gmail returns 404 (expired historyId)", async () => {
    const email = "user@test.com";
    const historyId = 2000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);

    // Simulate Gmail 404 error
    const error404 = new Error("Requested entity was not found");
    (error404 as any).status = 404;
    vi.mocked(getHistory).mockRejectedValue(error404);

    const result = await processHistoryForUser(
      { emailAddress: email, historyId },
      {},
      logger,
    );

    const jsonResponse = await (result as any).json();
    expect(jsonResponse).toEqual({ ok: true });

    // Verify lastSyncedHistoryId was updated to the current historyId via conditional update
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it("processes Gmail history", async () => {
    const email = "user@test.com";
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };
    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);
    vi.mocked(getHistory).mockResolvedValue({
      history: [
        {
          id: "1500",
          messagesAdded: [
            {
              message: { id: "m1", threadId: "t1", labelIds: ["INBOX"] },
            },
          ],
        },
      ],
    } as any);

    const result = await processHistoryForUser(
      { emailAddress: email, historyId: 1500 },
      {},
      logger,
    );

    expect(await (result as any).json()).toEqual({ ok: true });
  });

  it("should skip webhook history calls while account is in rate-limit mode", async () => {
    const email = "user@test.com";
    const historyId = 2000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);
    const retryAt = new Date(Date.now() + 5 * 60_000);
    vi.mocked(getEmailProviderRateLimitState).mockResolvedValue({
      provider: "google",
      retryAt,
      source: "test",
    });

    const result = await processHistoryForUser(
      { emailAddress: email, historyId },
      {},
      logger,
    );

    const jsonResponse = await (result as any).json();
    expect(jsonResponse).toEqual({ ok: true });
    expect(getHistory).not.toHaveBeenCalled();
    expect(markGmailHistoryCatchUp).toHaveBeenCalledWith(
      "account-123",
      expect.anything(),
    );
    // A quiet mailbox may get no further push, so the skipped history needs
    // its own delivery once the limit lifts.
    expect(publishToQstashAt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/google/webhook/catch-up",
        body: { emailAccountId: "account-123", historyId: "2000" },
      }),
    );
    const { notBefore } = vi.mocked(publishToQstashAt).mock.calls[0][0];
    expect(notBefore.getTime()).toBeGreaterThanOrEqual(retryAt.getTime());
  });

  it("should continue processing when rate-limit state lookup fails", async () => {
    const email = "user@test.com";
    const historyId = 2000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);
    vi.mocked(getEmailProviderRateLimitState).mockRejectedValueOnce(
      new Error("redis unavailable"),
    );
    vi.mocked(getHistory).mockResolvedValue({ history: [] });

    const result = await processHistoryForUser(
      { emailAddress: email, historyId },
      {},
      logger,
    );

    const jsonResponse = await (result as any).json();
    expect(jsonResponse).toEqual({ ok: true });
    expect(getHistory).toHaveBeenCalled();
  });

  it("does not truncate moderate history ID gaps", async () => {
    const email = "user@test.com";
    const historyId = 1819;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);

    vi.mocked(getHistory).mockResolvedValue({ history: [] });

    await processHistoryForUser({ emailAddress: email, historyId }, {}, logger);

    expect(getHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ startHistoryId: "1000" }),
      expect.any(Object),
    );
  });

  it("reads a large gap from the cursor and advances to the push when it is empty", async () => {
    const email = "user@test.com";
    const historyId = 5000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);

    vi.mocked(getHistory).mockResolvedValue({ history: [] });

    await processHistoryForUser({ emailAddress: email, historyId }, {}, logger);

    expect(getHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ startHistoryId: "1000" }),
      expect.any(Object),
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.$executeRaw).mock.calls[0]).toContain("5000");
  });

  it("catches up on history skipped during a Gmail rate limit", async () => {
    const email = "user@test.com";
    const historyId = 5000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);
    vi.mocked(getGmailHistoryCatchUp).mockResolvedValueOnce("catch-up-token");
    vi.mocked(getHistory).mockResolvedValue({
      history: [{ id: "4900", messagesAdded: [] }],
    });

    await processHistoryForUser({ emailAddress: email, historyId }, {}, logger);

    expect(getHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ startHistoryId: "1000" }),
      expect.any(Object),
    );
    expect(clearGmailHistoryCatchUp).toHaveBeenCalledWith({
      emailAccountId: "account-123",
      token: "catch-up-token",
      logger: expect.anything(),
    });
  });

  it("keeps the cursor before history that Gmail rate limited", async () => {
    const email = "user@test.com";
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);
    vi.mocked(getGmailHistoryCatchUp).mockResolvedValueOnce("catch-up-token");
    vi.mocked(getHistory).mockResolvedValue({
      history: [
        {
          id: "1100",
          messagesAdded: [
            { message: { id: "m1", threadId: "t1", labelIds: ["INBOX"] } },
          ],
        },
        {
          id: "1200",
          messagesAdded: [
            { message: { id: "m2", threadId: "t2", labelIds: ["INBOX"] } },
          ],
        },
      ],
    } as any);
    vi.mocked(processHistoryItem).mockImplementation(async (event) => {
      if (event.item.message?.id === "m2")
        throw new Error(
          "User-rate limit exceeded.  Retry after 2026-01-01T00:00:00Z",
        );
    });

    await processHistoryForUser(
      { emailAddress: email, historyId: 1200 },
      {},
      logger,
    );

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.$executeRaw).mock.calls[0]).toContain("1100");
    expect(clearGmailHistoryCatchUp).not.toHaveBeenCalled();
    expect(markGmailHistoryCatchUp).toHaveBeenCalledWith(
      "account-123",
      expect.anything(),
    );
    expect(publishToQstashAt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/google/webhook/catch-up",
        body: { emailAccountId: "account-123", historyId: "1200" },
      }),
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  it("keeps the cursor before history the Gmail quota gate deferred and catches up later", async () => {
    const email = "user@test.com";
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: true,
        hasAiAccess: true,
      },
    } as any);
    vi.mocked(getHistory).mockResolvedValue({
      history: [
        {
          id: "1100",
          messagesAdded: [
            { message: { id: "m1", threadId: "t1", labelIds: ["INBOX"] } },
          ],
        },
        {
          id: "1200",
          messagesAdded: [
            { message: { id: "m2", threadId: "t2", labelIds: ["INBOX"] } },
          ],
        },
      ],
    } as any);
    vi.mocked(processHistoryItem).mockImplementation(async (event) => {
      if (event.item.message?.id === "m2")
        // Gaxios wraps errors thrown below it, as the gate's deferral is.
        throw Object.assign(new Error("request failed"), {
          cause: new GmailCallDeferredError(15_000, "sync"),
        });
    });

    await processHistoryForUser(
      { emailAddress: email, historyId: 1200 },
      {},
      logger,
    );

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.$executeRaw).mock.calls[0]).toContain("1100");
    expect(markGmailHistoryCatchUp).toHaveBeenCalledWith(
      "account-123",
      expect.anything(),
    );
    expect(publishToQstashAt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/google/webhook/catch-up",
        body: { emailAccountId: "account-123", historyId: "1200" },
      }),
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  it("schedules one catch-up a minute or two out for pushes the gate defers together", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T12:00:10Z"));
    const email = "user@test.com";
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };
    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: true,
        hasAiAccess: true,
      },
    } as any);
    vi.mocked(getHistory).mockRejectedValue(
      Object.assign(new Error("request failed"), {
        cause: new GmailCallDeferredError(15_000, "sync"),
      }),
    );

    try {
      await processHistoryForUser(
        { emailAddress: email, historyId: 1200 },
        {},
        logger,
      );
      vi.setSystemTime(new Date("2026-10-14T12:00:40Z"));
      await processHistoryForUser(
        { emailAddress: email, historyId: 1300 },
        {},
        logger,
      );
    } finally {
      vi.useRealTimers();
    }

    const scheduled = vi
      .mocked(publishToQstashAt)
      .mock.calls.map(([input]) => input);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0]?.notBefore).toEqual(new Date("2026-10-14T12:01:40Z"));
    expect(scheduled[1]?.deduplicationId).toBe(scheduled[0]?.deduplicationId);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("uses BigInt math for large Gmail history IDs", async () => {
    const email = "user@test.com";
    const historyId = "90071992547409934000";
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "90071992547409930000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);

    vi.mocked(getHistory).mockResolvedValue({ history: [] });

    await processHistoryForUser({ emailAddress: email, historyId }, {}, logger);

    expect(getHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ startHistoryId: "90071992547409930000" }),
      expect.any(Object),
    );
  });

  it("fetches all Gmail history pages before processing catch-up", async () => {
    const email = "user@test.com";
    const historyId = 2000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);

    vi.mocked(getHistory)
      .mockResolvedValueOnce({
        history: [{ id: "1100", messagesAdded: [] }],
        nextPageToken: "page-2",
      })
      .mockResolvedValueOnce({
        history: [{ id: "1200", messagesAdded: [] }],
      });

    await processHistoryForUser({ emailAddress: email, historyId }, {}, logger);

    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(getHistory).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        startHistoryId: "1000",
        maxResults: 500,
        pageToken: undefined,
      }),
      expect.any(Object),
    );
    expect(getHistory).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        startHistoryId: "1000",
        maxResults: 500,
        pageToken: "page-2",
      }),
      expect.any(Object),
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe("processHistoryForUser - authentication failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEmailProviderRateLimitState).mockResolvedValue(null);
    vi.mocked(cleanupInvalidTokens).mockResolvedValue(undefined);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          id: "account-123",
          email: "user@example.com",
          userId: "user-123",
          lastSyncedHistoryId: "1000",
          account: {
            access_token: "original-access-token",
            refresh_token: "failed-refresh-token",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);
  });

  it.each([
    "invalid_grant",
    "Token refresh failed: invalid_grant",
  ])("cleans up the failed grant before acknowledging %s from a Gmail API call", async (message) => {
    vi.mocked(getHistory).mockRejectedValueOnce(new Error(message));

    const response = await processHistoryForUser(
      { emailAddress: "user@example.com", historyId: 2000 },
      {},
      logger,
    );

    expect(cleanupInvalidTokens).toHaveBeenCalledExactlyOnceWith({
      emailAccountId: "account-123",
      reason: "invalid_grant",
      // Access tokens can rotate during client creation without changing the grant.
      failedRefreshToken: "failed-refresh-token",
      logger: expect.any(Object),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("acknowledges invalid grants even if cleanup fails", async () => {
    vi.mocked(getHistory).mockRejectedValueOnce(new Error("invalid_grant"));
    vi.mocked(cleanupInvalidTokens).mockRejectedValueOnce(
      new Error("Database unavailable"),
    );

    const response = await processHistoryForUser(
      { emailAddress: "user@example.com", historyId: 2000 },
      {},
      logger,
    );

    expect(cleanupInvalidTokens).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ ok: true });
  });

  it("does not disconnect accounts for transient Gmail API failures", async () => {
    vi.mocked(getHistory).mockRejectedValueOnce(
      new Error("Service unavailable"),
    );

    await processHistoryForUser(
      { emailAddress: "user@example.com", historyId: 2000 },
      {},
      logger,
    );

    expect(cleanupInvalidTokens).not.toHaveBeenCalled();
  });
});

describe("processHistoryForUser - backlogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEmailProviderRateLimitState).mockResolvedValue(null);
    vi.mocked(processHistoryItem).mockReset().mockResolvedValue(undefined);
    vi.mocked(getWebhookEmailAccount).mockResolvedValue(backlogAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...backlogAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: true,
        hasAiAccess: true,
      },
    } as any);
  });

  it("reads every history record after a silent period instead of skipping the oldest", async () => {
    vi.mocked(getHistory).mockResolvedValue({
      history: inboxHistory(["1100", "m1"], ["4900", "m2"]),
    } as any);

    await processHistoryForUser(
      { emailAddress: backlogAccount.email, historyId: 5000 },
      {},
      logger,
    );

    expect(getHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ startHistoryId: "1000" }),
      expect.any(Object),
    );
    expect(processedMessageIds()).toEqual(expect.arrayContaining(["m1", "m2"]));
    expect(lastCursorUpdate()).toBe("4900");
    expect(publishToQstashAt).not.toHaveBeenCalled();
  });

  it("leaves the history to a catch-up while another run holds the account", async () => {
    vi.mocked(acquireGmailHistoryLease).mockResolvedValue({ acquired: false });

    await processHistoryForUser(
      { emailAddress: backlogAccount.email, historyId: 1300 },
      {},
      logger,
    );

    expect(getHistory).not.toHaveBeenCalled();
    expect(processHistoryItem).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(markGmailHistoryCatchUp).toHaveBeenCalledWith(
      "account-123",
      expect.anything(),
    );
    expect(publishToQstashAt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/google/webhook/catch-up",
        body: { emailAccountId: "account-123", historyId: "1300" },
      }),
    );
  });

  it("releases the account's history lease when the run ends", async () => {
    vi.mocked(getHistory).mockResolvedValue({
      history: inboxHistory(["1100", "m1"]),
    } as any);

    await processHistoryForUser(
      { emailAddress: backlogAccount.email, historyId: 1100 },
      {},
      logger,
    );

    expect(releaseGmailHistoryLease).toHaveBeenCalledWith(
      "account-123",
      { acquired: true, token: "lease-token" },
      expect.anything(),
    );
  });

  it("never moves the cursor past a message someone else is still processing", async () => {
    vi.mocked(getHistory).mockResolvedValue({
      history: inboxHistory(["1100", "m1"], ["1200", "m2"], ["1300", "m3"]),
    } as any);
    vi.mocked(processHistoryItem).mockImplementation(async (event) =>
      event.item.message?.id === "m2" ? ("held-elsewhere" as never) : undefined,
    );

    await processHistoryForUser(
      { emailAddress: backlogAccount.email, historyId: 1300 },
      {},
      logger,
    );

    expect(cursorUpdates()).toEqual(["1100"]);
    expect(publishToQstashAt).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/google/webhook/catch-up" }),
    );
  });

  it("saves its progress as it goes, so a run cut short isn't repeated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.mocked(getHistory).mockResolvedValue({
      history: [
        historyMessage("1100", "a", "shared", ["INBOX"]),
        historyMessage("1200", "b", "shared", ["INBOX"]),
        historyMessage("1300", "c", "shared", ["INBOX"]),
      ],
    } as any);
    vi.mocked(processHistoryItem).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 15_000);
    });

    try {
      await processHistoryForUser(
        { emailAddress: backlogAccount.email, historyId: 1300 },
        {},
        logger,
      );
    } finally {
      vi.useRealTimers();
    }

    expect(cursorUpdates()).toEqual(["1100", "1200", "1300"]);
  });

  it("keeps a thread's messages in order, so a newer inbound reply isn't resolved by an older sent one", async () => {
    // A (inbound), R (the user's reply), B (their answer) in one thread, plus
    // newer mail in another thread. Run out of order, R's outbound handling
    // would resolve B's Needs reply.
    vi.mocked(getHistory).mockResolvedValue({
      history: [
        historyMessage("1100", "a", "shared", ["INBOX"]),
        historyMessage("1200", "r", "shared", ["SENT"]),
        historyMessage("1300", "b", "shared", ["INBOX"]),
        historyMessage("1400", "other", "other-thread", ["INBOX"]),
      ],
    } as any);
    const timeline: string[] = [];
    vi.mocked(processHistoryItem).mockImplementation(async (event) => {
      const id = event.item.message?.id;
      timeline.push(`start ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      timeline.push(`end ${id}`);
    });

    await processHistoryForUser(
      { emailAddress: backlogAccount.email, historyId: 1400 },
      {},
      logger,
    );

    const thread = timeline.filter((step) => !step.endsWith("other"));
    expect(thread).toEqual([
      "start a",
      "end a",
      "start r",
      "end r",
      "start b",
      "end b",
    ]);
    // The thread with the newest mail starts first.
    expect(timeline[0]).toBe("start other");
    expect(lastCursorUpdate()).toBe("1400");
  });

  it("handles a reply sent from another client in order with the thread's inbound mail", async () => {
    // Gmail can report the user's reply as SENT being added to it rather
    // than as a new message; it still runs the outbound handling.
    vi.mocked(getHistory).mockResolvedValue({
      history: [
        historyMessage("1100", "a", "shared", ["INBOX"]),
        {
          id: "1200",
          labelsAdded: [
            {
              message: { id: "r", threadId: "shared", labelIds: ["SENT"] },
              labelIds: ["SENT"],
            },
          ],
        },
        historyMessage("1300", "b", "shared", ["INBOX"]),
      ],
    } as any);
    const timeline: string[] = [];
    vi.mocked(processHistoryItem).mockImplementation(async (event) => {
      const id = event.item.message?.id;
      timeline.push(`start ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      timeline.push(`end ${id}`);
    });

    await processHistoryForUser(
      { emailAddress: backlogAccount.email, historyId: 1300 },
      {},
      logger,
    );

    expect(timeline).toEqual([
      "start a",
      "end a",
      "start r",
      "end r",
      "start b",
      "end b",
    ]);
    expect(lastCursorUpdate()).toBe("1300");
  });

  it("processes new inbox mail newest first, a few messages at a time", async () => {
    vi.mocked(getHistory).mockResolvedValue({
      history: inboxHistory(
        ["1100", "m1"],
        ["1200", "m2"],
        ["1300", "m3"],
        ["1400", "m4"],
        ["1500", "m5"],
      ),
    } as any);
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(processHistoryItem).mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });

    await processHistoryForUser(
      { emailAddress: backlogAccount.email, historyId: 1500 },
      {},
      logger,
    );

    expect(processedMessageIds()).toEqual(["m5", "m4", "m3", "m2", "m1"]);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(lastCursorUpdate()).toBe("1500");
  });

  it("never moves the cursor past an older message that is still unprocessed", async () => {
    vi.mocked(getHistory).mockResolvedValue({
      history: inboxHistory(["1100", "m1"], ["1200", "m2"], ["1300", "m3"]),
    } as any);
    vi.mocked(processHistoryItem).mockImplementation(async (event) => {
      if (event.item.message?.id === "m2")
        throw new Error(
          "User-rate limit exceeded.  Retry after 2026-01-01T00:00:00Z",
        );
    });

    await processHistoryForUser(
      { emailAddress: backlogAccount.email, historyId: 1300 },
      {},
      logger,
    );

    expect(cursorUpdates()).toEqual(["1100"]);
    expect(publishToQstashAt).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/google/webhook/catch-up" }),
    );
  });

  it("continues a backlog in a scheduled catch-up once the run's time budget is spent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.mocked(getHistory).mockResolvedValue({
      history: inboxHistory(["1100", "m1"], ["1200", "m2"], ["1300", "m3"]),
    } as any);
    vi.mocked(processHistoryItem).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 10 * 60_000);
    });

    try {
      await processHistoryForUser(
        { emailAddress: backlogAccount.email, historyId: 1300 },
        {},
        logger,
      );
    } finally {
      vi.useRealTimers();
    }

    // Only the newest message fit; the older ones wait for the catch-up.
    expect(processedMessageIds()).toEqual(["m3"]);
    expect(cursorUpdates()).toEqual([]);
    expect(markGmailHistoryCatchUp).toHaveBeenCalledWith(
      "account-123",
      expect.anything(),
    );
    expect(publishToQstashAt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/google/webhook/catch-up",
        body: { emailAccountId: "account-123", historyId: "1300" },
      }),
    );
    expect(clearGmailHistoryCatchUp).not.toHaveBeenCalled();
  });

  it("continues in a scheduled catch-up when the history is longer than one run reads", async () => {
    let page = 0;
    vi.mocked(getHistory).mockImplementation(async () => {
      page += 1;
      return {
        history: inboxHistory([String(1000 + page), `m${page}`]),
        nextPageToken: `page-${page + 1}`,
      } as any;
    });

    await processHistoryForUser(
      { emailAddress: backlogAccount.email, historyId: 900_000 },
      {},
      logger,
    );

    expect(page).toBeGreaterThan(1);
    expect(page).toBeLessThan(100);
    expect(lastCursorUpdate()).toBe(String(1000 + page));
    expect(publishToQstashAt).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/google/webhook/catch-up" }),
    );
  });

  it("moves past pages with no history records instead of catching up on them forever", async () => {
    vi.mocked(getHistory).mockImplementation(
      async () =>
        ({
          history: [],
          nextPageToken: "more",
          historyId: "9000",
        }) as any,
    );

    await processHistoryForUser(
      { emailAddress: backlogAccount.email, historyId: 1500 },
      {},
      logger,
    );

    expect(cursorUpdates()).toEqual(["9000"]);
    expect(publishToQstashAt).not.toHaveBeenCalled();
  });

  it("asks the catch-up for history past what it read, so it doesn't look caught up", async () => {
    // The push is older than the history read since; the cursor passes it.
    let page = 0;
    vi.mocked(getHistory).mockImplementation(async () => {
      page += 1;
      return {
        history: inboxHistory([String(2000 + page), `m${page}`]),
        nextPageToken: `page-${page + 1}`,
      } as any;
    });

    await processHistoryForUser(
      { emailAddress: backlogAccount.email, historyId: 1500 },
      {},
      logger,
    );

    expect(lastCursorUpdate()).toBe(String(2000 + page));
    expect(publishToQstashAt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          emailAccountId: "account-123",
          historyId: String(2000 + page + 1),
        },
      }),
    );
  });
});

const backlogAccount = {
  id: "account-123",
  email: "user@test.com",
  lastSyncedHistoryId: "1000",
};

function inboxHistory(...entries: [historyId: string, messageId: string][]) {
  return entries.map(([id, messageId]) => ({
    id,
    messagesAdded: [
      {
        message: {
          id: messageId,
          threadId: `t-${messageId}`,
          labelIds: ["INBOX"],
        },
      },
    ],
  }));
}

function historyMessage(
  id: string,
  messageId: string,
  threadId: string,
  labelIds: string[],
) {
  return {
    id,
    messagesAdded: [{ message: { id: messageId, threadId, labelIds } }],
  };
}

function processedMessageIds() {
  return vi
    .mocked(processHistoryItem)
    .mock.calls.map(([event]) => event.item.message?.id);
}

function cursorUpdates() {
  return vi
    .mocked(prisma.$executeRaw)
    .mock.calls.map((call) => call[1] as unknown as string);
}

function lastCursorUpdate() {
  return cursorUpdates().at(-1);
}
