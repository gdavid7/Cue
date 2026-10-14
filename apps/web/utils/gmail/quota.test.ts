import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithAuditContext } from "@/utils/audit/context";
import {
  describeProviderRateLimitError,
  recordProviderRateLimitFromError,
} from "@/utils/email/rate-limit";
import { createScopedLogger } from "@/utils/logger";
import {
  GmailCallDeferredError,
  gmailRequestCost,
  meterGmailCall,
  runWithGmailQuota,
  setGmailInitialSync,
} from "@/utils/gmail/quota";
import { gmailQuotaStore } from "@/utils/gmail/quota-store";

vi.mock("@/utils/gmail/quota-store", async () => {
  const { createMemoryGmailQuotaStore } = await import(
    "@/__tests__/mocks/gmail-quota-store.mock"
  );
  return { gmailQuotaStore: createMemoryGmailQuotaStore() };
});
vi.mock("@/utils/redis/email-provider-rate-limit", () => ({
  isEmailProviderRateLimitRedisConfigured: () => true,
  getEmailProviderRateLimitStateFromRedis: async () => null,
  setEmailProviderRateLimitStateInRedis: vi.fn(async () => undefined),
}));

const ACCOUNT = "account-1";
const logger = createScopedLogger("gmail-quota-test");
const quotaRefusal = {
  status: 403,
  errors: [{ reason: "rateLimitExceeded" }],
  message:
    "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'",
};

describe("Gmail quota gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (gmailQuotaStore as unknown as { reset(): void }).reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("charges Gmail's documented cost per method", () => {
    const base = "https://gmail.googleapis.com/gmail/v1/users/me";
    expect(gmailRequestCost("GET", `${base}/messages/abc`)).toBe(20);
    expect(gmailRequestCost("GET", `${base}/messages?q=x`)).toBe(5);
    expect(gmailRequestCost("GET", `${base}/threads/abc`)).toBe(40);
    expect(gmailRequestCost("GET", `${base}/threads`)).toBe(10);
    expect(gmailRequestCost("GET", `${base}/history`)).toBe(2);
    expect(gmailRequestCost("GET", `${base}/labels`)).toBe(1);
    expect(gmailRequestCost("POST", `${base}/messages/send`)).toBe(100);
    expect(gmailRequestCost("POST", `${base}/messages/batchModify`)).toBe(50);
    expect(gmailRequestCost("GET", `${base}/profile`)).toBe(1);
  });

  it("holds background work during a first sync but admits a thread open at once", async () => {
    await setGmailInitialSync(ACCOUNT, true);
    const read = vi.fn(async () => "thread");

    await expect(
      runWithGmailQuota(
        { caller: "user/inbox-insights", priority: "background" },
        () => meterGmailCall({ emailAccountId: ACCOUNT, cost: 20 }, read),
      ),
    ).rejects.toBeInstanceOf(GmailCallDeferredError);
    await expect(
      runWithAuditContext({ source: "mail/v1/conversation-membership" }, () =>
        meterGmailCall({ emailAccountId: ACCOUNT, cost: 40 }, read),
      ),
    ).resolves.toBe("thread");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps a reserved slice for interactive calls once sync has spent the bucket", async () => {
    const sync = () =>
      runWithGmailQuota(
        { caller: "mail/v1/enumeration", priority: "sync" },
        () =>
          meterGmailCall(
            { emailAccountId: ACCOUNT, cost: 400 },
            async () => "page",
          ),
      );
    await sync();
    await sync();
    // A third page has to wait for the bucket to refill.
    let third = false;
    sync().then(() => {
      third = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(third).toBe(false);

    await expect(
      runWithGmailQuota(
        { caller: "chat/readEmail", priority: "interactive" },
        () =>
          meterGmailCall(
            { emailAccountId: ACCOUNT, cost: 40 },
            async () => "read",
          ),
      ),
    ).resolves.toBe("read");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(third).toBe(true);
  });

  it("pauses only background callers when Gmail refuses a background call", async () => {
    await expect(
      runWithGmailQuota(
        { caller: "loadEmailStats", priority: "background" },
        () =>
          meterGmailCall({ emailAccountId: ACCOUNT, cost: 20 }, async () => {
            throw quotaRefusal;
          }),
      ),
    ).rejects.toBe(quotaRefusal);

    await expect(
      runWithGmailQuota(
        { caller: "loadEmailStats", priority: "background" },
        () =>
          recordProviderRateLimitFromError({
            error: quotaRefusal,
            emailAccountId: ACCOUNT,
            provider: "google",
            logger,
          }),
      ),
    ).resolves.toBeNull();
    await expect(
      runWithGmailQuota({ caller: "user/stats", priority: "background" }, () =>
        meterGmailCall({ emailAccountId: ACCOUNT, cost: 20 }, async () => "x"),
      ),
    ).rejects.toBeInstanceOf(GmailCallDeferredError);
    await expect(
      runWithGmailQuota(
        { caller: "mail/v1/enumeration", priority: "sync" },
        () =>
          meterGmailCall(
            { emailAccountId: ACCOUNT, cost: 500 },
            async () => "page",
          ),
      ),
    ).resolves.toBe("page");
  });

  it("never puts the account in rate-limit mode for the gate's own deferral", async () => {
    const deferred = Object.assign(new Error("request failed"), {
      cause: new GmailCallDeferredError(15_000, "sync"),
    });
    await expect(
      runWithAuditContext({ source: "google/webhook" }, () =>
        recordProviderRateLimitFromError({
          error: deferred,
          emailAccountId: ACCOUNT,
          provider: "google",
          logger,
        }),
      ),
    ).resolves.toBeNull();
  });

  it("tells the assistant when Gmail is limiting requests", () => {
    expect(
      describeProviderRateLimitError(
        new GmailCallDeferredError(12_000, "sync"),
        "google",
      ),
    ).toBe(
      "Gmail is temporarily limiting requests; try again in about 12 seconds.",
    );
    expect(
      describeProviderRateLimitError(new Error("Not Found"), "google"),
    ).toBeNull();
  });
});
