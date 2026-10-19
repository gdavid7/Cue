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
    eval: async () => 1,
    get: async (key: string) => {
      redisCalls.push("get");
      return cache.get(key) ?? null;
    },
    mget: async (...keys: string[]) => {
      redisCalls.push("mget");
      return keys.map((key) => cache.get(key) ?? null);
    },
    set: async (key: string, value: unknown) => {
      redisCalls.push("set");
      cache.set(key, value);
      return "OK";
    },
  },
}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: async () => ({ events: [] }),
}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAi: async () => null,
}));
vi.mock("@/utils/thread-context/suggest-reply", () => ({
  getSuggestedReplySettings: async () => ({
    draftReplies: "off" as const,
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
      userId: "u1",
      userEmail: "me@example.com",
      items,
      emailProvider: { getMessage } as unknown as EmailProvider,
      logger: createScopedLogger("test"),
    });

    expect(insights["t-m2"]?.insight).toMatchObject({ text: "About m2" });
    expect(getMessage).not.toHaveBeenCalled();
    expect(redisCalls).toEqual(["mget"]);
  });

  // Each entry is kept for a month; a mailing to hundreds of recipients must
  // not store all of them, since only a handful can share a meeting.
  it("stores a bounded list of the people on an email", async () => {
    const recipients = Array.from(
      { length: 300 },
      (_, i) => `Person ${i} <person${i}@example.com>`,
    ).join(", ");
    const getMessage = vi.fn(async () => ({
      id: "m-big",
      headers: { from: "host@example.com", to: recipients },
      labelIds: ["INBOX"],
    }));

    await getInboxInsights({
      emailAccountId: "a1",
      userId: "u1",
      userEmail: "me@example.com",
      items: [{ threadId: "t-big", messageId: "m-big" }],
      emailProvider: { getMessage } as unknown as EmailProvider,
      logger: createScopedLogger("test"),
    });

    const stored = cache.get("inbox-insight:a1:m-big") as {
      people: unknown[];
    };
    expect(stored.people.length).toBeGreaterThan(0);
    expect(stored.people.length).toBeLessThanOrEqual(25);
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
