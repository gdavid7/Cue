// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import {
  clearBrowserCaches,
  clearBrowserCachesForAccount,
  resetBrowserCacheForTesting,
  setBrowserCacheUser,
} from "@/utils/browser-cache";
import { readCachedToday, writeCachedToday } from "./today-cache";

// Local times: what counts as "today" is the browser's own day.
const NOW = new Date(2026, 9, 16, 12, 0).getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const account = { emailAccountId: "account-1" };

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
      readCachedToday({ emailAccountId: "account-2", now: NOW }),
    ).toBeUndefined();

    setBrowserCacheUser("user-2");
    expect(readCachedToday({ ...account, now: NOW })).toBeUndefined();
    // The next user on this browser doesn't keep the last one's either.
    expect(window.localStorage.length).toBe(0);
  });

  it("keeps a returning user's Today from an earlier day, without that day's counts", () => {
    const lateEvening = new Date(2026, 9, 16, 23, 30).getTime();
    const nextMorning = new Date(2026, 9, 17, 8, 0).getTime();
    writeCachedToday({
      ...account,
      data: home({
        calendar: {
          connected: true,
          next: {
            title: "Standup",
            at: "2026-10-17T09:00:00Z",
            tomorrow: true,
          },
        },
        nextUp: [
          upcoming("yesterday", new Date(2026, 9, 16, 22, 0)),
          upcoming("later", new Date(2026, 9, 17, 15, 0)),
        ],
      } as Partial<GetHomeResponse>),
      now: lateEvening,
    });

    const cached = readCachedToday({ ...account, now: nextMorning });
    expect(cached?.needsYou).toEqual(home().needsYou);
    expect(cached?.alsoInInbox).toEqual(home().alsoInInbox);
    expect(cached?.today).toEqual({ checked: 0, filed: 0, filedLabel: null });
    expect(cached?.calendar.next).toBeNull();
    expect(cached?.nextUp.map((item) => item.id)).toEqual(["later"]);
  });

  it("drops a copy too old to say much about the inbox now", () => {
    writeCachedToday({ ...account, data: home(), now: NOW });
    expect(readCachedToday({ ...account, now: NOW + 2 * DAY })).toBeDefined();
    expect(readCachedToday({ ...account, now: NOW + 3 * DAY })).toBeUndefined();
  });

  it("keeps only a Today whose lanes all loaded", () => {
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
    writeCachedToday({ emailAccountId: "account-2", data: home(), now: NOW });
    clearBrowserCachesForAccount("account-1");
    expect(readCachedToday({ ...account, now: NOW })).toBeUndefined();
    expect(readCachedToday({ emailAccountId: "account-2", now: NOW })).toEqual(
      home(),
    );
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

function upcoming(id: string, at: Date) {
  return {
    id,
    kind: "event" as const,
    title: id,
    at: at.toISOString(),
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
    pending: [],
    failed: [],
    agentTasks: [],
    cue: { ready: true },
    today: { checked: 3, filed: 1, filedLabel: null },
    calendar: { connected: true, next: null },
    nextUp: [],
    stats: {
      needsYou: 1,
      estimatedMinutes: 3,
      agentWorking: 0,
      waiting: 0,
      needsYouCapped: false,
      waitingCapped: false,
    },
    ...overrides,
  } as unknown as GetHomeResponse;
}
