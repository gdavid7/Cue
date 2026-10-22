import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import type { gmail_v1 } from "@googleapis/gmail";
import { GmailProvider } from "@/utils/email/google";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import {
  AppToolError,
  ConnectionExpiredError,
} from "@/utils/mcp/providers/types";
import { redis } from "@/utils/redis";
import { mergeNextUp } from "@/utils/home/merge-home";
import { getDeadlines } from "@/utils/home/next-up";
import { getHomeData, priorityOf } from "./get-home";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
  },
}));
const mocks = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  executeTool: vi.fn(),
}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: mocks.fetchEvents,
}));
vi.mock("@/utils/mcp/providers/registry", () => ({
  getIntegrationProvider: () => ({
    executeTool: mocks.executeTool,
    isConfigured: () => true,
  }),
}));

const USER = "david@example.com";
const NOW = new Date("2026-10-13T16:00:00Z");
// 9:00 AM in Los Angeles, where the user is.
const TIME_ZONE = "America/Los_Angeles";
// Prisma's groupBy type is too generic for the mock's helpers.
const checkedMessages = prisma.executedRule.groupBy as unknown as Mock;
const LABELS = [
  { id: "INBOX", name: "INBOX" },
  { id: "UNREAD", name: "UNREAD" },
  { id: "Label_To Reply", name: "To Reply" },
  { id: "Label_Awaiting Reply", name: "Awaiting Reply" },
  { id: "Label_Customer", name: "Customer" },
  { id: "Label_Newsletter", name: "Newsletter" },
  { id: "Label_Receipt", name: "Receipt" },
];

describe("getHomeData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchEvents.mockResolvedValue({ events: [], complete: true });
    checkedMessages.mockResolvedValue([]);
    prisma.mcpConnection.findMany.mockResolvedValue([]);
    prisma.calendarConnection.findMany.mockResolvedValue([]);
    prisma.emailMessage.findMany.mockResolvedValue([]);
    prisma.executedAction.findMany.mockResolvedValue([]);
    prisma.scheduledAction.findMany.mockResolvedValue([]);
    prisma.executedRule.findMany.mockResolvedValue([]);
    prisma.executedRule.findFirst.mockResolvedValue({ id: "run-1" } as never);
    prisma.threadTracker.findFirst.mockResolvedValue(null);
    prisma.emailAccount.findUnique.mockResolvedValue({
      user: {
        aiApiKey: null,
        premium: {
          stripeSubscriptionStatus: "active",
          tier: "STARTER_MONTHLY",
        },
      },
      rules: [{ enabled: true }],
    } as never);
  });

  it("says Cue is checking replies once it has read mail and has AI access", async () => {
    const home = await run(mockProvider({}));

    expect(home.cue).toEqual({
      aiAccess: true,
      replyTracking: true,
      hasReadMail: true,
    });
  });

  it("knows when Cue hasn't read any mail yet, so empty isn't a verdict", async () => {
    prisma.executedRule.findFirst.mockResolvedValue(null);
    prisma.threadTracker.findFirst.mockResolvedValue(null);

    const home = await run(mockProvider({}));

    expect(home.cue.hasReadMail).toBe(false);
  });

  it("knows when nothing is checking for replies", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      user: { aiApiKey: null, premium: null },
      rules: [{ enabled: false }],
    } as never);

    const home = await run(mockProvider({}));

    expect(home.cue).toMatchObject({ aiAccess: false, replyTracking: false });
  });

  it("sorts what needs a reply by priority and shows who it's from", async () => {
    const provider = mockProvider({
      NEEDS_REPLY: [
        thread("mom", {
          from: "Mom <mom@example.org>",
          subject: "Dinner?",
          labels: ["INBOX", "Label_To Reply"],
        }),
        thread("sarah", {
          from: "Sarah Chen <sarah@acme.com>",
          subject: "Renewal",
          snippet: "Can you send pricing before Friday?",
          labels: ["INBOX", "Label_To Reply", "Label_Customer", "UNREAD"],
        }),
      ],
    });

    const home = await run(provider);

    expect(home.needsYou.map((t) => t.threadId)).toEqual(["sarah", "mom"]);
    expect(home.needsYou[0]).toMatchObject({
      fromName: "Sarah Chen",
      fromEmail: "sarah@acme.com",
      tag: "Customer",
      priority: "high",
      unread: true,
    });
    expect(home.stats).toMatchObject({ needsYou: 2, estimatedMinutes: 6 });
  });

  it("shows the person you're waiting on, not yourself, when you wrote last", async () => {
    const provider = mockProvider({
      AWAITING: [
        thread("superday", {
          from: `David <${USER}>`,
          to: "Alex Kim <akim@ctc.com>",
          subject: "Re: Superday",
          labels: ["Label_Awaiting Reply"],
        }),
      ],
    });

    const home = await run(provider);

    expect(home.waiting[0]).toMatchObject({
      fromName: "Alex Kim",
      subject: "Superday",
    });
  });

  it("builds reply rows from Gmail's headers-only thread reads", async () => {
    const at = "1760371200000";
    // Gmail's metadata format: no bodies, and only the headers asked for.
    const threadGet = vi.fn(
      async (params: {
        id: string;
        format?: string;
        metadataHeaders?: string[];
      }) => {
        const headers = [
          { name: "From", value: "Sarah Chen <sarah@acme.com>" },
          { name: "To", value: USER },
          { name: "Subject", value: "Re: Renewal" },
          { name: "Date", value: "Mon, 13 Oct 2025 16:00:00 +0000" },
        ].filter((h) => params.metadataHeaders?.includes(h.name));
        return {
          data: {
            id: params.id,
            snippet: "Can you send pricing before Friday?",
            messages: [
              {
                id: "m1",
                threadId: params.id,
                internalDate: at,
                labelIds: ["INBOX", "UNREAD", "STARRED", "Label_Customer"],
                snippet: "Can you send pricing before Friday?",
                payload: { mimeType: "multipart/alternative", headers },
              },
            ],
          },
        };
      },
    );
    const gmail = new GmailProvider({
      users: { threads: { get: threadGet } },
    } as unknown as gmail_v1.Gmail);
    const provider = mockProvider({
      NEEDS_REPLY: [thread("sarah", { from: "", subject: "", labels: [] })],
    });
    vi.mocked(provider.getThread).mockImplementation((id, options) =>
      gmail.getThread(id, options),
    );

    const home = await run(provider);

    expect(threadGet).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sarah", format: "metadata" }),
      expect.anything(),
    );
    expect(home.needsYou).toEqual([
      {
        threadId: "sarah",
        fromName: "Sarah Chen",
        fromEmail: "sarah@acme.com",
        subject: "Renewal",
        preview: "Can you send pricing before Friday?",
        at: new Date(Number(at)).toISOString(),
        tag: "Customer",
        priority: "high",
        unread: true,
        messageId: "m1",
        starred: true,
        inInbox: true,
      },
    ]);
  });

  it("reads what needs a reply from Cue's records, only while it's in the inbox", async () => {
    const provider = mockProvider({
      NEEDS_REPLY: [
        thread("open", {
          from: "Ana <ana@example.org>",
          subject: "Question",
          labels: ["INBOX"],
        }),
        thread("archived", {
          from: "Ben <ben@example.org>",
          subject: "Old",
          labels: [],
        }),
      ],
    });

    const home = await run(provider);

    expect(home.needsYou.map((t) => t.threadId)).toEqual(["open"]);
    expect(prisma.threadTracker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailAccountId: "account-1",
          type: "NEEDS_REPLY",
          resolved: false,
        },
      }),
    );
    for (const [{ query }] of provider.getThreadsWithQuery.mock.calls) {
      expect(query.labelIds).not.toContain("Label_To Reply");
    }
  });

  it("ignores an unsent draft when showing who and when", async () => {
    const mom = thread("mom", {
      from: "Mom <mom@example.org>",
      subject: "Thanksgiving flight?",
      labels: ["INBOX", "Label_To Reply"],
    });
    mom.messages.push({
      ...getMockMessage({
        id: "draft",
        threadId: "mom",
        from: USER,
        to: "mom@example.org",
        subject: "Re: Thanksgiving flight?",
        labelIds: ["DRAFT"],
      }),
      internalDate: String(NOW.getTime() + 60_000),
    });

    const home = await run(mockProvider({ NEEDS_REPLY: [mom] }));

    expect(home.needsYou[0]).toMatchObject({
      fromName: "Mom",
      at: NOW.toISOString(),
    });
  });

  it("answers within its budget with the lanes that loaded, marking a slow one pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const provider = mockProvider({
        NEEDS_REPLY: [
          thread("sarah", {
            from: "Sarah <s@acme.com>",
            subject: "Renewal",
            labels: ["INBOX"],
          }),
        ],
      });
      provider.getThreadsWithQuery.mockReturnValue(new Promise(() => {}));

      let settled = false;
      const pending = run(provider).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(9000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      const home = await pending;

      expect(home.needsYou.map((t) => t.threadId)).toEqual(["sarah"]);
      expect(home.alsoInInbox).toEqual([]);
      expect(home.pending).toEqual(["alsoInInbox"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a lane the Gmail quota gate deferred pending instead of failing the page", async () => {
    const provider = mockProvider({
      NEEDS_REPLY: [
        thread("sarah", {
          from: "Sarah <s@acme.com>",
          subject: "Renewal",
          labels: ["INBOX"],
        }),
      ],
      AWAITING: [
        thread("alex", {
          from: `David <${USER}>`,
          to: "Alex <a@ctc.com>",
          subject: "Superday",
          labels: [],
        }),
      ],
    });
    const getThread = vi.mocked(provider.getThread).getMockImplementation()!;
    vi.mocked(provider.getThread).mockImplementation(async (threadId) => {
      if (threadId === "alex")
        throw new GmailCallDeferredError(5000, "interactive");
      return getThread(threadId);
    });

    const home = await run(provider);

    expect(home.needsYou.map((t) => t.threadId)).toEqual(["sarah"]);
    expect(home.waiting).toEqual([]);
    expect(home.pending).toEqual(["waiting"]);
  });

  it("marks a lane Gmail failed for another reason failed, so empty isn't read as nothing there", async () => {
    const provider = mockProvider({});
    provider.getThreadsWithQuery.mockRejectedValue(new Error("Bad request"));

    const home = await run(provider);

    expect(home.alsoInInbox).toEqual([]);
    expect(home.pending).toEqual([]);
    expect(home.failed).toEqual(["alsoInInbox"]);
  });

  it("holds back the rest of the inbox until the labels load, so filed mail isn't shown there", async () => {
    for (const failure of [
      new GmailCallDeferredError(5000, "interactive"),
      new Error("Bad request"),
    ]) {
      const newsletter = thread("weekly", {
        from: "News <n@x.com>",
        subject: "Weekly",
        labels: ["INBOX", "Label_Newsletter"],
      });
      const provider = mockProvider({ INBOX: [newsletter] });
      provider.getLabels.mockRejectedValue(failure);

      const home = await run(provider);

      expect(home.alsoInInbox).toEqual([]);
      expect(home.pending).toEqual(["alsoInInbox"]);
    }
  });

  it("marks a conversation whose reply Cue already wrote", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      webLookupEnabled: false,
      user: { aiApiKey: null, premium: null },
      rules: [{ enabled: true, actions: [{ type: "DRAFT_EMAIL" }] }],
    } as never);
    prisma.executedAction.findMany.mockImplementation((async (args: {
      where: { executedRule: { messageId?: { in: string[] } } };
    }) =>
      args.where.executedRule.messageId
        ? [{ executedRule: { messageId: "msg1" } }]
        : []) as never);
    const provider = mockProvider({
      NEEDS_REPLY: [
        thread("sarah", {
          from: "Sarah Chen <sarah@acme.com>",
          subject: "Renewal",
          labels: ["INBOX", "Label_To Reply"],
        }),
      ],
    });

    const home = await run(provider);

    expect(home.needsYou[0]).toMatchObject({
      threadId: "sarah",
      cueDrafted: true,
    });
  });

  it("lists pending AI drafts as work in progress", async () => {
    prisma.executedAction.findMany.mockResolvedValue([
      {
        id: "a1",
        subject: "Renewal",
        createdAt: NOW,
        executedRule: { threadId: "sarah" },
      },
    ] as never);

    const home = await run(mockProvider({}));

    expect(home.agentTasks).toEqual([
      expect.objectContaining({
        id: "a1",
        kind: "draft",
        threadId: "sarah",
        title: "Suggested reply: Renewal",
      }),
    ]);
    expect(prisma.executedAction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          executedRule: {
            emailAccountId: "account-1",
            // Only recent drafts: older pending ones were likely deleted.
            createdAt: { gte: new Date("2026-10-06T16:00:00Z") },
          },
        }),
      }),
    );
  });

  it("returns empty lanes, not an error, when the labels don't exist yet", async () => {
    const provider = mockProvider({});
    vi.mocked(provider.getLabels).mockResolvedValue([]);

    const home = await run(provider);

    expect(home.needsYou).toEqual([]);
    // Only the plain inbox is listed: there's no label to query for the lanes.
    expect(provider.getThreadsWithQuery).toHaveBeenCalledTimes(1);
    expect(provider.getThreadsWithQuery).toHaveBeenCalledWith(
      expect.objectContaining({ query: { labelIds: ["INBOX"] } }),
    );
  });

  it("lists the rest of the inbox, so nothing depends on AI triage to be seen", async () => {
    const sarah = thread("sarah", {
      from: "Sarah <s@acme.com>",
      subject: "Renewal",
      labels: ["INBOX", "Label_To Reply"],
    });
    const dentist = thread("dentist", {
      from: "Dentist <d@smile.com>",
      subject: "Your appointment",
      labels: ["INBOX"],
    });
    const provider = mockProvider({
      NEEDS_REPLY: [sarah],
      INBOX: [sarah, dentist],
    });

    const home = await run(provider);

    expect(home.alsoInInbox.map((t) => t.threadId)).toEqual(["dentist"]);
  });

  it("doesn't repeat sorted mail under the rest of the inbox", async () => {
    const newsletter = thread("weekly", {
      from: "News <n@x.com>",
      subject: "Weekly",
      labels: ["INBOX", "Label_Newsletter"],
    });
    const provider = mockProvider({ INBOX: [newsletter] });

    const home = await run(provider);

    // Read from the inbox listing's own labels: no list per filing label.
    expect(provider.getThreadsWithQuery).toHaveBeenCalledTimes(1);
    expect(home.alsoInInbox).toEqual([]);
  });

  it("names the labels Cue files under, so the browser's own inbox can leave filed mail out too", async () => {
    const home = await run(mockProvider({}));

    expect(home.handledLabelIds).toEqual(["Label_Newsletter", "Label_Receipt"]);
  });

  it("names no filing labels when the labels didn't load", async () => {
    const provider = mockProvider({});
    provider.getLabels.mockRejectedValue(new Error("Bad request"));

    const home = await run(provider);

    expect(home.handledLabelIds).toEqual([]);
  });

  it("counts the emails Cue checked and filed since the user's midnight, from its own records", async () => {
    checkedMessages.mockResolvedValue([
      { messageId: "m1" },
      { messageId: "m2" },
      { messageId: "m3" },
    ] as never);
    prisma.executedAction.findMany.mockImplementation((async ({
      where,
    }: {
      where: { type: unknown };
    }) =>
      where.type === "DRAFT_EMAIL"
        ? []
        : [
            filedAction("m1", "ARCHIVE"),
            filedAction("m1", "LABEL", "Label_Newsletter", "Newsletter"),
            filedAction("m2", "ARCHIVE"),
            filedAction("m2", "LABEL", "Label_Newsletter", "Newsletter"),
            // Labelled but left in the inbox: checked, not filed.
            filedAction("m3", "LABEL", "Label_Customer", "Customer"),
          ]) as never);
    const provider = mockProvider({});

    const home = await run(provider);

    expect(home.today).toEqual({
      checked: 3,
      filed: 2,
      filedLabel: { labelId: "Label_Newsletter", name: "Newsletter" },
    });
    // Midnight in Los Angeles, not UTC.
    expect(checkedMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailAccountId: "account-1",
          createdAt: { gte: new Date("2026-10-13T07:00:00Z") },
          // Mail Cue failed to process wasn't checked.
          status: { not: "ERROR" },
        }),
      }),
    );
    // Counted from Cue's records: no extra mailbox reads.
    expect(provider.getThreadsWithQuery).toHaveBeenCalledTimes(1);
  });
});

describe("getHomeData: what's next", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.executedAction.findMany.mockResolvedValue([]);
    prisma.scheduledAction.findMany.mockResolvedValue([]);
    prisma.executedRule.findMany.mockResolvedValue([]);
    checkedMessages.mockResolvedValue([]);
    prisma.executedRule.findFirst.mockResolvedValue({ id: "run-1" } as never);
    prisma.threadTracker.findFirst.mockResolvedValue(null);
    prisma.threadTracker.findMany.mockResolvedValue([]);
    prisma.emailAccount.findUnique.mockResolvedValue({
      user: { aiApiKey: null, premium: null },
      rules: [],
    } as never);
    prisma.mcpConnection.findMany.mockResolvedValue([]);
    prisma.calendarConnection.findMany.mockResolvedValue([]);
    prisma.emailMessage.findMany.mockResolvedValue([]);
    mocks.fetchEvents.mockResolvedValue({ events: [], complete: true });
  });

  it("names the next meeting today, skipping ones that started, all-day items and declined invites", async () => {
    mocks.fetchEvents.mockResolvedValue({
      complete: true,
      events: [
        event("standup", "Standup", "2026-10-13T15:30:00Z"),
        event("offsite", "Offsite", "2026-10-13T00:00:00Z", { allDay: true }),
        event("declined", "Vendor pitch", "2026-10-13T17:00:00Z", {
          declined: true,
        }),
        event("review", "Design review", "2026-10-13T21:00:00Z"),
        event("dinner", "Dinner", "2026-10-14T02:00:00Z"),
      ],
    });

    const home = await run(mockProvider({}));

    expect(home.calendar).toEqual({
      connected: true,
      clearThroughTomorrow: false,
      next: {
        title: "Design review",
        at: "2026-10-13T21:00:00.000Z",
        url: "https://calendar.example.com/review",
        tomorrow: false,
      },
    });
  });

  it("skips a meeting the user declined from another of their addresses", async () => {
    const other = "me@work.example.com";
    mocks.fetchEvents.mockResolvedValue({
      complete: true,
      events: [
        {
          ...event("pitch", "Vendor pitch", "2026-10-13T17:00:00Z"),
          attendees: [{ email: USER }, { email: other, declined: true }],
        },
        event("review", "Design review", "2026-10-13T21:00:00Z"),
      ],
    });

    const home = await getHomeData({
      emailAccountId: "account-1",
      userEmail: USER,
      ownAddresses: [USER, other],
      emailProvider: mockProvider({}),
      logger: createTestLogger(),
      timeZone: TIME_ZONE,
      now: NOW,
    });

    expect(home.calendar.next?.title).toBe("Design review");
    expect(home.nextUp.map((item) => item.title)).toEqual(["Design review"]);
  });

  it("skips a meeting declined from another of the person's calendars", async () => {
    // Events come from every calendar the person connected, so the work
    // calendar's own address declining counts too.
    prisma.calendarConnection.findMany.mockResolvedValue([
      { email: "david@work.example.com" },
    ] as never);
    mocks.fetchEvents.mockResolvedValue({
      complete: true,
      events: [
        {
          ...event("pitch", "Vendor pitch", "2026-10-13T17:00:00Z"),
          attendees: [{ email: "David@work.example.com", declined: true }],
        },
        event("review", "Design review", "2026-10-13T21:00:00Z"),
      ],
    });

    const home = await run(mockProvider({}));

    expect(home.calendar.next?.title).toBe("Design review");
  });

  it("after 5 pm, names how tomorrow starts instead of what's left tonight", async () => {
    // 6:00 PM in Los Angeles.
    const evening = new Date("2026-10-14T01:00:00Z");
    mocks.fetchEvents.mockResolvedValue({
      complete: true,
      events: [
        event("dinner", "Team dinner", "2026-10-14T02:00:00Z"),
        event("sync", "Morning sync", "2026-10-14T16:00:00Z"),
      ],
    });

    const home = await run(mockProvider({}), evening);

    expect(home.calendar.next).toMatchObject({
      title: "Morning sync",
      tomorrow: true,
    });
  });

  it("with today's meetings over, still names how tomorrow starts", async () => {
    // 2:00 PM in Los Angeles; tomorrow's sync, then one the day after.
    const afternoon = new Date("2026-10-13T21:00:00Z");
    mocks.fetchEvents.mockResolvedValue({
      complete: true,
      events: [
        event("later", "Planning", "2026-10-15T16:00:00Z"),
        event("sync", "Morning sync", "2026-10-14T16:00:00Z"),
      ],
    });

    const home = await run(mockProvider({}), afternoon);

    expect(home.calendar.next).toMatchObject({
      title: "Morning sync",
      tomorrow: true,
    });
  });

  it("names no next meeting when nothing is on today or tomorrow", async () => {
    mocks.fetchEvents.mockResolvedValue({
      complete: true,
      events: [event("later", "Planning", "2026-10-15T16:00:00Z")],
    });

    const home = await run(mockProvider({}));

    expect(home.calendar).toEqual({
      connected: true,
      clearThroughTomorrow: true,
      next: null,
    });
  });

  it.each([
    {
      label: "every calendar read in full, with only all-day items",
      result: {
        complete: true,
        events: [
          event("holiday", "Holiday", "2026-10-14T00:00:00Z", { allDay: true }),
        ],
      },
      clear: true,
    },
    {
      label: "only a declined invite",
      result: {
        complete: true,
        events: [
          event("pitch", "Vendor pitch", "2026-10-13T17:00:00Z", {
            declined: true,
          }),
        ],
      },
      clear: true,
    },
    {
      label: "a meeting in progress",
      result: {
        complete: true,
        events: [event("now", "Standup", "2026-10-13T15:45:00Z")],
      },
      clear: false,
    },
    {
      label: "a calendar that failed or was cut short",
      result: { complete: false, events: [] },
      clear: false,
    },
  ])("calls the calendar clear through tomorrow only when it is: $label", async ({
    result,
    clear,
  }) => {
    mocks.fetchEvents.mockResolvedValue(result);

    const home = await run(mockProvider({}));

    expect(home.calendar.clearThroughTomorrow).toBe(clear);
  });

  it("never calls a calendar that couldn't be read clear", async () => {
    mocks.fetchEvents.mockRejectedValue(new Error("Calendar down"));

    const home = await run(mockProvider({}));

    // Still connected, so Today doesn't ask to connect it either.
    expect(home.calendar).toEqual({
      connected: true,
      clearThroughTomorrow: false,
      next: null,
    });
  });

  it.each([
    { label: "an older mailbox", ageMs: 24 * 60 * 60 * 1000, connected: false },
    // Sign-in connects the calendar after it redirects.
    { label: "a mailbox added moments ago", ageMs: 5000, connected: true },
  ])("knows whether a calendar is connected for $label", async ({
    ageMs,
    connected,
  }) => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      user: { aiApiKey: null, premium: null },
      rules: [],
      createdAt: new Date(NOW.getTime() - ageMs),
    } as never);
    mocks.fetchEvents.mockResolvedValue({
      events: [],
      complete: false,
      noCalendarConnected: true,
    });

    const home = await run(mockProvider({}));

    expect(home.calendar).toEqual({
      connected,
      clearThroughTomorrow: false,
      next: null,
    });
  });

  it("merges the next meetings with work due from connected apps, soonest first", async () => {
    mocks.fetchEvents.mockResolvedValue({
      complete: true,
      events: [
        event("review", "Design review", "2026-10-13T21:00:00Z"),
        event("dinner", "Dinner", "2026-10-14T02:00:00Z"),
        event("sync", "Morning sync", "2026-10-14T16:00:00Z"),
      ],
    });
    prisma.mcpConnection.findMany.mockResolvedValue([
      connection("canvas"),
      connection("jira"),
    ] as never);
    mocks.executeTool.mockImplementation(
      async ({ tool }: { tool: string }) => TOOL_RESULTS[tool],
    );

    const home = await run(mockProvider({}));
    const { items } = await deadlines();
    const nextUp = mergeNextUp([home.nextUp, items]);

    // Today itself names the meetings only; the browser merges the rest.
    expect(home.nextUp.every((item) => item.kind === "event")).toBe(true);
    expect(
      nextUp.map(({ kind, title, source }) => [kind, title, source]),
    ).toEqual([
      ["deadline", "Problem set 4", "Canvas"],
      ["event", "Design review", "Calendar"],
      ["event", "Dinner", "Calendar"],
      // Due on a date, not at a time: by the end of the user's day.
      ["deadline", "OPS-12 Rotate keys", "Jira"],
    ]);
    // RD-3: the user's own tasks go to the browser, not the server cache.
    expect(JSON.stringify(vi.mocked(redis.set).mock.calls)).not.toContain(
      "Problem set",
    );
    expect(nextUp[0]).toMatchObject({
      at: "2026-10-13T20:00:00.000Z",
      detail: "Linear Algebra",
      url: "https://school.instructure.com/assignments/4",
    });
    expect(nextUp[3]).toMatchObject({
      allDay: true,
      url: "https://acme.atlassian.net/browse/OPS-12",
    });
    // Connected apps, so nothing to suggest.
    expect(home.suggestion).toBeNull();
  });

  it("answers without waiting on a connected app that takes 2.5 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      prisma.mcpConnection.findMany.mockResolvedValue([
        connection("canvas"),
      ] as never);
      mocks.executeTool.mockImplementation(
        ({ tool }: { tool: string }) =>
          new Promise((resolve) =>
            setTimeout(() => resolve(TOOL_RESULTS[tool]), 2500),
          ),
      );

      const start = Date.now();
      let done = false;
      const pending = run(mockProvider({})).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      while (!done) await vi.advanceTimersByTimeAsync(50);
      await pending;
      const waited = Date.now() - start;

      // 2500 ms before deadlines moved to their own request.
      expect(waited).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves out an app that doesn't answer in time, and shows the rest", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      prisma.mcpConnection.findMany.mockResolvedValue([
        connection("asana"),
        connection("canvas"),
      ] as never);
      mocks.executeTool.mockImplementation(({ tool }: { tool: string }) =>
        tool.startsWith("ASANA_")
          ? new Promise(() => {})
          : Promise.resolve(TOOL_RESULTS[tool]),
      );

      const pending = deadlines();
      await vi.advanceTimersByTimeAsync(10_000);
      const { items } = await pending;

      expect(items.map((item) => item.source)).toEqual(["Canvas"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips an app that is down without a warning, and warns once, without details, about one that is slow", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      prisma.mcpConnection.findMany.mockResolvedValue([
        connection("canvas"),
        connection("asana"),
        connection("jira"),
      ] as never);
      mocks.executeTool.mockImplementation(({ tool }: { tool: string }) => {
        if (tool === "CANVAS_LIST_CALENDAR_EVENTS_FOR_USER")
          return Promise.reject(new AppToolError("canvas", tool, CANVAS_500));
        if (tool.startsWith("ASANA_")) return new Promise(() => {});
        if (tool === "JIRA_SEARCH_ISSUES") return Promise.resolve({});
        return Promise.resolve(TOOL_RESULTS[tool]);
      });

      const pending = deadlines();
      await vi.advanceTimersByTimeAsync(10_000);
      const { items } = await pending;

      expect(items).toEqual([]);
      const lines = warn.mock.calls.map((args) => args.join(" "));
      expect(
        lines.filter((line) => line.includes("Connected app timed out")),
      ).toEqual([
        `[test]: Connected app timed out ${JSON.stringify({ app: "asana", attempts: 1, pauseMinutes: 5 }, null, 2)}`,
      ]);
      const failed = lines.filter((line) =>
        line.includes("Connected app deadlines failed"),
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]).toContain("jira");
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("doesn't ask an app that was too slow again on the next visit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new Map<string, unknown>();
    vi.mocked(redis.get).mockImplementation(
      async (key: string) => (store.get(key) ?? null) as never,
    );
    vi.mocked(redis.set).mockImplementation(async (key, value) => {
      store.set(key as string, value);
      return "OK";
    });
    prisma.mcpConnection.findMany.mockResolvedValue([
      connection("asana"),
    ] as never);
    mocks.executeTool.mockImplementation(() => new Promise(() => {}));

    try {
      for (const _visit of [1, 2]) {
        const pending = deadlines();
        await vi.advanceTimersByTimeAsync(10_000);
        await pending;
      }
    } finally {
      vi.mocked(redis.get).mockImplementation(async () => null);
      vi.mocked(redis.set).mockImplementation(async () => "OK");
      warn.mockRestore();
      vi.useRealTimers();
    }

    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
  });

  it("doesn't ask an app that just failed with its own error again on the next visit", async () => {
    const store = new Map<string, unknown>();
    vi.mocked(redis.get).mockImplementation(
      async (key: string) => (store.get(key) ?? null) as never,
    );
    vi.mocked(redis.set).mockImplementation(async (key, value) => {
      store.set(key as string, value);
      return "OK";
    });
    prisma.mcpConnection.findMany.mockResolvedValue([
      connection("canvas"),
    ] as never);
    mocks.executeTool.mockImplementation(({ tool }: { tool: string }) =>
      tool === "CANVAS_LIST_CALENDAR_EVENTS_FOR_USER"
        ? Promise.reject(new AppToolError("canvas", tool, CANVAS_500))
        : Promise.resolve(TOOL_RESULTS[tool]),
    );

    try {
      await deadlines();
      await deadlines();
    } finally {
      vi.mocked(redis.get).mockImplementation(async () => null);
      vi.mocked(redis.set).mockImplementation(async () => "OK");
    }

    const eventCalls = mocks.executeTool.mock.calls.filter(
      ([{ tool }]) => tool === "CANVAS_LIST_CALENDAR_EVENTS_FOR_USER",
    );
    expect(eventCalls).toHaveLength(1);
  });

  it("doesn't ask an app whose connection needs reconnecting, nor suggest connecting it", async () => {
    prisma.mcpConnection.findMany.mockResolvedValue([
      { ...connection("canvas"), needsReconnectAt: new Date(0) },
    ] as never);
    prisma.emailMessage.findMany.mockResolvedValue([
      { fromDomain: "sfu.instructure.com" },
    ] as never);

    const home = await run(mockProvider({}));
    const { items } = await deadlines();

    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(items).toEqual([]);
    expect(home.suggestion).toBeNull();
  });

  it("marks a connection for reconnecting when the app turns its token away", async () => {
    prisma.mcpConnection.findMany.mockResolvedValue([
      connection("canvas"),
    ] as never);
    mocks.executeTool.mockRejectedValue(
      new ConnectionExpiredError("canvas", "Invalid access token."),
    );

    await deadlines();

    expect(prisma.mcpConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "connection-canvas",
        needsReconnectAt: null,
        updatedAt: { lt: expect.any(Date) },
      },
      data: { needsReconnectAt: expect.any(Date) },
    });
  });

  it("suggests connecting an app the user already gets mail from, by sender domain", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([
      { fromDomain: "sfu.instructure.com" },
    ] as never);

    const home = await run(mockProvider({}));

    expect(home.suggestion).toEqual({ app: "canvas", name: "Canvas" });
  });

  it("suggests nothing when no mail comes from an app Cue can read", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([
      { fromDomain: "example.com" },
    ] as never);

    const home = await run(mockProvider({}));

    expect(home.suggestion).toBeNull();
    expect(home.nextUp).toEqual([]);
  });
});

// As production logged it.
const CANVAS_500 =
  'CANVAS_LIST_CALENDAR_EVENTS_FOR_USER failed: {"errors":[{"message":"An error occurred.","error_code":"internal_server_error"}],"error_report_id":2756288220}';

const TOOL_RESULTS: Record<string, unknown> = {
  CANVAS_GET_CURRENT_USER: { response_data: { id: 7 } },
  CANVAS_LIST_COURSES: { response_data: [{ id: 101 }] },
  CANVAS_LIST_CALENDAR_EVENTS_FOR_USER: {
    response_data: [
      {
        id: 4,
        title: "Problem set 4",
        context_name: "Linear Algebra",
        html_url: "https://school.instructure.com/assignments/4",
        assignment: { due_at: "2026-10-13T20:00:00Z" },
      },
      {
        id: 3,
        title: "Problem set 3",
        context_name: "Linear Algebra",
        assignment: { due_at: "2026-10-10T20:00:00Z" },
      },
    ],
  },
  JIRA_SEARCH_ISSUES: {
    issues: [
      {
        key: "OPS-12",
        self: "https://acme.atlassian.net/rest/api/3/issue/10012",
        fields: { summary: "Rotate keys", duedate: "2026-10-14" },
      },
      {
        key: "OPS-20",
        self: "https://acme.atlassian.net/rest/api/3/issue/10020",
        fields: { summary: "Audit logs", duedate: "2026-10-16" },
      },
    ],
  },
};

function connection(app: string) {
  return {
    id: `connection-${app}`,
    needsReconnectAt: null,
    emailAccountId: "account-1",
    emailAccount: { email: USER },
    integration: { name: app },
  };
}

function event(
  id: string,
  title: string,
  start: string,
  { allDay = false, declined = false } = {},
) {
  const startTime = new Date(start);
  return {
    id,
    title,
    startTime,
    endTime: new Date(startTime.getTime() + 30 * 60_000),
    allDay,
    eventUrl: `https://calendar.example.com/${id}`,
    attendees: [{ email: USER, declined }],
  };
}

function filedAction(
  messageId: string,
  type: string,
  labelId: string | null = null,
  label: string | null = null,
) {
  return { type, labelId, label, executedRule: { messageId } };
}

describe("priorityOf", () => {
  it("is high for an unread email with a deadline, or a customer", () => {
    expect(
      priorityOf({ preview: "Can you send it by Friday?", unread: true }),
    ).toBe("high");
    expect(
      priorityOf({ preview: "Thanks!", unread: false, tag: "VIP Customer" }),
    ).toBe("high");
  });

  it("is medium for other unread mail and low for read mail", () => {
    expect(priorityOf({ preview: "Lunch next week?", unread: true })).toBe(
      "medium",
    );
    expect(priorityOf({ preview: "Lunch next week?", unread: false })).toBe(
      "low",
    );
  });
});

function deadlines(now = NOW) {
  return getDeadlines({
    emailAccountId: "account-1",
    timeZone: TIME_ZONE,
    logger: createTestLogger(),
    now,
  });
}

function run(emailProvider: EmailProvider, now = NOW) {
  return getHomeData({
    emailAccountId: "account-1",
    userEmail: USER,
    emailProvider,
    logger: createTestLogger(),
    timeZone: TIME_ZONE,
    now,
  });
}

function thread(
  id: string,
  {
    from,
    to = USER,
    subject,
    snippet = "",
    labels,
  }: {
    from: string;
    to?: string;
    subject: string;
    snippet?: string;
    labels: string[];
  },
): EmailThread {
  return {
    id,
    snippet,
    messages: [
      {
        ...getMockMessage({
          threadId: id,
          from,
          to,
          subject,
          snippet,
          labelIds: labels,
        }),
        internalDate: String(NOW.getTime()),
      },
    ],
  };
}

/**
 * Returns the threads for whichever label a query asks for. NEEDS_REPLY and
 * AWAITING are Cue's open reply trackers rather than labels.
 */
function mockProvider(threadsByLabel: Record<string, EmailThread[]>) {
  const nameById = new Map(LABELS.map((l) => [l.id, l.name]));
  const threadsById = new Map(
    Object.values(threadsByLabel)
      .flat()
      .map((t) => [t.id, t]),
  );
  prisma.threadTracker.findMany.mockImplementation((async ({
    where,
  }: {
    where: { type: string };
  }) =>
    (threadsByLabel[where.type] ?? []).map((t) => ({
      threadId: t.id,
    }))) as never);
  return {
    getThread: vi.fn(async (threadId: string) => {
      const found = threadsById.get(threadId);
      if (!found) throw new Error("Not found");
      return found;
    }),
    getLabels: vi.fn(async () => LABELS),
    getThreadsWithQuery: vi.fn(
      async ({ query }: { query: { labelIds?: string[] } }) => {
        const labelId = query.labelIds?.find((id) => id !== "INBOX") ?? "INBOX";
        return { threads: threadsByLabel[nameById.get(labelId) ?? ""] ?? [] };
      },
    ),
  } as unknown as EmailProvider & {
    getLabels: ReturnType<typeof vi.fn>;
    getThreadsWithQuery: ReturnType<typeof vi.fn>;
  };
}
