// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import {
  clearBrowserCaches,
  clearBrowserCachesForAccount,
  resetBrowserCacheForTesting,
  setBrowserCacheUser,
} from "@/utils/browser-cache";
import {
  readCachedToday,
  removeFromCachedToday,
  writeCachedToday,
} from "./today-cache";

const ZONE = "America/New_York";
// 12:00 in New York on Oct 16 2026 (EDT, UTC-4).
const NOW = Date.parse("2026-10-16T16:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const account = { emailAccountId: "account-1", timeZone: ZONE };

describe("Today's cache", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserCacheForTesting("user-1");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens Today on what it last showed this account", () => {
    writeCachedToday({ ...account, data: home(), now: NOW });
    expect(readCachedToday({ ...account, now: NOW + HOUR })).toEqual(home());
  });

  it("never shows one account's Today under another account or user", () => {
    writeCachedToday({ ...account, data: home(), now: NOW });
    expect(
      readCachedToday({ ...account, emailAccountId: "account-2", now: NOW }),
    ).toBeUndefined();

    setBrowserCacheUser("user-2");
    expect(readCachedToday({ ...account, now: NOW })).toBeUndefined();
    // The next user on this browser doesn't keep the last one's either.
    expect(window.localStorage.length).toBe(0);
  });

  it("drops a meeting or deadline that has passed, even the same day", () => {
    writeCachedToday({
      ...account,
      data: home({
        calendar: {
          connected: true,
          clearThroughTomorrow: false,
          next: {
            title: "Standup",
            at: iso(NOW + HOUR),
            url: undefined,
            tomorrow: false,
          },
        },
        nextUp: [
          upcoming("standup", NOW + HOUR),
          upcoming("review", NOW + 4 * HOUR),
        ],
      }),
      now: NOW,
    });

    const later = readCachedToday({ ...account, now: NOW + 2 * HOUR });
    expect(later?.earlierDay).toBeUndefined();
    expect(later?.calendar.next).toBeNull();
    expect(later?.nextUp.map((item) => item.id)).toEqual(["review"]);
    // The day's counts are still the day's.
    expect(later?.today).toEqual(home().today);
  });

  it("never says the calendar is clear from a saved copy, even the same day", () => {
    writeCachedToday({
      ...account,
      data: home({
        calendar: { connected: true, clearThroughTomorrow: true, next: null },
      }),
      now: NOW,
    });

    const later = readCachedToday({ ...account, now: NOW + HOUR });
    expect(later?.calendar).toEqual({
      connected: true,
      clearThroughTomorrow: false,
      next: null,
    });
  });

  it("keeps an earlier day's conversations, and marks the rest of it unknown", () => {
    writeCachedToday({
      ...account,
      data: home({
        agentTasks: [{ id: "draft-1" }] as GetHomeResponse["agentTasks"],
        nextUp: [upcoming("tomorrow", NOW + DAY)],
      }),
      now: NOW,
    });

    const nextMorning = readCachedToday({ ...account, now: NOW + 20 * HOUR });
    expect(nextMorning?.earlierDay).toBe(true);
    expect(nextMorning?.needsYou).toEqual(home().needsYou);
    expect(nextMorning?.alsoInInbox).toEqual(home().alsoInInbox);
    expect(nextMorning?.today).toEqual({
      checked: 0,
      filed: 0,
      filedLabel: null,
    });
    expect(nextMorning?.agentTasks).toEqual([]);
    expect(nextMorning?.cue.aiAccess).toBe(false);
    expect(nextMorning?.nextUp.map((item) => item.id)).toEqual(["tomorrow"]);
  });

  it("counts the day in the zone Today's answer was counted in", () => {
    // 23:30 in New York is already the next day in UTC.
    const lateEvening = Date.parse("2026-10-17T03:30:00Z");
    writeCachedToday({ ...account, data: home(), now: lateEvening });

    // 00:30 in New York: a new day there, though the same day in UTC.
    const afterMidnight = lateEvening + HOUR;
    expect(
      readCachedToday({ ...account, now: lateEvening + 20 * 60_000 })
        ?.earlierDay,
    ).toBeUndefined();
    expect(
      readCachedToday({ ...account, now: afterMidnight })?.earlierDay,
    ).toBe(true);
    // Read in another zone, its counts belong to a day that zone doesn't share.
    expect(
      readCachedToday({
        ...account,
        timeZone: "UTC",
        now: lateEvening + 20 * 60_000,
      })?.earlierDay,
    ).toBe(true);
  });

  it("drops a copy too old to say much about the inbox now", () => {
    writeCachedToday({ ...account, data: home(), now: NOW });
    expect(readCachedToday({ ...account, now: NOW + 2 * DAY })).toBeDefined();
    expect(readCachedToday({ ...account, now: NOW + 3 * DAY })).toBeUndefined();
    // Expired mail isn't left in storage either.
    expect(window.localStorage.length).toBe(0);
  });

  it("keeps only a Today whose lanes all loaded, for today", () => {
    // A lane still pending would be read later as an empty one: "All clear".
    writeCachedToday({
      ...account,
      data: home({ pending: ["needsYou"] }),
      now: NOW,
    });
    writeCachedToday({
      ...account,
      data: home({ failed: ["waiting"] }),
      now: NOW,
    });
    writeCachedToday({
      ...account,
      data: { ...home(), stale: ["alsoInInbox"] },
      now: NOW,
    });
    writeCachedToday({
      ...account,
      data: { ...home(), earlierDay: true },
      now: NOW,
    });
    expect(readCachedToday({ ...account, now: NOW })).toBeUndefined();
  });

  it("keeps the rows Today shows, with short previews", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      thread(`thread-${index}`, "x".repeat(500)),
    );
    writeCachedToday({
      ...account,
      data: home({ alsoInInbox: rows }),
      now: NOW,
    });
    const cached = readCachedToday({ ...account, now: NOW });
    expect(cached?.alsoInInbox).toHaveLength(5);
    expect(cached?.alsoInInbox[0].preview.length).toBeLessThanOrEqual(140);
  });

  it("forgets a conversation the user archived, so it doesn't come back", () => {
    writeCachedToday({ ...account, data: home(), now: NOW });
    removeFromCachedToday("account-1", ["needs-1"], NOW + HOUR);

    const cached = readCachedToday({ ...account, now: NOW + HOUR });
    expect(cached?.needsYou).toEqual([]);
    expect(cached?.stats.needsYou).toBe(0);
    expect(cached?.alsoInInbox).toEqual(home().alsoInInbox);
    // It is still the copy from when it was saved.
    expect(
      readCachedToday({ ...account, now: NOW + 3 * DAY - 1 }),
    ).toBeDefined();
    expect(readCachedToday({ ...account, now: NOW + 3 * DAY })).toBeUndefined();
  });

  it("ignores a copy saved in another shape, as by an earlier deploy", () => {
    const key = "cue:browser-cache:v2:user-1:today:account-1";
    const stored = (value: unknown) =>
      window.localStorage.setItem(
        key,
        JSON.stringify({ home: { savedAt: NOW, value } }),
      );

    // Before versions: { savedAt, data }.
    stored({ savedAt: NOW, data: home() });
    expect(readCachedToday({ ...account, now: NOW })).toBeUndefined();
    // A newer version.
    stored({ version: 99, savedAt: NOW, timeZone: ZONE, data: home() });
    expect(readCachedToday({ ...account, now: NOW })).toBeUndefined();
    // The right version, missing what Today reads.
    stored({
      version: 1,
      savedAt: NOW,
      timeZone: ZONE,
      data: { needsYou: "nope" },
    });
    expect(readCachedToday({ ...account, now: NOW })).toBeUndefined();
    // A time zone this browser can't read.
    stored({
      version: 1,
      savedAt: NOW,
      timeZone: "Nowhere/Else",
      data: home(),
    });
    expect(() => readCachedToday({ ...account, now: NOW })).not.toThrow();

    window.localStorage.setItem(key, "{nope");
    expect(readCachedToday({ ...account, now: NOW })).toBeUndefined();
  });

  it("clears every Today on sign-out and saves none after", () => {
    writeCachedToday({ ...account, data: home(), now: NOW });
    clearBrowserCaches();
    expect(window.localStorage.length).toBe(0);
    // A load landing during sign-out must not bring it back.
    writeCachedToday({ ...account, data: home(), now: NOW });
    expect(window.localStorage.length).toBe(0);
    setBrowserCacheUser("user-1");
    expect(readCachedToday({ ...account, now: NOW })).toBeUndefined();
  });

  it("clears a removed account's Today only", () => {
    writeCachedToday({ ...account, data: home(), now: NOW });
    writeCachedToday({
      ...account,
      emailAccountId: "account-2",
      data: home(),
      now: NOW,
    });
    clearBrowserCachesForAccount("account-1");
    expect(readCachedToday({ ...account, now: NOW })).toBeUndefined();
    expect(
      readCachedToday({ ...account, emailAccountId: "account-2", now: NOW }),
    ).toEqual(home());
  });

  it("forgets the copy kept before Today moved into the browser cache", () => {
    window.localStorage.setItem("cue:today:v1:user-1:account-1", "{}");
    resetBrowserCacheForTesting("user-1");
    expect(window.localStorage.length).toBe(0);
  });

  it("works without storage, as in a private window", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() =>
      writeCachedToday({ ...account, data: home(), now: NOW }),
    ).not.toThrow();
    expect(readCachedToday({ ...account, now: NOW })).toBeUndefined();
  });
});

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function upcoming(id: string, at: number) {
  return {
    id,
    kind: "event" as const,
    title: id,
    at: iso(at),
    endAt: iso(at + HOUR / 2),
    source: "Calendar",
  };
}

function thread(threadId: string, preview = "A short preview") {
  return {
    threadId,
    fromName: "Alice",
    fromEmail: "alice@example.com",
    subject: "Hello",
    preview,
    at: "2026-10-16T10:00:00Z",
    priority: "medium" as const,
    unread: true,
    messageId: `${threadId}-message`,
    starred: false,
    inInbox: true,
  };
}

function home(overrides: Partial<GetHomeResponse> = {}): GetHomeResponse {
  return {
    needsYou: [thread("needs-1")],
    waiting: [],
    alsoInInbox: [thread("inbox-1")],
    reading: [],
    pending: [],
    failed: [],
    agentTasks: [],
    cue: { aiAccess: true, replyTracking: true, hasReadMail: true },
    today: { checked: 3, filed: 1, filedLabel: null },
    calendar: { connected: true, clearThroughTomorrow: false, next: null },
    nextUp: [],
    suggestion: null,
    stats: {
      needsYou: 1,
      estimatedMinutes: 3,
      agentWorking: 0,
      waiting: 0,
      needsYouCapped: false,
      waitingCapped: false,
      readingCapped: false,
    },
    ...overrides,
  } as GetHomeResponse;
}
