import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import type { EmailProvider } from "@/utils/email/types";
import { createScopedLogger } from "@/utils/logger";
import { getInboxInsights, nextMeetingWith } from "./get-inbox-insights";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
const { cache, redisCalls } = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  redisCalls: [] as string[],
}));
vi.mock("@/utils/redis", () => ({
  redis: {
    get: async (key: string) => {
      redisCalls.push("get");
      return cache.get(key) ?? null;
    },
    mget: async (...keys: string[]) => {
      redisCalls.push("mget");
      return keys.map((key) => cache.get(key) ?? null);
    },
    set: async () => {
      redisCalls.push("set");
      return "OK";
    },
  },
}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: async () => ({ events: [] }),
}));
vi.mock("@/utils/thread-context/suggest-reply", () => ({
  getSuggestedReplySettings: async () => ({
    draftRepliesEnabled: false,
    webLookupEnabled: false,
  }),
  getCachedSuggestedReplies: async (keys: unknown[]) =>
    keys.map(() => ({ status: "unavailable" })),
}));

describe("getInboxInsights", () => {
  beforeEach(() => {
    cache.clear();
    redisCalls.length = 0;
  });

  // Every list change refetches every row; each Redis command is billed, so
  // a page of rows is one read, not one per row.
  it("reads a page of cached insights in one Redis command", async () => {
    const items = ["m1", "m2", "m3"].map((messageId) => ({
      threadId: `t-${messageId}`,
      messageId,
    }));
    for (const { messageId } of items)
      cache.set(`inbox-insight:a1:${messageId}`, {
        insight: { kind: "question", text: `About ${messageId}` },
        people: [],
      });
    const getMessage = vi.fn();

    const { insights } = await getInboxInsights({
      emailAccountId: "a1",
      userEmail: "me@example.com",
      items,
      emailProvider: { getMessage } as unknown as EmailProvider,
      logger: createScopedLogger("test"),
    });

    expect(insights["t-m2"]?.insight).toMatchObject({ text: "About m2" });
    expect(getMessage).not.toHaveBeenCalled();
    expect(redisCalls).toEqual(["mget"]);
  });
});

describe("nextMeetingWith", () => {
  it("picks the soonest meeting someone on the email is also invited to", () => {
    const meeting = nextMeetingWith(
      [{ email: "sarah@acme.com", name: "Sarah Chen" }],
      [
        event("later", "2026-10-20T17:00:00Z", ["sarah@acme.com"]),
        event("sooner", "2026-10-16T17:00:00Z", ["Sarah@Acme.com"]),
        event("unrelated", "2026-10-14T17:00:00Z", ["kevin@ucsd.edu"]),
      ],
    );

    expect(meeting).toMatchObject({ title: "sooner", with: "Sarah Chen" });
  });

  it("ignores meetings the person declined", () => {
    const declined = event("declined", "2026-10-16T17:00:00Z", []);
    declined.attendees = [{ email: "sarah@acme.com", declined: true }];

    expect(
      nextMeetingWith([{ email: "sarah@acme.com", name: "" }], [declined]),
    ).toBeNull();
  });
});

function event(title: string, start: string, emails: string[]): CalendarEvent {
  return {
    id: title,
    title,
    startTime: new Date(start),
    endTime: new Date(start),
    attendees: emails.map((email) => ({ email })),
  } as CalendarEvent;
}
