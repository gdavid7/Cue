// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import {
  clearCachedToday,
  clearCachedTodayForAccount,
  readCachedToday,
  resetCachedTodayBlocksForTesting,
  writeCachedToday,
} from "./today-cache";

// Local times: what counts as "today" is the browser's own day.
const NOW = new Date(2026, 9, 16, 12, 0).getTime();
const HOUR = 60 * 60 * 1000;
const owner = { userId: "user-1", emailAccountId: "account-1" };

describe("Today's cache", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetCachedTodayBlocksForTesting();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens Today on what it last showed this account", () => {
    writeCachedToday({ ...owner, data: home(), now: NOW });
    expect(readCachedToday({ ...owner, now: NOW + HOUR })).toEqual(home());
  });

  it("never shows one account's Today under another account or user", () => {
    writeCachedToday({ ...owner, data: home(), now: NOW });
    expect(
      readCachedToday({ ...owner, emailAccountId: "account-2", now: NOW }),
    ).toBeUndefined();
    expect(
      readCachedToday({ ...owner, userId: "user-2", now: NOW }),
    ).toBeUndefined();
  });

  it("forgets the previous user's Today when another user saves theirs", () => {
    writeCachedToday({ ...owner, data: home(), now: NOW });
    writeCachedToday({
      userId: "user-2",
      emailAccountId: "account-9",
      data: home(),
      now: NOW,
    });
    expect(window.localStorage.length).toBe(1);
    expect(readCachedToday({ ...owner, now: NOW })).toBeUndefined();
  });

  it("drops a Today saved on an earlier day, however recently", () => {
    // Its counts and "Next up" were yesterday's.
    const lateEvening = new Date(2026, 9, 16, 23, 30).getTime();
    const afterMidnight = new Date(2026, 9, 17, 0, 30).getTime();
    writeCachedToday({ ...owner, data: home(), now: lateEvening });
    expect(readCachedToday({ ...owner, now: afterMidnight })).toBeUndefined();
    expect(window.localStorage.length).toBe(0);
  });

  it("forgets other users' and out-of-date entries when it reads", () => {
    writeCachedToday({
      userId: "user-2",
      emailAccountId: "account-9",
      data: home(),
      now: NOW - HOUR,
    });
    window.localStorage.setItem(
      "cue:today:v1:user-1:account-2",
      JSON.stringify({
        userId: "user-1",
        emailAccountId: "account-2",
        savedAt: NOW - 30 * HOUR,
        data: home(),
      }),
    );
    writeCachedToday({ ...owner, data: home(), now: NOW - HOUR });
    // Saving user-1's Today already forgot user-2's; put one back.
    window.localStorage.setItem(
      "cue:today:v1:user-2:account-9",
      JSON.stringify({
        userId: "user-2",
        emailAccountId: "account-9",
        savedAt: NOW - HOUR,
        data: home(),
      }),
    );

    expect(readCachedToday({ ...owner, now: NOW })).toEqual(home());
    expect(Object.keys(window.localStorage)).toEqual([
      "cue:today:v1:user-1:account-1",
    ]);
  });

  it("keeps only a Today whose lanes all loaded", () => {
    // A lane still pending would be read later as an empty one: "All clear".
    writeCachedToday({
      ...owner,
      data: home({ pending: ["needsYou"] }),
      now: NOW,
    });
    writeCachedToday({
      ...owner,
      data: home({ failed: ["waiting"] }),
      now: NOW,
    });
    expect(readCachedToday({ ...owner, now: NOW })).toBeUndefined();
  });

  it("keeps the rows Today shows, with short previews", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      thread(`thread-${index}`, "x".repeat(500)),
    );
    writeCachedToday({
      ...owner,
      data: home({ alsoInInbox: rows }),
      now: NOW,
    });
    const cached = readCachedToday({ ...owner, now: NOW });
    expect(cached?.alsoInInbox).toHaveLength(5);
    expect(cached?.alsoInInbox[0].preview.length).toBeLessThanOrEqual(140);
  });

  it("clears every Today on sign-out and saves none after", () => {
    writeCachedToday({ ...owner, data: home(), now: NOW });
    clearCachedToday();
    expect(readCachedToday({ ...owner, now: NOW })).toBeUndefined();
    // A load landing during sign-out must not bring it back.
    writeCachedToday({ ...owner, data: home(), now: NOW });
    expect(window.localStorage.length).toBe(0);
  });

  it("clears a removed account's Today only", () => {
    writeCachedToday({ ...owner, data: home(), now: NOW });
    writeCachedToday({
      ...owner,
      emailAccountId: "account-2",
      data: home(),
      now: NOW,
    });
    clearCachedTodayForAccount("account-1");
    expect(readCachedToday({ ...owner, now: NOW })).toBeUndefined();
    expect(
      readCachedToday({ ...owner, emailAccountId: "account-2", now: NOW }),
    ).toEqual(home());
  });

  it("works without storage, as in a private window", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() =>
      writeCachedToday({ ...owner, data: home(), now: NOW }),
    ).not.toThrow();
    expect(readCachedToday({ ...owner, now: NOW })).toBeUndefined();
    expect(() => clearCachedToday()).not.toThrow();
  });

  it("ignores a corrupt entry", () => {
    window.localStorage.setItem("cue:today:v1:user-1:account-1", "{nope");
    expect(readCachedToday({ ...owner, now: NOW })).toBeUndefined();
  });
});

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
