import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { getNextUp } from "@/utils/home/next-up";
import prisma from "@/utils/__mocks__/prisma";
import { redis } from "@/utils/redis";
import { searchCanvas } from "@/utils/thread-context/connector-context";

vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    del: vi.fn(),
  },
}));
vi.mock("@/utils/mcp/provider-connection", () => ({
  connectionExecutor: () => vi.fn(),
}));
vi.mock("@/utils/thread-context/connector-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/utils/thread-context/connector-context")
  >()),
  searchCanvas: vi.fn(),
}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: vi.fn(),
}));
vi.mock("@/utils/mcp/providers/registry", () => ({
  getIntegrationProvider: () => ({ isConfigured: () => false }),
}));

const NOW = new Date("2026-10-20T09:00:00.000Z");

describe("getNextUp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.mcpConnection.findMany.mockResolvedValue([]);
    vi.mocked(fetchCalendarEventsInWindow).mockResolvedValue({
      complete: true,
      events: [
        event("standup", "Standup", 1, "me@gmail.example"),
        event("dentist", "Dentist", 2, "me@outlook.example"),
      ],
    });
  });

  it("names each meeting's calendar when the user has more than one", async () => {
    prisma.calendarConnection.findMany.mockResolvedValue([
      connection("google", "me@gmail.example"),
      connection("microsoft", "me@outlook.example"),
    ] as never);

    const { nextUp } = await nextUpFor();

    expect(nextUp.map(({ title, detail }) => [title, detail])).toEqual([
      ["Standup", "me@gmail.example"],
      ["Dentist", "me@outlook.example"],
    ]);
  });

  it("says only Calendar when there is one calendar to tell apart", async () => {
    prisma.calendarConnection.findMany.mockResolvedValue([
      connection("google", "me@gmail.example"),
      connection("google", "ME@gmail.example"),
    ] as never);

    const { nextUp } = await nextUpFor();

    expect(nextUp.map(({ source, detail }) => [source, detail])).toEqual([
      ["Calendar", undefined],
      ["Calendar", undefined],
    ]);
  });

  it("does not count a disconnected calendar as a second one", async () => {
    prisma.calendarConnection.findMany.mockResolvedValue([
      connection("google", "me@gmail.example"),
      connection("microsoft", "me@outlook.example", { isConnected: false }),
    ] as never);

    const { nextUp } = await nextUpFor();

    expect(nextUp.map(({ source, detail }) => [source, detail])).toEqual([
      ["Calendar", undefined],
      ["Calendar", undefined],
    ]);
  });
});

describe("getNextUp when a connected app keeps timing out", () => {
  const MINUTE = 60_000;
  let store: Map<string, { value: unknown; expiresAt: number }>;
  let logger: ReturnType<typeof createTestLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: NOW });
    store = new Map();
    logger = createTestLogger();
    vi.spyOn(logger, "warn");
    fakeRedis();
    prisma.calendarConnection.findMany.mockResolvedValue([]);
    prisma.mcpConnection.findMany.mockResolvedValue([
      {
        id: "mcp-1",
        needsReconnectAt: null,
        emailAccountId: "account",
        emailAccount: { email: "me@gmail.example" },
        integration: { name: "canvas" },
      },
    ] as never);
    vi.mocked(fetchCalendarEventsInWindow).mockResolvedValue({
      complete: true,
      events: [],
    });
    vi.mocked(searchCanvas).mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses for longer after each timeout, up to a cap", async () => {
    const pauses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      await visit();
      pauses.push(pauseMinutes());
      vi.advanceTimersByTime(pauseMinutes() * MINUTE + 1);
    }

    expect(pauses).toEqual([5, 15, 60, 60, 60]);
  });

  it("starts over at the short pause after the app answers", async () => {
    await visit();
    vi.advanceTimersByTime(5 * MINUTE + 1);
    await visit();
    expect(pauseMinutes()).toBe(15);
    vi.advanceTimersByTime(15 * MINUTE + 1);

    vi.mocked(searchCanvas).mockResolvedValue([]);
    await visit();
    vi.mocked(searchCanvas).mockImplementation(() => new Promise(() => {}));
    await visit();

    expect(pauseMinutes()).toBe(5);
  });

  it("does not wait on an app that is paused", async () => {
    await visit();

    const waited = await visit();

    expect(waited).toBe(0);
    expect(searchCanvas).toHaveBeenCalledTimes(1);
  });

  it("logs the attempt count and pause length, nothing about the user", async () => {
    await visit();
    vi.advanceTimersByTime(5 * MINUTE + 1);
    await visit();

    expect(logger.warn).toHaveBeenLastCalledWith("Connected app timed out", {
      app: "canvas",
      attempts: 2,
      pauseMinutes: 15,
    });
  });

  it("adds 15 s over four hours of minute-apart visits, where a fixed pause added 120 s", async () => {
    let total = 0;
    let slowLoads = 0;
    for (let minute = 0; minute < 240; minute++) {
      const waited = await visit();
      total += waited;
      if (waited > 0) slowLoads += 1;
      vi.advanceTimersByTime(MINUTE);
    }

    expect({ slowLoads, total }).toEqual({ slowLoads: 6, total: 15_000 });
  });

  /** Opens Today once and returns how long it waited, in fake milliseconds. */
  async function visit() {
    const start = Date.now();
    let done = false;
    const loading = nextUpFor(logger).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    while (!done) await vi.advanceTimersByTimeAsync(50);
    await loading;
    return Date.now() - start;
  }

  function pauseMinutes() {
    const entry = store.get("home-deadlines-paused:canvas:account");
    return entry ? Math.round((entry.expiresAt - Date.now()) / MINUTE) : 0;
  }

  function fakeRedis() {
    const live = (key: string) => {
      const entry = store.get(key);
      if (entry && entry.expiresAt <= Date.now()) store.delete(key);
      return store.get(key);
    };
    vi.mocked(redis.get).mockImplementation(
      async (key: string) => live(key)?.value ?? null,
    );
    vi.mocked(redis.set).mockImplementation((async (
      key: string,
      value: unknown,
      options?: { ex?: number },
    ) => {
      store.set(key, {
        value,
        expiresAt: Date.now() + (options?.ex ?? 1e9) * 1000,
      });
      return "OK";
    }) as never);
    vi.mocked(redis.incr).mockImplementation(async (key: string) => {
      const next = Number(live(key)?.value ?? 0) + 1;
      store.set(key, { value: next, expiresAt: live(key)?.expiresAt ?? 1e15 });
      return next;
    });
    vi.mocked(redis.expire).mockImplementation((async (
      key: string,
      seconds: number,
    ) => {
      const entry = live(key);
      if (entry) entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }) as never);
    vi.mocked(redis.del).mockImplementation((async (key: string) => {
      store.delete(key);
      return 1;
    }) as never);
  }
});

function nextUpFor(logger = createTestLogger()) {
  return getNextUp({
    emailAccountId: "account",
    ownAddresses: ["me@gmail.example", "me@outlook.example"],
    timeZone: "UTC",
    logger,
    now: NOW,
  });
}

let connectionId = 0;
function connection(
  provider: string,
  email: string,
  { isConnected = true }: { isConnected?: boolean } = {},
) {
  connectionId += 1;
  return { id: `connection-${connectionId}`, provider, email, isConnected };
}

function event(
  id: string,
  title: string,
  hoursFromNow: number,
  calendarEmail: string,
): CalendarEvent {
  const startTime = new Date(NOW.getTime() + hoursFromNow * 3_600_000);
  return {
    id,
    title,
    startTime,
    endTime: new Date(startTime.getTime() + 1_800_000),
    attendees: [],
    calendarEmail,
  };
}
