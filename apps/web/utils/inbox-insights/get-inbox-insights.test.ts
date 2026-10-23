import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordingRedis } from "@/__tests__/mocks/recording-redis.mock";
import type { EmailProvider } from "@/utils/email/types";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/__mocks__/prisma";
import { getInboxInsights } from "./get-inbox-insights";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", async () => ({
  redis: (await import("@/__tests__/mocks/recording-redis.mock")).recordingRedis
    .client,
}));
vi.mock("@/utils/rate-limit", () => ({
  assertWithinUserRateLimit: async () => {},
}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: async () => ({
    events: [
      {
        id: "e1",
        title: "Renewal call",
        startTime: new Date("2026-10-20T17:00:00Z"),
        endTime: new Date("2026-10-20T18:00:00Z"),
        attendees: [
          { email: "Sarah@Acme.com" },
          { email: "no@acme.com", declined: true },
        ],
      },
    ],
  }),
}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAi: async () => null,
}));
vi.mock("@/utils/thread-context/suggest-reply", () => ({
  getSuggestedReplySettings: async () => ({
    draftReplies: "on" as const,
    webLookupEnabled: false,
  }),
}));

const logger = createScopedLogger("test");

describe("getInboxInsights", () => {
  beforeEach(() => {
    recordingRedis.reset();
    prisma.executedAction.findMany.mockResolvedValue([]);
  });

  // The row says "Cue drafted a reply" for a reply waiting in Cue, read for
  // every row, held or not.
  it("names the messages with a reply Cue wrote, by ID only", async () => {
    prisma.executedAction.findMany.mockResolvedValue([
      { executedRule: { messageId: "m2" } },
    ] as never);

    const { draftedMessageIds } = await getInboxInsights({
      emailAccountId: "a1",
      userId: "u1",
      userEmail: "me@example.com",
      items: ["m1", "m2"].map((messageId) => ({
        threadId: `t-${messageId}`,
        messageId,
      })),
      known: ["m1", "m2"],
      emailProvider: {} as EmailProvider,
      logger,
    });

    expect(draftedMessageIds).toEqual(["m2"]);
    const query = prisma.executedAction.findMany.mock.calls[0]?.[0];
    expect(query?.where).toMatchObject({
      type: "DRAFT_EMAIL",
      draftId: null,
      draftStatus: "PENDING",
      suggestedReplyDraft: null,
      executedRule: { emailAccountId: "a1", messageId: { in: ["m1", "m2"] } },
    });
    expect(query?.select).not.toHaveProperty("content");
  });

  // RD-3: what Cue reads from an email goes to the browser, which keeps it
  // and names those messages next time.
  it("reads only the emails the browser doesn't hold, and caches none of them", async () => {
    const getMessage = vi.fn(async (id: string) => ({
      id,
      headers: {
        from: "Sarah Chen <sarah@acme.com>",
        to: "me@example.com",
        subject: "Renewal",
      },
      labelIds: ["INBOX"],
    }));

    const { insights, events, draftRepliesEnabled } = await getInboxInsights({
      emailAccountId: "a1",
      userId: "u1",
      userEmail: "me@example.com",
      items: ["m1", "m2", "m3"].map((messageId) => ({
        threadId: `t-${messageId}`,
        messageId,
      })),
      known: ["m1", "m2"],
      emailProvider: { getMessage } as unknown as EmailProvider,
      logger,
    });

    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(getMessage).toHaveBeenCalledWith("m3");
    expect(Object.keys(insights)).toEqual(["t-m3"]);
    expect(insights["t-m3"]).toMatchObject({
      messageId: "m3",
      people: [{ email: "sarah@acme.com", name: "Sarah Chen" }],
      withAi: false,
    });
    expect(events).toEqual([
      {
        title: "Renewal call",
        at: "2026-10-20T17:00:00.000Z",
        attendees: ["sarah@acme.com"],
      },
    ]);
    expect(draftRepliesEnabled).toBe(true);
    expect(recordingRedis.everythingWritten()).not.toContain("sarah");
  });

  it("reads no email and no calendar for a page the browser holds", async () => {
    const getMessage = vi.fn();

    const { insights, events } = await getInboxInsights({
      emailAccountId: "a1",
      userId: "u1",
      userEmail: "me@example.com",
      items: [{ threadId: "t1", messageId: "m1" }],
      known: ["m1"],
      emailProvider: { getMessage } as unknown as EmailProvider,
      logger,
    });

    expect(getMessage).not.toHaveBeenCalled();
    expect(insights).toEqual({});
    expect(events).toEqual([]);
  });

  // The browser keeps each entry for a month; a mailing to hundreds of
  // recipients must not send all of them, since only a handful can share a
  // meeting.
  it("returns a bounded list of the people on an email", async () => {
    const recipients = Array.from(
      { length: 300 },
      (_, i) => `Person ${i} <person${i}@example.com>`,
    ).join(", ");
    const getMessage = vi.fn(async () => ({
      id: "m-big",
      headers: { from: "host@example.com", to: recipients },
      labelIds: ["INBOX"],
    }));

    const { insights } = await getInboxInsights({
      emailAccountId: "a1",
      userId: "u1",
      userEmail: "me@example.com",
      items: [{ threadId: "t-big", messageId: "m-big" }],
      emailProvider: { getMessage } as unknown as EmailProvider,
      logger,
    });

    const people = insights["t-big"]?.people ?? [];
    expect(people.length).toBeGreaterThan(0);
    expect(people.length).toBeLessThanOrEqual(25);
  });

  // PF-9v: the rows' reads run within a Gmail wait budget. What was built
  // goes back; the rest is named, so the browser asks again for exactly it.
  it("returns what it built and names the emails it left once a read is deferred", async () => {
    const getMessage = vi.fn(async (id: string) => {
      if (id === "m3") throw new GmailCallDeferredError(20_000, "background");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { id, headers: { from: "a@acme.com" }, labelIds: ["INBOX"] };
    });
    const ids = Array.from({ length: 10 }, (_, i) => `m${i + 1}`);

    const { insights, deferred } = await getInboxInsights({
      emailAccountId: "a1",
      userId: "u1",
      userEmail: "me@example.com",
      items: ids.map((messageId) => ({
        threadId: `t-${messageId}`,
        messageId,
      })),
      emailProvider: { getMessage } as unknown as EmailProvider,
      logger,
    });

    expect(Object.keys(insights).sort()).toEqual(["t-m1", "t-m2", "t-m4"]);
    // The reads already started finish; none is started after the deferral.
    expect(getMessage).toHaveBeenCalledTimes(4);
    expect(deferred?.messageIds.sort()).toEqual(
      ["m3", "m5", "m6", "m7", "m8", "m9", "m10"].sort(),
    );
    expect(deferred?.retryAfterMs).toBe(20_000);
  });

  it("defers the whole request when it built nothing, so the browser waits it out", async () => {
    const getMessage = vi.fn(async () => {
      throw new GmailCallDeferredError(20_000, "background");
    });

    await expect(
      getInboxInsights({
        emailAccountId: "a1",
        userId: "u1",
        userEmail: "me@example.com",
        items: [
          { threadId: "t1", messageId: "m1" },
          { threadId: "t2", messageId: "m2" },
        ],
        emailProvider: { getMessage } as unknown as EmailProvider,
        logger,
      }),
    ).rejects.toBeInstanceOf(GmailCallDeferredError);
  });
});
