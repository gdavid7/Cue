import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import { getHomeData, priorityOf } from "./get-home";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({
  redis: { get: vi.fn(async () => null), set: vi.fn(async () => "OK") },
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

  it("counts filed mail once even when it has several handled labels", async () => {
    const receipt = thread("venmo", {
      from: "Venmo <venmo@venmo.com>",
      subject: "You paid",
      labels: ["Label_Receipt", "Label_Newsletter"],
    });
    const provider = mockProvider({
      Newsletter: [receipt],
      Receipt: [receipt],
    });

    const home = await run(provider);

    expect(home.handled.map((t) => t.threadId)).toEqual(["venmo"]);
    expect(home.stats).toMatchObject({ handled: 1 });
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
        title: "Reply draft: Renewal",
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
    const provider = mockProvider({
      Newsletter: [newsletter],
      INBOX: [newsletter],
    });

    const home = await run(provider);

    expect(home.handled.map((t) => t.threadId)).toEqual(["weekly"]);
    expect(home.alsoInInbox).toEqual([]);
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
        where: {
          emailAccountId: "account-1",
          createdAt: { gte: new Date("2026-10-13T07:00:00Z") },
        },
      }),
    );
    // Counted from Cue's records: no extra mailbox reads.
    expect(provider.getThreadsWithQuery).toHaveBeenCalledTimes(3);
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
      next: {
        title: "Design review",
        at: "2026-10-13T21:00:00.000Z",
        url: "https://calendar.example.com/review",
        tomorrow: false,
      },
    });
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

  it("knows when no calendar is connected", async () => {
    mocks.fetchEvents.mockResolvedValue({
      events: [],
      complete: false,
      noCalendarConnected: true,
    });

    const home = await run(mockProvider({}));

    expect(home.calendar).toEqual({ connected: false, next: null });
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

    expect(
      home.nextUp.map(({ kind, title, source }) => [kind, title, source]),
    ).toEqual([
      ["deadline", "Problem set 4", "Canvas"],
      ["event", "Design review", "Calendar"],
      ["event", "Dinner", "Calendar"],
      // Due on a date, not at a time: by the end of the user's day.
      ["deadline", "OPS-12 Rotate keys", "Jira"],
    ]);
    expect(home.nextUp[0]).toMatchObject({
      at: "2026-10-13T20:00:00.000Z",
      detail: "Linear Algebra",
      url: "https://school.instructure.com/assignments/4",
    });
    expect(home.nextUp[3]).toMatchObject({
      allDay: true,
      url: "https://acme.atlassian.net/browse/OPS-12",
    });
    // Connected apps, so nothing to suggest.
    expect(home.suggestion).toBeNull();
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

      const pending = run(mockProvider({}));
      await vi.advanceTimersByTimeAsync(10_000);
      const home = await pending;

      expect(home.nextUp.map((item) => item.source)).toEqual(["Canvas"]);
    } finally {
      vi.useRealTimers();
    }
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
