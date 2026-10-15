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
const JOBS_ACCOUNT = "account-jobs";
const PACE_ACCOUNT = "account-pace";
// Gmail refuses short bursts past this many units a second, per user.
const GMAIL_UNITS_PER_SECOND = 250;
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
    let stop = false;
    let pages = 0;
    const scan = (async () => {
      while (!stop) {
        await runWithGmailQuota(
          { caller: "mail/v1/enumeration", priority: "sync" },
          () =>
            meterGmailCall(
              { emailAccountId: ACCOUNT, cost: 100 },
              async () => "page",
            ),
        );
        pages++;
      }
    })();
    await vi.advanceTimersByTimeAsync(30_000);
    // The scan has spent the bucket down to its floor and now runs at the
    // bucket's refill rate: 1,000 - 200 + 30 s at 60 units a second.
    expect(pages).toBeLessThanOrEqual(26);

    let read = false;
    runWithGmailQuota(
      { caller: "chat/readEmail", priority: "interactive" },
      () =>
        meterGmailCall({ emailAccountId: ACCOUNT, cost: 40 }, async () => {
          read = true;
        }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toBe(true);

    stop = true;
    await vi.advanceTimersByTimeAsync(15_000);
    await scan;
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
            { emailAccountId: ACCOUNT, cost: 100 },
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
      storeUnavailableByCaller: [
        { caller: "mail/v1/conversation-membership", calls: 2 },
      ],
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
        peakSecondUnits: 120,
        unitsByCaller: [
          {
            priority: "interactive",
            caller: "mail/v1/conversation-membership",
            units: 120,
          },
        ],
      }),
    ]);
    // Callers are values, never keys: each key path is an Axiom column.
    expect(Object.keys(summaries()[0]).sort()).toEqual([
      "deferredByCaller",
      "emailAccountId",
      "limitUnits",
      "minute",
      "peakSecondUnits",
      "refusedByCaller",
      "storeUnavailableByCaller",
      "storeUnavailableCalls",
      "totalUnits",
      "unitsByCaller",
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

    // The engine runs its scopes one request at a time, so a backfill request
    // held at the gate would also hold up the scan that clears the marker.
    // It is turned away at once and asked back within seconds.
    let settled: unknown = null;
    backfillPage().then(
      (value) => {
        settled = value;
      },
      (error: unknown) => {
        settled = error;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBeInstanceOf(GmailCallDeferredError);
    const retryAfterMs = (settled as GmailCallDeferredError).retryAfterMs;
    expect(retryAfterMs).toBeLessThanOrEqual(5000);

    // The primary scan's last page lands a moment later, so the backfill's
    // next attempt is admitted rather than waiting out the marker's expiry.
    await vi.advanceTimersByTimeAsync(1000);
    await setGmailInitialSync(BACKFILL_ACCOUNT, false);
    await vi.advanceTimersByTimeAsync(retryAfterMs - 1000);
    await expect(backfillPage()).resolves.toBe("page");
  });

  it("asks only the engine's backfill back within seconds; jobs and routes wait out the first sync", async () => {
    await setGmailInitialSync(JOBS_ACCOUNT, true);
    await vi.advanceTimersByTimeAsync(10_000);
    const deferral = (caller: string) =>
      runWithGmailQuota({ caller, priority: "background" }, () =>
        meterGmailCall(
          { emailAccountId: JOBS_ACCOUNT, cost: 20 },
          async () => "x",
        ),
      ).catch((error: unknown) => error as GmailCallDeferredError);

    // The engine retries on its own schedule and spends nothing doing so.
    const backfill = await deferral("mail/v1/enumeration");
    expect(backfill).toBeInstanceOf(GmailCallDeferredError);
    expect(backfill.retryAfterMs).toBeLessThanOrEqual(5000);

    // A queued job has a few retries; spending them while the inbox fills
    // would mark it failed, so it is told when the first sync can be over.
    const job = await deferral("automation-jobs/execute");
    expect(job).toBeInstanceOf(GmailCallDeferredError);
    expect(job.retryAfterMs).toBeGreaterThan(60_000);
    expect(job.retryAfterMs).toBeLessThanOrEqual(80_000);
  });

  it("pauses sync and background after a refusal but keeps admitting what a person is waiting on", async () => {
    await expect(
      runWithGmailQuota(
        { caller: "mail/v1/enumeration", priority: "sync" },
        () =>
          meterGmailCall({ emailAccountId: ACCOUNT, cost: 100 }, async () => {
            throw quotaRefusal;
          }),
      ),
    ).rejects.toBe(quotaRefusal);
    await vi.advanceTimersByTimeAsync(1000);

    // A chat search right after: admitted at once, with Gmail's own retry
    // left to handle a refusal, rather than held until it gives up.
    const search = vi.fn(async () => "results");
    await expect(
      runWithGmailQuota(
        { caller: "chat/searchInbox", priority: "interactive" },
        () => meterGmailCall({ emailAccountId: ACCOUNT, cost: 200 }, search),
      ),
    ).resolves.toBe("results");
    expect(search).toHaveBeenCalledTimes(1);

    // The sync waits out the pause.
    let page = false;
    runWithGmailQuota({ caller: "mail/v1/enumeration", priority: "sync" }, () =>
      meterGmailCall(
        { emailAccountId: ACCOUNT, cost: 100 },
        async () => "page",
      ),
    ).then(() => {
      page = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(page).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(page).toBe(true);
    // Background work stays out until its longer pause ends.
    let insight = false;
    runWithGmailQuota(
      { caller: "user/inbox-insights", priority: "background" },
      () =>
        meterGmailCall({ emailAccountId: ACCOUNT, cost: 20 }, async () => {
          insight = true;
        }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(insight).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(insight).toBe(true);
  });

  it("never admits more in any second than Gmail allows, leaving room for interactive calls", async () => {
    const admissions: Array<{ at: number; cost: number }> = [];
    const admit = (
      priority: "sync" | "background" | "interactive",
      cost: number,
    ) =>
      runWithGmailQuota({ caller: `test/${priority}`, priority }, () =>
        meterGmailCall({ emailAccountId: PACE_ACCOUNT, cost }, async () => {
          admissions.push({ at: Date.now(), cost });
        }),
      );
    // A first sync asks for everything at once, as a page of batches does.
    const sync = Promise.all(
      Array.from({ length: 10 }, () => admit("sync", 100)),
    );
    await vi.advanceTimersByTimeAsync(0);
    // A person opens a thread in the middle of it.
    let openedIn: number | null = null;
    const openedAt = Date.now();
    admit("interactive", 40).then(() => {
      openedIn = Date.now() - openedAt;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(openedIn).not.toBeNull();
    expect(openedIn).toBeLessThan(1000);
    await vi.advanceTimersByTimeAsync(30_000);
    await sync;

    const peakSecond = Math.max(
      ...admissions.map(({ at }) =>
        admissions
          .filter((entry) => entry.at >= at && entry.at < at + 1000)
          .reduce((sum, entry) => sum + entry.cost, 0),
      ),
    );
    expect(peakSecond).toBeLessThanOrEqual(GMAIL_UNITS_PER_SECOND);
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
