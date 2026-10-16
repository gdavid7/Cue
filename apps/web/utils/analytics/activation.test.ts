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
import {
  ACTIVATION_EVENTS,
  logFirstSignIn,
  recordActiveDay,
  recordFirstSuggestedReplySent,
  recordNeedsReplyFirstItem,
} from "@/utils/analytics/activation";
import { redis } from "@/utils/redis";

vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({ redis: { set: vi.fn() } }));

const SIGNED_IN_AT = new Date("2026-10-16T09:00:00.000Z");
const NOW = new Date("2026-10-16T09:04:00.000Z");

describe("activation events", () => {
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: NOW });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(redis.set).mockResolvedValue("OK");
    prisma.emailAccount.findUnique.mockResolvedValue({
      createdAt: SIGNED_IN_AT,
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    logSpy.mockRestore();
  });

  it("logs a mailbox's first sign-in with only its id and the time", () => {
    logFirstSignIn("account-1");

    expect(loggedEvents()).toEqual([
      {
        event: ACTIVATION_EVENTS.firstSignIn,
        fields: { emailAccountId: "account-1", at: NOW.toISOString() },
      },
    ]);
  });

  it("logs the first Needs reply item with the time since first sign-in", async () => {
    await recordNeedsReplyFirstItem("account-1");

    expect(loggedEvents()).toEqual([
      {
        event: ACTIVATION_EVENTS.needsReplyFirstItem,
        fields: {
          emailAccountId: "account-1",
          at: NOW.toISOString(),
          firstSignInAt: SIGNED_IN_AT.toISOString(),
          msSinceFirstSignIn: 4 * 60 * 1000,
        },
      },
    ]);
  });

  it.each([
    ["needs reply", recordNeedsReplyFirstItem],
    ["suggested reply", recordFirstSuggestedReplySent],
  ])("logs the first %s event only once per mailbox", async (_, record) => {
    await record("account-once");
    vi.mocked(redis.set).mockResolvedValue(null);
    await record("account-once");
    await record("account-once");

    expect(loggedEvents()).toHaveLength(1);
    const keys = vi.mocked(redis.set).mock.calls.map(([key]) => key);
    expect(new Set(keys).size).toBe(1);
    expect(vi.mocked(redis.set).mock.calls[0]?.[2]).toEqual({ nx: true });
  });

  it("skips the event when another instance already logged it", async () => {
    vi.mocked(redis.set).mockResolvedValue(null);

    await recordFirstSuggestedReplySent("account-elsewhere");

    expect(loggedEvents()).toEqual([]);
  });

  it("logs the first suggested reply sent with only its id and the time", async () => {
    await recordFirstSuggestedReplySent("account-2");

    expect(loggedEvents()).toEqual([
      {
        event: ACTIVATION_EVENTS.firstSuggestedReplySent,
        fields: { emailAccountId: "account-2", at: NOW.toISOString() },
      },
    ]);
  });

  it("logs an active day at most once per mailbox per UTC day", async () => {
    await recordActiveDay("account-3");
    vi.mocked(redis.set).mockResolvedValue(null);
    await recordActiveDay("account-3");
    vi.mocked(redis.set).mockResolvedValue("OK");
    vi.setSystemTime(new Date("2026-10-17T00:30:00.000Z"));
    await recordActiveDay("account-3");

    expect(loggedEvents()).toEqual([
      {
        event: ACTIVATION_EVENTS.activeDay,
        fields: {
          emailAccountId: "account-3",
          at: NOW.toISOString(),
          day: "2026-10-16",
        },
      },
      {
        event: ACTIVATION_EVENTS.activeDay,
        fields: {
          emailAccountId: "account-3",
          at: "2026-10-17T00:30:00.000Z",
          day: "2026-10-17",
        },
      },
    ]);
    // Day keys expire, so they never pile up in Redis.
    for (const [, , options] of vi.mocked(redis.set).mock.calls) {
      expect(options).toEqual({ nx: true, ex: expect.any(Number) });
    }
  });

  it("never throws into the caller when Redis is down", async () => {
    vi.mocked(redis.set).mockRejectedValue(new Error("redis down"));

    await expect(recordActiveDay("account-4")).resolves.toBeUndefined();
    await expect(
      recordNeedsReplyFirstItem("account-4"),
    ).resolves.toBeUndefined();
    expect(loggedEvents()).toEqual([]);
  });

  function loggedEvents() {
    return logSpy.mock.calls.flatMap(([line]: unknown[]) => {
      const match = String(line).match(
        /^\[product\]: (activation\.\S+) ([\s\S]*)$/,
      );
      if (!match) return [];
      return [{ event: match[1], fields: JSON.parse(match[2]) }];
    });
  }
});
