import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithAuditContext } from "@/utils/audit/context";
import {
  describeProviderRateLimitError,
  recordProviderRateLimitFromError,
} from "@/utils/email/rate-limit";
import { createScopedLogger } from "@/utils/logger";
import {
  currentGmailQuotaContext,
  GmailCallDeferredError,
  gmailRequestCost,
  logGmailQuotaUsage,
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
// The gate remembers marks per process, so this scan gets its own account.
const BACKFILL_ACCOUNT = "account-backfill";
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
    vi.restoreAllMocks();
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

    const insights = runWithGmailQuota(
      { caller: "user/inbox-insights", priority: "background" },
      () => meterGmailCall({ emailAccountId: ACCOUNT, cost: 20 }, read),
    ).catch((error: unknown) => error);
    await expect(
      runWithAuditContext({ source: "mail/v1/conversation-membership" }, () =>
        meterGmailCall({ emailAccountId: ACCOUNT, cost: 40 }, read),
      ),
    ).resolves.toBe("thread");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await insights).toBeInstanceOf(GmailCallDeferredError);
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

  it("counts calls the gate let through without its store in the next minute's usage summary", async () => {
    vi.setSystemTime(new Date("2026-10-14T12:00:10Z"));
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const take = vi.spyOn(gmailQuotaStore, "take");
    take.mockReturnValueOnce(new Promise(() => undefined));
    take.mockRejectedValueOnce(new Error("Redis unavailable"));
    const read = () =>
      runWithGmailQuota(
        { caller: "mail/v1/conversation-membership", priority: "interactive" },
        () =>
          meterGmailCall(
            { emailAccountId: ACCOUNT, cost: 40 },
            async () => "thread",
          ),
      );

    const hung = read();
    await vi.advanceTimersByTimeAsync(300);
    await hung;
    await read();
    await vi.advanceTimersByTimeAsync(60_000);
    await logGmailQuotaUsage();

    // Logged once for the minute rather than on every call.
    expect(
      warn.mock.calls.filter(([line]) =>
        String(line).includes("Gmail quota store unavailable"),
      ),
    ).toHaveLength(1);
    const summary = info.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes("Gmail quota usage"));
    expect(summary).toBeDefined();
    expect(JSON.parse(summary!.slice(summary!.indexOf("{")))).toMatchObject({
      minute: "2026-10-14T12:00:00.000Z",
      storeUnavailableCalls: 2,
      storeUnavailableByCaller: { "mail/v1/conversation-membership": 2 },
    });
  });

  it("logs a burst's usage once its minute ends, at a request end with no further Gmail calls", async () => {
    vi.setSystemTime(new Date("2026-10-14T13:00:20Z"));
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const summaries = () =>
      info.mock.calls
        .map(([line]) => String(line))
        .filter(
          (line) =>
            line.includes("Gmail quota usage") &&
            line.includes("account-burst"),
        )
        .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
    for (let call = 0; call < 3; call++) {
      await runWithGmailQuota(
        { caller: "mail/v1/conversation-membership", priority: "interactive" },
        () =>
          meterGmailCall(
            { emailAccountId: "account-burst", cost: 40 },
            async () => "thread",
          ),
      );
    }

    // The burst's own request ends inside the minute it is still counting.
    await logGmailQuotaUsage();
    expect(summaries()).toEqual([]);

    // Any later request end on the instance reports it, exactly once.
    await vi.advanceTimersByTimeAsync(60_000);
    await logGmailQuotaUsage();
    await logGmailQuotaUsage();
    expect(summaries()).toEqual([
      expect.objectContaining({
        minute: "2026-10-14T13:00:00.000Z",
        totalUnits: 120,
        unitsByCaller: { "interactive:mail/v1/conversation-membership": 120 },
      }),
    ]);
  });

  it("lets a call through when the quota store fails, since Gmail's own limit still applies", async () => {
    vi.spyOn(gmailQuotaStore, "take").mockRejectedValueOnce(
      new Error("Redis unavailable"),
    );
    const read = vi.fn(async () => "thread");

    await expect(
      runWithGmailQuota(
        { caller: "user/inbox-insights", priority: "background" },
        () => meterGmailCall({ emailAccountId: ACCOUNT, cost: 40 }, read),
      ),
    ).resolves.toBe("thread");
  });

  it("does not let a hung quota store hold a Gmail call for more than a moment", async () => {
    vi.spyOn(gmailQuotaStore, "take").mockReturnValueOnce(
      new Promise(() => undefined),
    );
    let result: string | null = null;
    runWithGmailQuota(
      { caller: "mail/v1/conversation-membership", priority: "interactive" },
      () =>
        meterGmailCall(
          { emailAccountId: ACCOUNT, cost: 40 },
          async () => "thread",
        ),
    ).then((value) => {
      result = value;
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(result).toBe("thread");
  });

  it("does not let a hung quota store hold up recording a Gmail refusal", async () => {
    vi.spyOn(gmailQuotaStore, "block").mockReturnValueOnce(
      new Promise(() => undefined),
    );
    let settled = false;
    runWithGmailQuota(
      { caller: "mail/v1/conversation-membership", priority: "interactive" },
      () =>
        meterGmailCall({ emailAccountId: ACCOUNT, cost: 40 }, async () => {
          throw quotaRefusal;
        }),
    ).catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toBe(true);
  });

  it("writes the first-sync marker once while a scan pages through, and clears it at the end", async () => {
    const block = vi.spyOn(gmailQuotaStore, "block");
    for (let page = 0; page < 10; page++) {
      await setGmailInitialSync("account-scan", true);
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(block).toHaveBeenCalledTimes(1);

    // A long scan refreshes the marker before it expires.
    await vi.advanceTimersByTimeAsync(30_000);
    await setGmailInitialSync("account-scan", true);
    expect(block).toHaveBeenCalledTimes(2);

    await setGmailInitialSync("account-scan", false);
    await expect(
      runWithGmailQuota(
        { caller: "user/inbox-insights", priority: "background" },
        () =>
          meterGmailCall(
            { emailAccountId: "account-scan", cost: 20 },
            async () => "x",
          ),
      ),
    ).resolves.toBe("x");
    // The next scan marks the account again.
    await setGmailInitialSync("account-scan", true);
    expect(block).toHaveBeenCalledTimes(3);
  });

  it("lets the backfill in as soon as the first sync ends rather than waiting out the marker's expiry", async () => {
    // The engine interleaves its scopes: the primary scan marks the account,
    // then the history backfill asks for its first page while usage is low.
    await setGmailInitialSync(BACKFILL_ACCOUNT, true);
    const backfillPage = () =>
      runWithGmailQuota(
        { caller: "mail/v1/enumeration", priority: "background" },
        () =>
          meterGmailCall(
            { emailAccountId: BACKFILL_ACCOUNT, cost: 255 },
            async () => "page",
          ),
      );

    // A scan that outlasts the gate's wait only defers the backfill briefly.
    const deferred = backfillPage().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    const error = await deferred;
    expect(error).toBeInstanceOf(GmailCallDeferredError);
    expect((error as GmailCallDeferredError).retryAfterMs).toBeLessThanOrEqual(
      5000,
    );

    // The primary scan's last page lands a moment later; the next attempt is
    // admitted within a few seconds, not after the marker's 90 s expiry.
    let admitted: number | null = null;
    const startedAt = Date.now();
    backfillPage().then(() => {
      admitted = Date.now() - startedAt;
    });
    await vi.advanceTimersByTimeAsync(1000);
    await setGmailInitialSync(BACKFILL_ACCOUNT, false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(admitted).not.toBeNull();
    expect(admitted).toBeLessThanOrEqual(5000);
  });

  it("makes every caller wait out Gmail's minute after a refusal outside background work", async () => {
    await expect(
      runWithGmailQuota(
        { caller: "mail/v1/conversation-membership", priority: "interactive" },
        () =>
          meterGmailCall({ emailAccountId: ACCOUNT, cost: 40 }, async () => {
            throw quotaRefusal;
          }),
      ),
    ).rejects.toBe(quotaRefusal);

    // The bucket is empty: a sync page waits for it to refill.
    let page = false;
    runWithGmailQuota({ caller: "mail/v1/enumeration", priority: "sync" }, () =>
      meterGmailCall(
        { emailAccountId: ACCOUNT, cost: 100 },
        async () => "page",
      ),
    ).then(() => {
      page = true;
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(page).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(page).toBe(true);
    // Background work stays out until the pause ends.
    await expect(
      runWithGmailQuota(
        { caller: "user/inbox-insights", priority: "background" },
        () =>
          meterGmailCall(
            { emailAccountId: ACCOUNT, cost: 20 },
            async () => "x",
          ),
      ),
    ).rejects.toBeInstanceOf(GmailCallDeferredError);
  });

  it("treats what a person clicked, typed or opened, or what blocks the page they opened, as interactive and only enrichment as background", () => {
    const priorityOf = (source: string) =>
      runWithAuditContext(
        { source },
        () => currentGmailQuotaContext().priority,
      );
    for (const source of [
      "user/senders/bulk",
      "user/senders/unsubscribe",
      "user/senders/status",
      "user/search-answer",
      "user/drafts/update",
      "user/scheduled-emails/retry",
      "user/snoozed-threads/create",
      "v1/senders/unsubscribe",
      "messages/send",
      "messages",
      "threads/archive",
      "mail/v1/conversation-membership",
      "mail/v1/operations",
      "mobile/all-inboxes/archive",
      // The mail page cannot paint until it has the account's labels.
      "labels",
      // The assistant's own route scopes, as their handlers name them.
      "chat",
      "chat/stream",
      "chat/confirm-email-action",
    ])
      expect([source, priorityOf(source)]).toEqual([source, "interactive"]);
    for (const source of [
      "user/inbox-insights",
      "user/thread-context",
      "user/suggested-reply",
      "user/stats/load",
      "user/categorize/senders/batch",
      "cron/scheduled-actions",
      "resend/digest",
      "clean/gmail",
    ])
      expect([source, priorityOf(source)]).toEqual([source, "background"]);
    for (const source of [
      "mail/v1/enumeration",
      "mobile/mailbox-sync",
      "google/webhook",
      "user/home",
      // A route that only shares a prefix with a background one.
      "user/stats-preview",
    ])
      expect([source, priorityOf(source)]).toEqual([source, "sync"]);
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
