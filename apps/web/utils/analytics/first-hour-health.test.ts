import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { ACTIVATION_EVENTS } from "@/utils/analytics/activation";
import {
  FIRST_HOUR_HEALTH_MAX_PER_RUN,
  recordFirstHourHealthForNewMailboxes,
} from "@/utils/analytics/first-hour-health";
import { ErrorType, watchLapsedErrorKey } from "@/utils/error-messages";
import { createScopedLogger } from "@/utils/logger";
import { redis } from "@/utils/redis";

vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({
  redis: { set: vi.fn(), del: vi.fn(), mget: vi.fn() },
}));
vi.mock("@inboxzero/transactional-email", () => ({}));

const NOW = new Date("2026-10-17T12:00:00.000Z");
const SIGNED_IN_AT = new Date("2026-10-17T10:45:00.000Z");
const logger = createScopedLogger("test");

describe("recordFirstHourHealthForNewMailboxes", () => {
  let logSpy: MockInstance<typeof console.log>;
  let claimedKeys: Set<string>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: NOW });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    claimedKeys = new Set();
    vi.mocked(redis.set).mockImplementation((async (key: string) => {
      if (claimedKeys.has(key)) return null;
      claimedKeys.add(key);
      return "OK";
    }) as never);
    vi.mocked(redis.mget).mockImplementation((async (...keys: string[]) =>
      keys.map((key) => (claimedKeys.has(key) ? "1" : null))) as never);
    vi.mocked(redis.del).mockImplementation((async (key: string) => {
      claimedKeys.delete(key);
      return 1;
    }) as never);
    prisma.rule.findMany.mockResolvedValue([]);
    vi.mocked(prisma.executedRule.groupBy).mockResolvedValue([] as never);
    prisma.executedRule.count.mockResolvedValue(0);
    vi.mocked(prisma.threadTracker.groupBy).mockResolvedValue([] as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    logSpy.mockRestore();
  });

  it("selects mailboxes whose first sign-in was 60 minutes to 26 hours ago", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([]);

    await recordFirstHourHealthForNewMailboxes(logger);

    const { where } = prisma.emailAccount.findMany.mock.calls[0][0] as {
      where: { createdAt: { gt: Date; lte: Date } };
    };
    expect(where.createdAt.gt).toEqual(new Date("2026-10-16T10:00:00.000Z"));
    expect(where.createdAt.lte).toEqual(new Date("2026-10-17T11:00:00.000Z"));
  });

  it("covers every mailbox exactly once with a jittered daily tick", async () => {
    const signUps = Array.from({ length: 4 * 24 * 4 }, (_, i) =>
      mailbox(`account-${i}`, {
        createdAt: new Date(
          Date.parse("2026-10-14T00:00:00.000Z") + i * 15 * 60_000,
        ),
      }),
    );
    prisma.emailAccount.findMany.mockImplementation((async (args: {
      where: { createdAt: { gt: Date; lte: Date } };
    }) =>
      signUps.filter(
        (m) =>
          m.createdAt > args.where.createdAt.gt &&
          m.createdAt <= args.where.createdAt.lte,
      )) as never);

    // Vercel runs a daily cron anywhere in its hour, so gaps run 23h to 25h.
    const ticks = [
      "2026-10-15T00:00:00.000Z",
      "2026-10-16T00:59:00.000Z",
      "2026-10-17T00:00:00.000Z",
      "2026-10-18T00:59:00.000Z",
      "2026-10-19T00:30:00.000Z",
    ];
    for (const tick of ticks) {
      vi.setSystemTime(new Date(tick));
      await recordFirstHourHealthForNewMailboxes(logger);
    }

    const coveredFrom = Date.parse(ticks[0]) - 26 * 60 * 60_000;
    const coveredUntil = Date.parse(ticks[ticks.length - 1]) - 60 * 60_000;
    const expected = signUps
      .filter(
        (m) =>
          m.createdAt.getTime() > coveredFrom &&
          m.createdAt.getTime() <= coveredUntil,
      )
      .map((m) => m.id);
    const logged = loggedEvents().map((event) => event.emailAccountId);
    expect(logged).toHaveLength(new Set(logged).size);
    expect([...logged].sort()).toEqual([...expected].sort());
    expect(logged.length).toBeGreaterThan(300);
  });

  it("logs aggregate counts and states only, with no addresses or content", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      mailbox("account-1", {
        watchEmailsExpirationDate: new Date("2026-10-17T11:30:00.000Z"),
        lastSyncedHistoryId: null,
        account: { provider: "google", disconnectedAt: SIGNED_IN_AT },
        user: {
          errorMessages: {
            [ErrorType.ACCOUNT_DISCONNECTED]: {
              message: "Reconnect jane@example.com",
              timestamp: NOW.toISOString(),
            },
            [watchLapsedErrorKey("account-1")]: {
              message: "Email automation stopped for jane@example.com",
              timestamp: NOW.toISOString(),
            },
            [watchLapsedErrorKey("other-account")]: {
              message: "Email automation stopped for other@example.com",
              timestamp: NOW.toISOString(),
            },
          },
        },
      }),
    ] as never);
    prisma.rule.findMany.mockResolvedValue([
      { systemType: "TO_REPLY" },
      { systemType: "NEWSLETTER" },
      { systemType: null },
    ] as never);
    vi.mocked(prisma.executedRule.groupBy).mockResolvedValue([
      {
        status: "APPLIED",
        _count: { _all: 7 },
        _max: { createdAt: new Date("2026-10-17T11:50:00.000Z") },
      },
      {
        status: "SKIPPED",
        _count: { _all: 4 },
        _max: { createdAt: new Date("2026-10-17T11:20:00.000Z") },
      },
      {
        status: "ERROR",
        _count: { _all: 1 },
        _max: { createdAt: new Date("2026-10-17T11:00:00.000Z") },
      },
    ] as never);
    prisma.executedRule.count.mockResolvedValue(3);
    vi.mocked(prisma.threadTracker.groupBy).mockResolvedValue([
      { type: "NEEDS_REPLY", _count: { _all: 5 } },
      { type: "AWAITING", _count: { _all: 2 } },
    ] as never);

    await recordFirstHourHealthForNewMailboxes(logger);

    expect(loggedEvents()).toEqual([
      {
        emailAccountId: "account-1",
        at: NOW.toISOString(),
        firstSignInAt: SIGNED_IN_AT.toISOString(),
        minutesSinceFirstSignIn: 75,
        provider: "google",
        enabledRuleCount: 3,
        enabledSystemRuleCount: 2,
        replyTrackingEnabled: true,
        rulesApplied: 7,
        rulesApplying: 0,
        rulesSkipped: 4,
        rulesSkippedNoMatch: 3,
        rulesErrored: 1,
        minutesSinceLastRuleRun: 10,
        needsReplyCount: 5,
        awaitingReplyCount: 2,
        accountDisconnected: true,
        watchStatus: "expired",
        hasSyncCursor: false,
        errorTypes: [
          ErrorType.ACCOUNT_DISCONNECTED,
          ErrorType.EMAIL_WATCH_LAPSED,
        ],
      },
    ]);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain("@example.com");
  });

  it("doesn't count mail Cue failed to process as a rule run", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      mailbox("account-1"),
    ] as never);
    vi.mocked(prisma.executedRule.groupBy).mockResolvedValue([
      {
        status: "ERROR",
        _count: { _all: 2 },
        _max: { createdAt: new Date("2026-10-17T11:55:00.000Z") },
      },
    ] as never);

    await recordFirstHourHealthForNewMailboxes(logger);

    expect(loggedEvents()).toEqual([
      expect.objectContaining({
        rulesErrored: 2,
        minutesSinceLastRuleRun: null,
      }),
    ]);
  });

  it("reports a missing watch and no rule runs for a mailbox that never set up", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      mailbox("account-1"),
    ] as never);

    await recordFirstHourHealthForNewMailboxes(logger);

    expect(loggedEvents()).toEqual([
      expect.objectContaining({
        enabledRuleCount: 0,
        replyTrackingEnabled: false,
        rulesApplied: 0,
        minutesSinceLastRuleRun: null,
        watchStatus: "missing",
        accountDisconnected: false,
        errorTypes: [],
      }),
    ]);
  });

  it("logs each mailbox once across overlapping runs", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      mailbox("account-1"),
      mailbox("account-2"),
    ] as never);

    await recordFirstHourHealthForNewMailboxes(logger);
    const second = await recordFirstHourHealthForNewMailboxes(logger);

    expect(loggedEvents().map((event) => event.emailAccountId)).toEqual([
      "account-1",
      "account-2",
    ]);
    expect(second).toEqual({ candidates: 2, unsent: 0, sent: 0, failed: 0 });
    // Already-sent mailboxes cost no health queries.
    expect(prisma.rule.findMany).toHaveBeenCalledTimes(2);
  });

  it("sends at most the per-run cap and leaves the rest for the next run", async () => {
    const total = FIRST_HOUR_HEALTH_MAX_PER_RUN + 5;
    prisma.emailAccount.findMany.mockResolvedValue(
      Array.from({ length: total }, (_, i) => mailbox(`account-${i}`)) as never,
    );

    const first = await recordFirstHourHealthForNewMailboxes(logger);
    expect(first.sent).toBe(FIRST_HOUR_HEALTH_MAX_PER_RUN);
    expect(loggedEvents()).toHaveLength(FIRST_HOUR_HEALTH_MAX_PER_RUN);

    const second = await recordFirstHourHealthForNewMailboxes(logger);
    expect(second.sent).toBe(5);
    expect(new Set(loggedEvents().map((e) => e.emailAccountId)).size).toBe(
      total,
    );
  });

  it("releases the claim when the snapshot fails so a later run retries", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      mailbox("account-1"),
    ] as never);
    vi.mocked(prisma.threadTracker.groupBy).mockRejectedValueOnce(
      new Error("db down"),
    );

    const first = await recordFirstHourHealthForNewMailboxes(logger);
    expect(first).toEqual({ candidates: 1, unsent: 1, sent: 0, failed: 1 });
    expect(loggedEvents()).toEqual([]);

    await recordFirstHourHealthForNewMailboxes(logger);
    expect(loggedEvents()).toHaveLength(1);
  });

  function loggedEvents(): Record<string, unknown>[] {
    return logSpy.mock.calls.flatMap(([line]: unknown[]) => {
      const match = String(line).match(/^\[product\]: (\S+) ([\s\S]*)$/);
      if (!match || match[1] !== ACTIVATION_EVENTS.firstHourHealth) return [];
      return [JSON.parse(match[2])];
    });
  }
});

function mailbox(
  id: string,
  overrides: Partial<{
    createdAt: Date;
    watchEmailsExpirationDate: Date | null;
    lastSyncedHistoryId: string | null;
    account: { provider: string; disconnectedAt: Date | null };
    user: { errorMessages: unknown };
  }> = {},
) {
  return {
    id,
    createdAt: SIGNED_IN_AT,
    watchEmailsExpirationDate: null,
    lastSyncedHistoryId: "123",
    account: { provider: "google", disconnectedAt: null },
    user: { errorMessages: null },
    ...overrides,
  };
}
