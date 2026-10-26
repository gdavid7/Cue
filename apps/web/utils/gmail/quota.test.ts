import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithAuditContext } from "@/utils/audit/context";
import {
  describeProviderRateLimitError,
  recordProviderRateLimitFromError,
} from "@/utils/email/rate-limit";
import { createScopedLogger } from "@/utils/logger";
import {
  createGmailQuotaStats,
  currentGmailQuotaContext,
  GmailCallDeferredError,
  GMAIL_USER_UNITS_PER_MINUTE,
  gmailRequestCost,
  holdGmailInteractiveDemand,
  logGmailQuotaUsage,
  meterGmailCall,
  OPEN_THREAD_GMAIL_WAIT_MS,
  resetGmailQuotaInstanceState,
  runWithGmailQuota,
  runWithGmailWaitBudget,
  setGmailInitialSync,
} from "@/utils/gmail/quota";
import { gmailQuotaStore } from "@/utils/gmail/quota-store";
import { withGmailRetry } from "@/utils/gmail/retry";
import { runWithRequestDeadline } from "@/utils/request-deadline";
import {
  createRequestMetrics,
  getRequestMetricsFields,
  runWithRequestMetrics,
} from "@/utils/request-metrics";
import { isFastRequestSampled } from "@/utils/request-sampling";
import { sleep } from "@/utils/sleep";

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
const REASON_ACCOUNT = "account-reason";
const PACE_ACCOUNT = "account-pace";
const YIELD_ACCOUNT = "account-yield";
const LARGE_ACCOUNT = "account-large";
const OPEN_ACCOUNT = "account-open";
const WAITING_ACCOUNT = "account-waiting";
const TURN_ACCOUNT = "account-turn";
const STUCK_TURN_ACCOUNT = "account-stuck-turn";
const TURN_GAP_ACCOUNT = "account-turn-gap";
const UNHELD_SEARCH_ACCOUNT = "account-unheld-search";
const HELD_SEARCH_ACCOUNT = "account-held-search";
const GIVE_UP_ACCOUNT = "account-give-up";
const DEADLINE_ACCOUNT = "account-deadline";
const BACKOFF_ACCOUNT = "account-backoff";
const RETRY_ACCOUNT = "account-retry";
const PAGE_ACCOUNT = "account-page";
const SUSTAINED_ACCOUNT = "account-sustained";
const AIMD_ACCOUNT = "account-aimd";
const SENDING_ACCOUNT = "account-sending";
const HUNG_ACCOUNT = "account-hung";
const HOLD_ACCOUNT = "account-hold";
const CONCURRENCY_ACCOUNT = "account-concurrency";
// The gate starts each account at 80% of the per-user limit.
const STARTING_BUDGET = GMAIL_USER_UNITS_PER_MINUTE * 0.8;
const NO_DEADLINE_ACCOUNT = "account-no-deadline";
const STORE_WARN_ACCOUNT = "account-store-warn";
const STORE_ERROR_ACCOUNT = "account-store-error";
// The most the gate admits in any one second, in a short burst; the bucket
// holds what follows to the account's per-minute budget.
const GATE_UNITS_PER_SECOND = 700;
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
    resetGmailQuotaInstanceState();
    (gmailQuotaStore as unknown as { reset(): void }).reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("charges each method its cost, three times a light read for a full one", () => {
    const base = "https://gmail.googleapis.com/gmail/v1/users/me";
    // A read with no format is a full one.
    expect(gmailRequestCost("GET", `${base}/messages/abc`)).toBe(60);
    expect(
      gmailRequestCost("GET", `${base}/messages/abc?format=metadata`),
    ).toBe(20);
    expect(gmailRequestCost("GET", `${base}/messages/abc?format=minimal`)).toBe(
      20,
    );
    expect(gmailRequestCost("GET", `${base}/messages/abc?format=raw`)).toBe(60);
    expect(gmailRequestCost("GET", `${base}/messages?q=x`)).toBe(5);
    expect(gmailRequestCost("GET", `${base}/threads/abc`)).toBe(120);
    expect(
      gmailRequestCost("GET", new URL(`${base}/threads/abc?format=metadata`)),
    ).toBe(40);
    expect(gmailRequestCost("GET", `${base}/drafts/abc?format=full`)).toBe(60);
    expect(gmailRequestCost("GET", `${base}/drafts/abc?format=metadata`)).toBe(
      20,
    );
    expect(gmailRequestCost("DELETE", `${base}/messages/abc`)).toBe(10);
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
    // bucket's refill rate: 2,000 - 800 + 30 s of a 12,000-unit budget.
    expect(pages).toBeLessThanOrEqual(72);

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

  it("warns once when one slow store fails both a call's admission and the usage summary", async () => {
    vi.setSystemTime(new Date("2026-10-14T14:00:10Z"));
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(gmailQuotaStore, "take").mockReturnValueOnce(
      new Promise(() => undefined),
    );
    vi.spyOn(gmailQuotaStore, "claimUsages").mockReturnValueOnce(
      new Promise(() => undefined),
    );

    const call = runWithGmailQuota(
      { caller: "mail/v1/conversation-membership", priority: "interactive" },
      () =>
        meterGmailCall(
          { emailAccountId: STORE_WARN_ACCOUNT, cost: 40 },
          async () => "thread",
        ),
    );
    await vi.advanceTimersByTimeAsync(300);
    await call;
    const summary = logGmailQuotaUsage();
    await vi.advanceTimersByTimeAsync(300);
    await summary;

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      "Gmail quota store unavailable",
    );
    expect(
      info.mock.calls.some(([line]) =>
        String(line).includes("Failed to summarize Gmail quota usage"),
      ),
    ).toBe(true);
  });

  it("still warns about a usage summary that fails for a reason other than a store timeout", async () => {
    vi.setSystemTime(new Date("2026-10-14T14:10:10Z"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(gmailQuotaStore, "take").mockReturnValueOnce(
      new Promise(() => undefined),
    );
    vi.spyOn(gmailQuotaStore, "claimUsages").mockRejectedValueOnce(
      new Error("WRONGTYPE Operation against a key holding the wrong kind"),
    );

    const call = runWithGmailQuota(
      { caller: "mail/v1/conversation-membership", priority: "interactive" },
      () =>
        meterGmailCall(
          { emailAccountId: STORE_ERROR_ACCOUNT, cost: 40 },
          async () => "thread",
        ),
    );
    await vi.advanceTimersByTimeAsync(300);
    await call;
    await logGmailQuotaUsage();

    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining("Gmail quota store unavailable"),
      expect.stringContaining("Failed to summarize Gmail quota usage"),
    ]);
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
        peakSecondCapUnits: expect.any(Number),
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
      "budgetUnits",
      "deferredByCaller",
      "emailAccountId",
      "limitUnits",
      "minute",
      "peakSecondCapUnits",
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

  it("still records the rest of a refusal when one store write hangs", async () => {
    // The first write, the background pause, never answers.
    vi.spyOn(gmailQuotaStore, "block").mockReturnValueOnce(
      new Promise(() => undefined),
    );
    runWithGmailQuota({ caller: "mail/v1/enumeration", priority: "sync" }, () =>
      meterGmailCall({ emailAccountId: HUNG_ACCOUNT, cost: 40 }, async () => {
        throw quotaRefusal;
      }),
    ).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(300);

    // Sync still stands back after the refusal.
    let page = false;
    runWithGmailQuota({ caller: "mail/v1/enumeration", priority: "sync" }, () =>
      meterGmailCall(
        { emailAccountId: HUNG_ACCOUNT, cost: 40 },
        async () => "page",
      ),
    ).then(() => {
      page = true;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(page).toBe(false);
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

  it("holds a first sync's inbox backfill at sync behind the primary scan, even with the scan's lease live", async () => {
    const account = "account-inbox-first";
    const call = (
      context: Parameters<typeof runWithGmailQuota>[0],
      cost: number,
    ) =>
      runWithGmailQuota(context, () =>
        meterGmailCall({ emailAccountId: account, cost }, async () => "x"),
      ).catch((error: unknown) => error as GmailCallDeferredError);
    const scan = { caller: "mail/v1/enumeration", priority: "sync" } as const;
    const inboxFirst = { ...scan, afterInitialSync: true };

    // The primary scan pages steadily, so its lane holds a reservation.
    await setGmailInitialSync(account, true);
    for (let i = 0; i < 6; i++) {
      expect(await call(scan, 20)).toBe("x");
      await vi.advanceTimersByTimeAsync(150);
    }

    // The inbox backfill is turned away at once and asked back within
    // seconds, as the background backfill is, while the scan keeps going.
    const held = await call(inboxFirst, 20);
    expect(held).toBeInstanceOf(GmailCallDeferredError);
    expect((held as GmailCallDeferredError).reason).toBe("initial_sync_scan");
    expect((held as GmailCallDeferredError).retryAfterMs).toBeLessThanOrEqual(
      5000,
    );
    expect(await call(scan, 20)).toBe("x");

    await setGmailInitialSync(account, false);
    await vi.advanceTimersByTimeAsync(60_000);
    // Once the scan is done it pages at sync, in batches of sync's request
    // size, until what is left is sync's floor: that is kept for a person.
    let admitted = 0;
    let stopped: unknown = null;
    while (!stopped) {
      const result = await call({ ...inboxFirst, maxTotalWaitMs: 0 }, 240);
      if (result === "x") admitted += 1;
      else stopped = result;
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(admitted).toBeGreaterThan(4);
    expect((stopped as GmailCallDeferredError).reason).toBe(
      "per_minute_budget",
    );
    // A thread a person opens meanwhile is read at once (D-086).
    expect(
      await call(
        {
          caller: "threads/detail",
          priority: "interactive",
          maxTotalWaitMs: 0,
        },
        120,
      ),
    ).toBe("x");
  });

  it("lets a refused inbox backfill page stand back as background, never holding webhooks or live changes", async () => {
    const account = "account-inbox-first-refused";
    const call = (
      context: Parameters<typeof runWithGmailQuota>[0],
      operation: () => Promise<string> = async () => "x",
    ) =>
      runWithGmailQuota({ maxTotalWaitMs: 0, ...context }, () =>
        meterGmailCall({ emailAccountId: account, cost: 20 }, operation),
      ).catch((error: unknown) => error);
    const inboxFirst = {
      caller: "mail/v1/enumeration",
      priority: "sync",
      afterInitialSync: true,
    } as const;
    // Gmail refuses the page for volume and names a retry minutes away.
    const volume = refusal(
      403,
      `Quota exceeded for quota metric 'Queries' and limit 'Units per minute per user'. Retry after ${new Date(Date.now() + 4 * 60_000).toISOString()}`,
    );
    expect(
      await call(inboxFirst, async () => {
        throw volume;
      }),
    ).toBe(volume);

    // The push and the primary stream's catch-up keep going.
    expect(await call({ caller: "google/webhook", priority: "sync" })).toBe(
      "x",
    );
    expect(await call({ caller: "mail/v1/changes", priority: "sync" })).toBe(
      "x",
    );
    // The backfill, this page's own scan included, waits out the retry time.
    const held = await call(inboxFirst);
    expect(held).toBeInstanceOf(GmailCallDeferredError);
    expect((held as GmailCallDeferredError).reason).toBe("background_pause");
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(await call(inboxFirst)).toBeInstanceOf(GmailCallDeferredError);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(await call(inboxFirst)).toBe("x");
  });

  it("drops a first sync's inbox backfill to sync's yield while a person's large request runs", async () => {
    const account = "account-inbox-first-demand";
    const inboxFirst = {
      caller: "mail/v1/enumeration",
      priority: "sync",
      afterInitialSync: true,
      maxTotalWaitMs: 0,
    } as const;
    const page = (cost: number) =>
      runWithGmailQuota(inboxFirst, () =>
        meterGmailCall({ emailAccountId: account, cost }, async () => "x"),
      ).catch((error: unknown) => error as GmailCallDeferredError);
    // A search a person typed: a large read that starts a demand episode.
    await expect(
      runWithGmailQuota(
        { caller: "mail/v1/search", priority: "interactive" },
        () =>
          meterGmailCall(
            { emailAccountId: account, cost: 400 },
            async () => "found",
          ),
      ),
    ).resolves.toBe("found");
    const yielded = await page(240);
    expect(yielded).toBeInstanceOf(GmailCallDeferredError);
    expect((yielded as GmailCallDeferredError).reason).toBe(
      "interactive_demand_yield",
    );
    // Once the episode ends the inbox backfill pages at sync again.
    await vi.advanceTimersByTimeAsync(3000);
    expect(await page(240)).toBe("x");
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

  it("names the gate that held a deferred call", async () => {
    await setGmailInitialSync(REASON_ACCOUNT, true);
    await vi.advanceTimersByTimeAsync(10_000);
    const deferral = () =>
      runWithGmailQuota(
        { caller: "automation-jobs/execute", priority: "background" },
        () =>
          meterGmailCall(
            { emailAccountId: REASON_ACCOUNT, cost: 20 },
            async () => "x",
          ),
      ).catch((error: unknown) => error as GmailCallDeferredError);
    expect((await deferral()).reason).toBe("initial_sync_scan");
  });

  it("names the bucket when the per-minute budget cannot pay", async () => {
    const spend = (cost: number) =>
      runWithGmailQuota(
        { caller: "mail/v1/enumeration", priority: "sync", maxTotalWaitMs: 0 },
        () =>
          meterGmailCall(
            { emailAccountId: "account-reason-bucket", cost },
            async () => "x",
          ),
      ).catch((error: unknown) => error as GmailCallDeferredError);
    let outcome: unknown = "x";
    for (let i = 0; i < 20 && outcome === "x"; i++) {
      outcome = await spend(500);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(outcome).toBeInstanceOf(GmailCallDeferredError);
    expect((outcome as GmailCallDeferredError).reason).toBe(
      "per_minute_budget",
    );
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
    // Background comes back soon after, at a slower pace.
    let insight = false;
    runWithGmailQuota(
      { caller: "user/inbox-insights", priority: "background" },
      () =>
        meterGmailCall({ emailAccountId: ACCOUNT, cost: 20 }, async () => {
          insight = true;
        }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(insight).toBe(true);
  });

  it("holds a person's retry after Gmail refuses them instead of resending at once", async () => {
    const sentAt: number[] = [];
    const search = () =>
      runWithGmailQuota(
        { caller: "chat/searchInbox", priority: "interactive" },
        () =>
          withGmailRetry(() =>
            meterGmailCall(
              { emailAccountId: RETRY_ACCOUNT, cost: 5 },
              async () => {
                sentAt.push(Date.now());
                if (sentAt.length === 1)
                  throw Object.assign(new Error(quotaRefusal.message), {
                    status: quotaRefusal.status,
                    errors: quotaRefusal.errors,
                  });
                return "results";
              },
            ),
          ),
      );
    const startedAt = Date.now();

    const result = search();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toBe("results");
    expect(sentAt).toHaveLength(2);
    // Its own backoff would resend after two seconds, into the same refusal.
    expect(sentAt[1] - startedAt).toBeGreaterThanOrEqual(5000);
  });

  it("slows background work after a refusal rather than resuming at its old rate", async () => {
    const admissions: number[] = [];
    const backfill = () =>
      runWithGmailQuota(
        { caller: "mail/v1/enumeration", priority: "background" },
        () =>
          meterGmailCall(
            { emailAccountId: BACKOFF_ACCOUNT, cost: 20 },
            async () => {
              admissions.push(Date.now());
            },
          ),
      );
    const unitsOverTenSeconds = async () => {
      const from = Date.now();
      let stop = false;
      const loop = (async () => {
        while (!stop) await backfill().catch(() => sleep(1000));
      })();
      await vi.advanceTimersByTimeAsync(10_000);
      stop = true;
      await vi.advanceTimersByTimeAsync(2000);
      await loop;
      return (
        admissions.filter((at) => at >= from && at < from + 10_000).length * 20
      );
    };
    const before = await unitsOverTenSeconds();
    expect(before).toBeGreaterThan(300);

    await expect(
      runWithGmailQuota(
        { caller: "mail/v1/enumeration", priority: "background" },
        () =>
          meterGmailCall(
            { emailAccountId: BACKOFF_ACCOUNT, cost: 20 },
            async () => {
              throw quotaRefusal;
            },
          ),
      ),
    ).rejects.toBe(quotaRefusal);
    await vi.advanceTimersByTimeAsync(20_000);

    const after = await unitsOverTenSeconds();
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(before / 2);
  });

  it("admits a 1,005-unit request at once from a full bucket", async () => {
    const page = vi.fn(async () => "page");

    await expect(
      runWithGmailQuota({ caller: "threads", priority: "interactive" }, () =>
        meterGmailCall({ emailAccountId: PAGE_ACCOUNT, cost: 1005 }, page),
      ),
    ).resolves.toBe("page");
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("keeps a sustained backfill within the account's per-minute budget", async () => {
    vi.setSystemTime(new Date("2026-10-14T14:00:00Z"));
    const admissions: number[] = [];
    let stop = false;
    const backfill = (async () => {
      while (!stop)
        await runWithGmailQuota(
          { caller: "mail/v1/enumeration", priority: "background" },
          () =>
            meterGmailCall(
              { emailAccountId: SUSTAINED_ACCOUNT, cost: 20 },
              async () => {
                admissions.push(Date.now());
              },
            ),
        ).catch(() => sleep(1000));
    })();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    stop = true;
    await vi.advanceTimersByTimeAsync(2000);
    await backfill;

    // Past the bucket's opening balance, each minute stays within the budget
    // an account starts with, near the most background's pace allows.
    for (let minute = 1; minute < 4; minute++) {
      const from = Date.parse("2026-10-14T14:00:00Z") + minute * 60_000;
      const units =
        admissions.filter((at) => at >= from && at < from + 60_000).length * 20;
      expect(units).toBeLessThanOrEqual(STARTING_BUDGET + 20);
      expect(units).toBeGreaterThan(STARTING_BUDGET * 0.8);
    }
  });

  it("never holds a person's reads for a sending limit that lifts in hours", async () => {
    const sendingLimit = refusal(
      429,
      `User-rate limit exceeded.  Retry after ${new Date(Date.now() + 3 * 60 * 60_000).toISOString()} (Mail sending)`,
    );
    await expect(
      interactive(SENDING_ACCOUNT, async () => {
        throw sendingLimit;
      }),
    ).rejects.toBe(sendingLimit);

    // A read right away, and another an hour later, go straight through.
    const read = vi.fn(async () => "thread");
    await expect(interactive(SENDING_ACCOUNT, read)).resolves.toBe("thread");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await expect(interactive(SENDING_ACCOUNT, read)).resolves.toBe("thread");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("holds a person's reads for at most ten seconds after a volume refusal", async () => {
    const volume = refusal(
      403,
      `Quota exceeded for quota metric 'Queries' and limit 'Units per minute per user'. Retry after ${new Date(Date.now() + 2 * 60_000).toISOString()}`,
    );
    await expect(
      interactive(HOLD_ACCOUNT, async () => {
        throw volume;
      }),
    ).rejects.toBe(volume);

    let readAt: number | null = null;
    const startedAt = Date.now();
    interactive(HOLD_ACCOUNT, async () => {
      readAt = Date.now();
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(readAt).toBeNull();
    await vi.advanceTimersByTimeAsync(7000);
    expect(readAt).not.toBeNull();
    expect(readAt! - startedAt).toBeLessThanOrEqual(10_000);
  });

  it("keeps the budget through a refusal for concurrency rather than volume", async () => {
    vi.setSystemTime(new Date("2026-10-14T16:00:00Z"));
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const concurrency = refusal(429, "Too many concurrent requests for user");
    for (let i = 0; i < 20; i++) {
      const sent = interactive(CONCURRENCY_ACCOUNT, async () => "ok", 100);
      await vi.advanceTimersByTimeAsync(2000);
      await sent;
    }
    await expect(
      interactive(CONCURRENCY_ACCOUNT, async () => {
        throw concurrency;
      }),
    ).rejects.toBe(concurrency);

    const stamp = interactive(CONCURRENCY_ACCOUNT, async () => "ok");
    await vi.advanceTimersByTimeAsync(60_000);
    await stamp;
    await logGmailQuotaUsage();
    const line = info.mock.calls
      .map(([entry]) => String(entry))
      .filter(
        (entry) =>
          entry.includes("Gmail quota usage") &&
          entry.includes(CONCURRENCY_ACCOUNT),
      )
      .at(-1)!;
    expect(JSON.parse(line.slice(line.indexOf("{"))).budgetUnits).toBe(
      STARTING_BUDGET,
    );
  });

  it("tunes each account's budget to what Gmail accepts: cut on a refusal, raised after quiet periods", async () => {
    vi.setSystemTime(new Date("2026-10-14T15:00:00Z"));
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const call = (cost: number, refuse = false) =>
      runWithGmailQuota({ caller: "test/aimd", priority: "interactive" }, () =>
        meterGmailCall({ emailAccountId: AIMD_ACCOUNT, cost }, async () => {
          if (refuse) throw quotaRefusal;
          return "ok";
        }),
      );
    // The budget the minute ending now ran at, from its usage line.
    const budgetOfMinuteEnding = async () => {
      const stamp = call(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await stamp;
      await logGmailQuotaUsage();
      const lines = info.mock.calls
        .map(([line]) => String(line))
        .filter(
          (line) =>
            line.includes("Gmail quota usage") && line.includes(AIMD_ACCOUNT),
        );
      return JSON.parse(lines.at(-1)!.slice(lines.at(-1)!.indexOf("{")))
        .budgetUnits as number;
    };

    expect(await budgetOfMinuteEnding()).toBe(STARTING_BUDGET);

    // 2,000 units in the last minute, then Gmail refuses.
    for (let i = 0; i < 20; i++) {
      const sent = call(100);
      await vi.advanceTimersByTimeAsync(2000);
      await sent;
    }
    await expect(call(20, true)).rejects.toBe(quotaRefusal);
    // 85% of what the gate let through in the minute before the refusal.
    expect(await budgetOfMinuteEnding()).toBe(Math.floor(2020 * 0.85));

    // A refusal after hardly any traffic cuts no lower than the floor.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(call(20, true)).rejects.toBe(quotaRefusal);
    expect(await budgetOfMinuteEnding()).toBe(1200);

    // Each ten minutes without a refusal raise it a tenth...
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(await budgetOfMinuteEnding()).toBe(1320);
    // ...up to 80% of Gmail's per-user limit.
    await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);
    expect(await budgetOfMinuteEnding()).toBe(
      GMAIL_USER_UNITS_PER_MINUTE * 0.8,
    );
  });

  it("never admits more in any second than its burst cap, leaving room for interactive calls", async () => {
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
      Array.from({ length: 10 }, () => admit("sync", 250)),
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
    expect(peakSecond).toBeLessThanOrEqual(GATE_UNITS_PER_SECOND);
  });

  it("gives way to a person for two seconds, then gives sync its full share back", async () => {
    const admissions: Array<{ at: number; priority: string; cost: number }> =
      [];
    const admit = (
      priority: "sync" | "background" | "interactive",
      cost: number,
    ) =>
      runWithGmailQuota({ caller: `test/${priority}`, priority }, () =>
        meterGmailCall({ emailAccountId: YIELD_ACCOUNT, cost }, async () => {
          admissions.push({ at: Date.now(), priority, cost });
        }),
      );
    const start = Date.now();
    // An assistant search's batch: seventeen messages.
    await admit("interactive", 340);

    // Sync asks for everything it can get, a message at a time.
    let stop = false;
    const scan = (async () => {
      while (!stop) await admit("sync", 20);
    })();
    let insight = false;
    admit("background", 20).then(() => {
      insight = true;
    });
    await vi.advanceTimersByTimeAsync(1900);
    // Background waits out the person's two seconds entirely.
    expect(insight).toBe(false);
    await vi.advanceTimersByTimeAsync(2100);
    stop = true;
    await vi.advanceTimersByTimeAsync(2000);
    await scan;

    const units = (priority: string, from: number, to: number) =>
      admissions
        .filter(
          (entry) =>
            entry.priority === priority &&
            entry.at >= start + from &&
            entry.at < start + to,
        )
        .reduce((sum, entry) => sum + entry.cost, 0);
    // At most 120 units a second while the person is being served...
    expect(units("sync", 0, 1000)).toBeLessThanOrEqual(120);
    expect(units("sync", 1000, 2000)).toBeLessThanOrEqual(120);
    // ...and its full 500 a second once they have been.
    expect(units("sync", 2500, 3500)).toBeGreaterThan(400);
    expect(insight).toBe(true);
  });

  it("makes sync give way as soon as a person's first inbox page starts waiting", async () => {
    const admissions: Array<{ at: number; priority: string; cost: number }> =
      [];
    const admit = (priority: "sync" | "interactive", cost: number) =>
      runWithGmailQuota({ caller: `test/${priority}`, priority }, () =>
        meterGmailCall({ emailAccountId: WAITING_ACCOUNT, cost }, async () => {
          admissions.push({ at: Date.now(), priority, cost });
        }),
      );
    // Another session's sync keeps every second at its 500 units, in the
    // 250-unit batches it sends.
    let stop = false;
    const scans = [0, 1].map(async () => {
      while (!stop) await admit("sync", 250);
    });
    await vi.advanceTimersByTimeAsync(2500);

    // An assistant search's two batches of seventeen messages, 340 units
    // each.
    const startedAt = Date.now();
    let shownIn: number | null = null;
    (async () => {
      await admit("interactive", 340);
      await admit("interactive", 340);
      shownIn = Date.now() - startedAt;
    })();
    await vi.advanceTimersByTimeAsync(2500);
    stop = true;
    // Sync is now held to the bucket's refill above its floor.
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(scans);

    // Sync would otherwise refill each second before the batch fits, and a
    // waiting batch never started the yield that admission starts.
    expect(shownIn).not.toBeNull();
    expect(shownIn).toBeLessThanOrEqual(2000);
  });

  it("keeps sync's full share while a person opens a thread", async () => {
    const admissions: Array<{ at: number; priority: string; cost: number }> =
      [];
    const admit = (priority: "sync" | "interactive", cost: number) =>
      runWithGmailQuota({ caller: `test/${priority}`, priority }, () =>
        meterGmailCall({ emailAccountId: OPEN_ACCOUNT, cost }, async () => {
          admissions.push({ at: Date.now(), priority, cost });
        }),
      );
    const start = Date.now();
    let stop = false;
    const scan = (async () => {
      while (!stop) await admit("sync", 20);
    })();
    // Opening a thread: its messages, one small read each.
    const reads: Promise<unknown>[] = [];
    for (let read = 0; read < 3; read++) {
      await vi.advanceTimersByTimeAsync(300);
      reads.push(admit("interactive", 40));
    }
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(reads);
    stop = true;
    await vi.advanceTimersByTimeAsync(1000);
    await scan;

    const syncUnits = admissions
      .filter(
        (entry) =>
          entry.priority === "sync" &&
          entry.at >= start + 1000 &&
          entry.at < start + 2000,
      )
      .reduce((sum, entry) => sum + entry.cost, 0);
    // The second after the thread opened, sync still fills what the person's
    // reads leave of its 500 units.
    expect(syncUnits).toBeGreaterThanOrEqual(400);
  });

  it("admits a call larger than its priority's per-second cap once the second has room for it alone", async () => {
    // A background job reads three threads in full in one batch: 360 units,
    // more than background's 250 a second.
    const jobCost =
      3 *
      gmailRequestCost(
        "GET",
        "https://gmail.googleapis.com/gmail/v1/users/me/threads/t",
      );
    expect(jobCost).toBe(360);
    const admissions: Array<{ at: number; cost: number }> = [];
    const admit = (priority: "sync" | "background", cost: number) =>
      runWithGmailQuota({ caller: `test/${priority}`, priority }, () =>
        meterGmailCall({ emailAccountId: LARGE_ACCOUNT, cost }, async () => {
          admissions.push({ at: Date.now(), cost });
        }),
      );
    await admit("sync", 60);
    let renewed = false;
    admit("background", jobCost).then(() => {
      renewed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(renewed).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(renewed).toBe(true);
    // It went alone, so the second still stayed within the total cap.
    expect(admissions.at(-1)?.at).toBeGreaterThanOrEqual(
      (admissions[0]?.at ?? 0) + 1000,
    );
  });

  // PF-3a: while background work kept the bucket at its floor, the reader's
  // context ran at background too and came back 503 for about a third of
  // opens. The reserved slice above background's floor holds a whole open.
  it.each([
    ["user/thread-context", "admitted"],
    ["user/thread-brief", "admitted"],
    // What a caller nobody listed as interactive would meet.
    ["user/thread-context-unlisted", "deferred"],
  ])("gives %s's reads room while background work keeps the bucket at its floor (%s)", async (source, expected) => {
    const account = `account-reader-${source}`;
    const read = (cost: number) =>
      meterGmailCall({ emailAccountId: account, cost }, async () => undefined);
    let stop = false;
    const insights = runWithAuditContext(
      { source: "user/inbox-insights" },
      async () => {
        while (!stop) await read(100).catch(() => sleep(1000));
      },
    );
    await vi.advanceTimersByTimeAsync(30_000);

    // The open thread, then three participants' listings and their two other
    // threads in full, then the topic search and four matches' headers.
    const outcome = runWithAuditContext({ source }, () =>
      runWithGmailWaitBudget(OPEN_THREAD_GMAIL_WAIT_MS, async () => {
        await read(120);
        for (let participant = 0; participant < 3; participant++) {
          await read(10);
          await read(240);
        }
        await read(10);
        await read(160);
        return "admitted";
      }),
    ).catch((error: unknown) =>
      error instanceof GmailCallDeferredError ? "deferred" : error,
    );
    await vi.advanceTimersByTimeAsync(OPEN_THREAD_GMAIL_WAIT_MS + 1000);
    expect(await outcome).toBe(expected);

    stop = true;
    await vi.advanceTimersByTimeAsync(15_000);
    await insights;
  });

  it("answers the open thread's AI within its wait budget at interactive priority, not after a wait per call", async () => {
    const account = "account-open-thread-ai";
    const read = (cost: number) =>
      meterGmailCall({ emailAccountId: account, cost }, async () => undefined);
    // Someone else spent the bucket a moment ago.
    await runWithGmailQuota(
      { caller: "test/other", priority: "interactive" },
      () => read(2000),
    );
    const startedAt = Date.now();
    let priority: string | undefined;
    let deferredAt = Number.POSITIVE_INFINITY;
    const outcome = runWithAuditContext(
      { source: "user/suggested-reply" },
      () =>
        runWithGmailWaitBudget(OPEN_THREAD_GMAIL_WAIT_MS, async () => {
          priority = currentGmailQuotaContext().priority;
          // Each read alone would wait about three seconds for the refill.
          await read(600);
          await read(600);
          await read(600);
        }),
    ).catch((error: unknown) => {
      deferredAt = Date.now();
      return error;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const error = await outcome;
    expect(priority).toBe("interactive");
    expect(error).toBeInstanceOf(GmailCallDeferredError);
    expect((error as GmailCallDeferredError).retryAfterMs).toBeGreaterThan(0);
    // Deferred once its budget ran out, not after each call's own wait.
    expect(deferredAt - startedAt).toBeLessThanOrEqual(
      OPEN_THREAD_GMAIL_WAIT_MS,
    );
  });

  // PF-9w: the request's "Request completed" line says it was deferred.
  it("counts each deferred call on the request's metrics", async () => {
    const account = "account-request-metrics";
    const read = (cost: number) =>
      meterGmailCall({ emailAccountId: account, cost }, async () => undefined);
    await runWithGmailQuota(
      { caller: "test/other", priority: "interactive" },
      () => read(2000),
    );
    const metrics = createRequestMetrics();
    const outcome = runWithRequestMetrics(metrics, () =>
      runWithAuditContext({ source: "user/thread-brief" }, () =>
        runWithGmailWaitBudget(OPEN_THREAD_GMAIL_WAIT_MS, async () => {
          await read(600);
          await read(600);
          await read(600);
        }),
      ),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await outcome).toBeInstanceOf(GmailCallDeferredError);
    const fields = getRequestMetricsFields(metrics);
    expect(fields.gmailDeferredCalls).toBe(1);
    expect(fields.waitMs).toBeGreaterThan(0);
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

  it("holds sync and background back for a whole assistant turn until it ends", async () => {
    const admissions: Array<{ at: number; priority: string; cost: number }> =
      [];
    const admit = (priority: "sync" | "background", cost: number) =>
      runWithGmailQuota({ caller: `test/${priority}`, priority }, () =>
        meterGmailCall({ emailAccountId: TURN_ACCOUNT, cost }, async () => {
          admissions.push({ at: Date.now(), priority, cost });
        }),
      );
    const start = Date.now();
    const release = await holdGmailInteractiveDemand(TURN_ACCOUNT, 45_000);

    let stop = false;
    const scan = (async () => {
      while (!stop) await admit("sync", 20);
    })();
    // Well past a single large request's two seconds.
    await vi.advanceTimersByTimeAsync(8000);
    // Background is told to come back after the turn rather than waiting.
    await expect(admit("background", 20)).rejects.toBeInstanceOf(
      GmailCallDeferredError,
    );
    // Sync still brings new mail in, at the yielding pace.
    const syncDuringTurn = admissions
      .filter((entry) => entry.at >= start + 5000 && entry.at < start + 6000)
      .reduce((sum, entry) => sum + entry.cost, 0);
    expect(syncDuringTurn).toBeGreaterThan(0);
    expect(syncDuringTurn).toBeLessThanOrEqual(120);

    await release();
    let insight = false;
    admit("background", 20).then(() => {
      insight = true;
    });
    await vi.advanceTimersByTimeAsync(2000);
    stop = true;
    await vi.advanceTimersByTimeAsync(1000);
    await scan;
    expect(insight).toBe(true);
  });

  it("admits a turn's first search at once when the turn held demand while its model ran", async () => {
    const searchWaitMs = async (
      account: string,
      holdFromTurnStart: boolean,
    ) => {
      let stop = false;
      const scan = (async () => {
        while (!stop)
          await runWithGmailQuota(
            { caller: "mail/v1/enumeration", priority: "sync" },
            () =>
              meterGmailCall(
                { emailAccountId: account, cost: 20 },
                async () => {},
              ),
          );
      })();
      await vi.advanceTimersByTimeAsync(1000);
      const release = holdFromTurnStart
        ? await holdGmailInteractiveDemand(account, 45_000)
        : async () => {};
      // The model's first step, which picks the search.
      await vi.advanceTimersByTimeAsync(1500);
      const stats = createGmailQuotaStats();
      const search = runWithGmailQuota(
        { caller: "chat/searchInbox", priority: "interactive", stats },
        () =>
          meterGmailCall(
            { emailAccountId: account, cost: 500 },
            async () => {},
          ),
      );
      await vi.advanceTimersByTimeAsync(3000);
      await search;
      stop = true;
      await release();
      await vi.advanceTimersByTimeAsync(1000);
      await scan;
      return stats.waitMs;
    };

    // Sync fills each second, so the search waits for room in it.
    expect(await searchWaitMs(UNHELD_SEARCH_ACCOUNT, false)).toBeGreaterThan(0);
    expect(await searchWaitMs(HELD_SEARCH_ACCOUNT, true)).toBe(0);
  });

  it("gives sync its gap after a turn ends before a person's next yield", async () => {
    const admissions: Array<{ at: number; priority: string; cost: number }> =
      [];
    const admit = (priority: "sync" | "interactive", cost: number) =>
      runWithGmailQuota({ caller: `test/${priority}`, priority }, () =>
        meterGmailCall({ emailAccountId: TURN_GAP_ACCOUNT, cost }, async () => {
          admissions.push({ at: Date.now(), priority, cost });
        }),
      );
    const release = await holdGmailInteractiveDemand(TURN_GAP_ACCOUNT, 45_000);
    await vi.advanceTimersByTimeAsync(5000);
    await release();

    // The assistant's next large read comes the moment the turn ends.
    const endedAt = Date.now();
    await admit("interactive", 340);
    let stop = false;
    const scan = (async () => {
      while (!stop) await admit("sync", 20);
    })();
    await vi.advanceTimersByTimeAsync(1100);
    stop = true;
    await vi.advanceTimersByTimeAsync(1000);
    await scan;

    // Sync gets its full share back for a moment, as between two requests.
    const syncUnits = admissions
      .filter(
        (entry) =>
          entry.priority === "sync" &&
          entry.at >= endedAt &&
          entry.at < endedAt + 1000,
      )
      .reduce((sum, entry) => sum + entry.cost, 0);
    expect(syncUnits).toBeGreaterThan(120);
  });

  it("starts no yield for a request that gives up before the bucket refills", async () => {
    const admissions: Array<{ priority: string; cost: number }> = [];
    const admit = (
      priority: "sync" | "interactive",
      cost: number,
      maxTotalWaitMs?: number,
    ) =>
      runWithGmailQuota(
        { caller: `test/${priority}`, priority, maxTotalWaitMs },
        () =>
          meterGmailCall(
            { emailAccountId: GIVE_UP_ACCOUNT, cost },
            async () => {
              admissions.push({ priority, cost });
            },
          ),
      );
    // The bucket is mostly spent, and that request's own yield is long over.
    await admit("interactive", 1500);
    await vi.advanceTimersByTimeAsync(3100);

    // A person's batch that won't wait for the refill it needs.
    await expect(admit("interactive", 1500, 100)).rejects.toBeInstanceOf(
      GmailCallDeferredError,
    );
    // Sync spends what the bucket has rather than yielding to nobody.
    let stop = false;
    const scan = (async () => {
      while (!stop) await admit("sync", 20);
    })();
    await vi.advanceTimersByTimeAsync(1000);
    stop = true;
    const syncUnits = admissions
      .filter((entry) => entry.priority === "sync")
      .reduce((sum, entry) => sum + entry.cost, 0);
    await vi.advanceTimersByTimeAsync(2000);
    await scan;
    expect(syncUnits).toBeGreaterThan(120);
  });

  it("defers a person's call rather than wait past their request's deadline", async () => {
    const admit = (emailAccountId: string, cost: number) =>
      runWithGmailQuota(
        { caller: "test/interactive", priority: "interactive" },
        () => meterGmailCall({ emailAccountId, cost }, async () => "ok"),
      );
    // Late in a 30s request, with the bucket spent down to what it can give.
    const lateCall = (emailAccountId: string) => async () => {
      await sleep(19_500);
      await admit(emailAccountId, 800);
      return admit(emailAccountId, 600);
    };

    const withinDeadline = runWithRequestDeadline(
      30,
      lateCall(DEADLINE_ACCOUNT),
    ).catch((error: unknown) => error);
    const withoutDeadline = lateCall(NO_DEADLINE_ACCOUNT)();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await withinDeadline).toBeInstanceOf(GmailCallDeferredError);
    await expect(withoutDeadline).resolves.toBe("ok");
  });

  describe("deferral log line", () => {
    // Late in a 30s request the bucket cannot pay, so the call is deferred.
    const deferLate = async (
      emailAccountId: string,
      caller: string,
      priority: "interactive" | "background",
      requestId: string,
    ) => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const admit = (cost: number) =>
        runWithGmailQuota({ caller, priority }, () =>
          meterGmailCall({ emailAccountId, cost }, async () => "ok"),
        );
      const outcome = runWithAuditContext(
        { actorType: "anonymous", requestId, source: caller },
        () =>
          runWithRequestDeadline(30, async () => {
            await sleep(19_500);
            await admit(800);
            return admit(600);
          }),
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await outcome).toBeInstanceOf(GmailCallDeferredError);
      return logSpy.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes("Gmail call deferred"));
    };

    it("ships every deferral of a route a person is waiting on, with numbers and ids only", async () => {
      const requestId = Array.from(
        { length: 200 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      ).find((id) => !isFastRequestSampled(id, 0.08)) as string;

      const lines = await deferLate(
        "account-defer-log-interactive",
        "user/thread-context",
        "interactive",
        requestId,
      );

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"route": "user/thread-context"');
      expect(lines[0]).toContain('"priority": "interactive"');
      expect(lines[0]).toMatch(/"waitMs": \d+/);
      expect(lines[0]).not.toMatch(/@|subject|"from"|"to"/);
    });

    it("keeps a background route's deferral at trace unless its request is sampled", async () => {
      const requestId = Array.from(
        { length: 200 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      ).find((id) => !isFastRequestSampled(id, 0.08)) as string;

      const lines = await deferLate(
        "account-defer-log-background",
        "automation-jobs/execute",
        "background",
        requestId,
      );

      expect(lines).toHaveLength(0);
    });
  });

  it("lets go of a turn that never ends once its cap runs out", async () => {
    await holdGmailInteractiveDemand(STUCK_TURN_ACCOUNT, 3000);
    let insight = false;
    // Within its 15-second wait, background sits the hold out.
    runWithGmailQuota(
      { caller: "test/background", priority: "background" },
      () =>
        meterGmailCall(
          { emailAccountId: STUCK_TURN_ACCOUNT, cost: 20 },
          async () => {
            insight = true;
          },
        ),
    );

    await vi.advanceTimersByTimeAsync(2500);
    expect(insight).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(insight).toBe(true);
  });

  describe("store round trips", () => {
    it("lets the engine's backfill back in once another instance clears the first-sync marker, however long the bucket's wait", async () => {
      const account = "account-deferral-shared";
      // A person's reads overdraw the bucket, so the backfill's wait is the
      // bucket's, longer than the marker's five-second retry.
      await drainBucket(account);
      await gmailQuotaStore.block({
        key: `gmail-quota:${account}:initial-sync`,
        ms: 90_000,
      });
      const take = vi.spyOn(gmailQuotaStore, "take");
      const backfill = () =>
        runWithGmailQuota(
          { caller: "mail/v1/enumeration", priority: "background" },
          () =>
            meterGmailCall(
              { emailAccountId: account, cost: 100 },
              async () => "page",
            ),
        );
      const first = await backfill().catch((error: unknown) => error);
      expect(first).toBeInstanceOf(GmailCallDeferredError);
      expect((first as GmailCallDeferredError).retryAfterMs).toBeGreaterThan(
        5000,
      );

      // Another instance's scan ends.
      await gmailQuotaStore.clear(`gmail-quota:${account}:initial-sync`);
      await vi.advanceTimersByTimeAsync(1000);
      const takesBefore = take.mock.calls.length;
      const second = backfill().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(second).resolves.toBe("page");
      expect(take.mock.calls.length).toBeGreaterThan(takesBefore);
    });

    it("shares a wait the pace set for half a second, then asks the store again", async () => {
      const account = "account-pace-share";
      const take = vi.spyOn(gmailQuotaStore, "take");
      const sync = () =>
        runWithGmailQuota(
          { caller: "mail/v1/enumeration", priority: "sync" },
          () =>
            meterGmailCall(
              { emailAccountId: account, cost: 500 },
              async () => "batch",
            ),
        );
      // A full second's pace: the admission says the next would wait for it.
      await expect(sync()).resolves.toBe("batch");
      expect(take).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100);
      const shared = sync();
      await vi.advanceTimersByTimeAsync(0);
      expect(take).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(shared).resolves.toBe("batch");

      const asks = take.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600);
      const lapsed = sync();
      await vi.advanceTimersByTimeAsync(0);
      expect(take.mock.calls.length).toBe(asks + 1);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(lapsed).resolves.toBe("batch");
    });

    it("shares a wait the bucket set past half a second, as it cannot end sooner", async () => {
      const account = "account-bucket-share";
      await drainBucket(account);
      const take = vi.spyOn(gmailQuotaStore, "take");
      const sync = () =>
        runWithGmailQuota(
          { caller: "mail/v1/enumeration", priority: "sync" },
          () =>
            meterGmailCall(
              { emailAccountId: account, cost: 100 },
              async () => "batch",
            ),
        );
      const first = sync();
      await vi.advanceTimersByTimeAsync(0);
      expect(take).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000);
      const second = sync();
      await vi.advanceTimersByTimeAsync(0);
      expect(take).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(Promise.all([first, second])).resolves.toEqual([
        "batch",
        "batch",
      ]);
    });

    it("admits a person's reads that arrive together in one store round trip", async () => {
      const take = vi.spyOn(gmailQuotaStore, "take");
      const reads = Array.from({ length: 5 }, () =>
        interactive("account-fan-out", async () => "message"),
      );
      await vi.advanceTimersByTimeAsync(0);

      await expect(Promise.all(reads)).resolves.toHaveLength(5);
      expect(take).toHaveBeenCalledTimes(1);
    });

    it("serves a steady stream of small reads with a fraction of the store round trips, all counted", async () => {
      vi.setSystemTime(new Date("2026-10-14T15:00:00Z"));
      const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const take = vi.spyOn(gmailQuotaStore, "take");
      let reads = 0;
      // A sync reading one small message every 100 ms.
      for (let read = 0; read < 100; read++) {
        await runWithGmailQuota(
          { caller: "mail/v1/enumeration", priority: "sync" },
          () =>
            meterGmailCall(
              { emailAccountId: "account-stream", cost: 5 },
              async () => {
                reads++;
              },
            ),
        );
        await vi.advanceTimersByTimeAsync(100);
      }

      expect(reads).toBe(100);
      expect(take.mock.calls.length).toBeLessThanOrEqual(30);
      // Every unit read is still in the minute's usage summary.
      await vi.advanceTimersByTimeAsync(60_000);
      await logGmailQuotaUsage();
      const totals = info.mock.calls
        .map(([line]) => String(line))
        .filter(
          (line) =>
            line.includes("Gmail quota usage") &&
            line.includes("account-stream"),
        )
        .map((line) => JSON.parse(line.slice(line.indexOf("{"))).totalUnits);
      expect(totals.reduce((sum, units) => sum + units, 0)).toBe(500);
    });

    it("keeps a second within its cap when units reserved ahead are spent late", async () => {
      const admissions: Array<{ at: number; cost: number }> = [];
      const admit = (priority: "sync" | "interactive", cost: number) =>
        runWithGmailQuota({ caller: `test/${priority}`, priority }, () =>
          meterGmailCall(
            { emailAccountId: "account-ahead", cost },
            async () => {
              admissions.push({ at: Date.now(), cost });
            },
          ),
        );
      let stop = false;
      // A steady sync, well under its cap, holds units reserved ahead...
      const sync = (async () => {
        while (!stop) {
          await admit("sync", 5);
          await sleep(100);
        }
      })();
      await vi.advanceTimersByTimeAsync(1500);
      // ...while a person's reads take everything else the second has.
      const reads = (async () => {
        while (!stop) {
          await admit("interactive", 20);
          await sleep(50);
        }
      })();
      await vi.advanceTimersByTimeAsync(1000);
      stop = true;
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.all([sync, reads]);

      const peakSecond = Math.max(
        ...admissions.map(({ at }) =>
          admissions
            .filter((entry) => entry.at >= at && entry.at < at + 1000)
            .reduce((sum, entry) => sum + entry.cost, 0),
        ),
      );
      expect(peakSecond).toBeLessThanOrEqual(GATE_UNITS_PER_SECOND);
    });

    it("stops admitting from what this instance reserved ahead once Gmail refuses", async () => {
      const read = (operation: () => Promise<unknown> = async () => "x") =>
        runWithGmailQuota(
          {
            caller: "mail/v1/enumeration",
            priority: "sync",
            maxTotalWaitMs: 1000,
          },
          () =>
            meterGmailCall(
              { emailAccountId: "account-lease-refused", cost: 5 },
              operation,
            ),
        );
      // A steady stream, so the lane holds units reserved ahead.
      for (let call = 0; call < 5; call++) {
        await read();
        await vi.advanceTimersByTimeAsync(150);
      }
      await expect(
        read(async () => {
          throw quotaRefusal;
        }),
      ).rejects.toBe(quotaRefusal);

      // Sync stands back after a refusal, whatever this instance held.
      await expect(read()).rejects.toBeInstanceOf(GmailCallDeferredError);
    });

    it("doesn't hold a person's large request behind what lanes reserved ahead", async () => {
      let lastRead = 0;
      let stop = false;
      const stream = (priority: "sync" | "interactive") =>
        (async () => {
          while (!stop) {
            await runWithGmailQuota(
              { caller: `test/${priority}`, priority },
              () =>
                meterGmailCall(
                  { emailAccountId: "account-large-after-lease", cost: 5 },
                  async () => {
                    lastRead = Date.now();
                  },
                ),
            );
            await sleep(150);
          }
        })();
      const streams = [stream("sync"), stream("interactive")];
      await vi.advanceTimersByTimeAsync(3000);
      stop = true;
      await vi.advanceTimersByTimeAsync(150);
      await Promise.all(streams);

      // A first inbox page needs a second to itself.
      let pageAt: number | null = null;
      interactive(
        "account-large-after-lease",
        async () => {
          pageAt = Date.now();
        },
        505,
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(pageAt).not.toBeNull();
      // It waits only for what was really sent to age out of the second.
      expect(pageAt! - lastRead).toBeLessThanOrEqual(1050);
    });

    it("writes what it counted when a request ends, so a short-lived instance loses nothing", async () => {
      vi.setSystemTime(new Date("2026-10-14T17:00:10Z"));
      const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await setGmailInitialSync("account-short-lived", true);
      const insight = () =>
        expect(
          runWithGmailQuota(
            { caller: "user/inbox-insights", priority: "background" },
            () =>
              meterGmailCall(
                { emailAccountId: "account-short-lived", cost: 20 },
                async () => "insight",
              ),
          ),
        ).rejects.toBeInstanceOf(GmailCallDeferredError);
      // Two requests end within the minute; the instance ends with the second.
      await insight();
      await logGmailQuotaUsage();
      await vi.advanceTimersByTimeAsync(600);
      await insight();
      await logGmailQuotaUsage();
      resetGmailQuotaInstanceState();

      // The next instance to meter the account reports the minute.
      await vi.advanceTimersByTimeAsync(60_000);
      await interactive("account-short-lived", async () => "thread");
      await logGmailQuotaUsage();
      const summary = info.mock.calls
        .map(([line]) => String(line))
        .find(
          (line) =>
            line.includes("Gmail quota usage") &&
            line.includes("account-short-lived"),
        );
      expect(JSON.parse(summary!.slice(summary!.indexOf("{")))).toMatchObject({
        deferredByCaller: [{ caller: "user/inbox-insights", calls: 2 }],
      });
    });

    it("writes a count made after another request already summarized the account", async () => {
      vi.setSystemTime(new Date("2026-10-14T19:00:59.500Z"));
      const account = "account-late-count";
      const background = (cost: number) =>
        runWithGmailQuota(
          { caller: "user/inbox-insights", priority: "background" },
          () =>
            meterGmailCall({ emailAccountId: account, cost }, async () => "x"),
        );
      // Background's second is full, so the next call waits on the pace...
      await background(250);
      const waiting = expect(background(20)).rejects.toBeInstanceOf(
        GmailCallDeferredError,
      );
      await vi.advanceTimersByTimeAsync(600);
      // ...while another request ends in the next minute and summarizes it,
      await logGmailQuotaUsage();
      // and a first sync starts, so the waiting call is deferred when it wakes.
      await setGmailInitialSync(account, true);
      await vi.advanceTimersByTimeAsync(1000);
      await waiting;

      const note = vi.spyOn(gmailQuotaStore, "note");
      // The waiting call's own request ends, and the instance with it.
      await logGmailQuotaUsage();
      expect(note.mock.calls.flatMap(([notes]) => notes)).toContainEqual(
        expect.objectContaining({
          field: "deferred:user/inbox-insights",
          amount: 1,
        }),
      );
    });

    it("lets every caller waiting on a shared round trip through when the store refuses it", async () => {
      vi.setSystemTime(new Date("2026-10-14T18:00:10Z"));
      const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const take = vi
        .spyOn(gmailQuotaStore, "take")
        .mockRejectedValueOnce(new Error("Redis unavailable"));
      const reads = Array.from({ length: 3 }, () =>
        interactive("account-shared-failure", async () => "message"),
      );
      await vi.advanceTimersByTimeAsync(0);

      await expect(Promise.all(reads)).resolves.toEqual([
        "message",
        "message",
        "message",
      ]);
      expect(take).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await logGmailQuotaUsage();
      const summary = info.mock.calls
        .map(([line]) => String(line))
        .find(
          (line) =>
            line.includes("Gmail quota usage") &&
            line.includes("account-shared-failure"),
        );
      expect(JSON.parse(summary!.slice(summary!.indexOf("{")))).toMatchObject({
        storeUnavailableCalls: 3,
      });
    });

    it("doesn't count a note twice when the round trip carrying it times out", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await setGmailInitialSync("account-note-timeout", true);
      const insight = () =>
        runWithGmailQuota(
          { caller: "user/inbox-insights", priority: "background" },
          () =>
            meterGmailCall(
              { emailAccountId: "account-note-timeout", cost: 20 },
              async () => "insight",
            ),
        );
      await expect(insight()).rejects.toBeInstanceOf(GmailCallDeferredError);
      // The next round trip carries the deferral's note, and never answers:
      // a slow store may still write it, so it is not queued again.
      const take = vi.spyOn(gmailQuotaStore, "take");
      take.mockReturnValueOnce(new Promise(() => undefined));
      await vi.advanceTimersByTimeAsync(600);
      const call = insight();
      await vi.advanceTimersByTimeAsync(300);
      await call;
      expect(take.mock.calls[0]?.[0].notes).toEqual([
        { field: "deferred:user/inbox-insights", amount: 1 },
      ]);

      const claim = vi.spyOn(gmailQuotaStore, "claimUsages");
      const note = vi.spyOn(gmailQuotaStore, "note");
      await logGmailQuotaUsage();
      const written = [
        ...claim.mock.calls.flatMap(([, notes]) => notes ?? []),
        ...note.mock.calls.flatMap(([notes]) => notes),
      ];
      expect(written.map(({ field }) => field)).not.toContain(
        "deferred:user/inbox-insights",
      );
    });

    it("records deferrals without a store write for each one", async () => {
      vi.setSystemTime(new Date("2026-10-14T16:00:10Z"));
      const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await setGmailInitialSync("account-deferrals", true);
      const take = vi.spyOn(gmailQuotaStore, "take");
      const note = vi.spyOn(gmailQuotaStore, "note");

      for (let call = 0; call < 10; call++)
        await expect(
          runWithGmailQuota(
            { caller: "user/inbox-insights", priority: "background" },
            () =>
              meterGmailCall(
                { emailAccountId: "account-deferrals", cost: 20 },
                async () => "insight",
              ),
          ),
        ).rejects.toBeInstanceOf(GmailCallDeferredError);

      expect(take).toHaveBeenCalledTimes(1);
      expect(note).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      await logGmailQuotaUsage();
      const summary = info.mock.calls
        .map(([line]) => String(line))
        .find(
          (line) =>
            line.includes("Gmail quota usage") &&
            line.includes("account-deferrals"),
        );
      expect(JSON.parse(summary!.slice(summary!.indexOf("{")))).toMatchObject({
        deferredByCaller: [{ caller: "user/inbox-insights", calls: 10 }],
      });
    });

    it("logs how often the gate asked its store, every five minutes per instance", async () => {
      vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
      const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await logGmailQuotaUsage();
      const reads = Array.from({ length: 4 }, () =>
        interactive("account-gate-summary", async () => "message"),
      );
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all(reads);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await logGmailQuotaUsage();
      const summaries = info.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("Gmail quota gate"))
        .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
      expect(summaries.at(-1)).toMatchObject({
        calls: 4,
        storeTakes: 1,
      });
    });
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

// A person's reads overdraw the account's bucket well below sync's floor.
async function drainBucket(emailAccountId: string) {
  const reads = Promise.all(
    [1, 2, 3, 4].map(() =>
      interactive(emailAccountId, async () => "read", 650),
    ),
  );
  await vi.advanceTimersByTimeAsync(4000);
  await reads;
}

function interactive<T>(
  emailAccountId: string,
  operation: () => Promise<T>,
  cost = 20,
) {
  return runWithGmailQuota(
    { caller: "test/interactive", priority: "interactive" },
    () => meterGmailCall({ emailAccountId, cost }, operation),
  );
}

function refusal(status: number, message: string) {
  return { status, errors: [{ reason: "rateLimitExceeded" }], message };
}
