import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import { getHomeData, priorityOf } from "./get-home";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const USER = "david@example.com";
const NOW = new Date("2026-10-13T16:00:00Z");
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
    prisma.executedAction.findMany.mockResolvedValue([]);
    prisma.scheduledAction.findMany.mockResolvedValue([]);
    prisma.executedRule.findMany.mockResolvedValue([]);
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

  it("says where filed mail went, per label", async () => {
    const provider = mockProvider({
      Newsletter: [
        thread("n1", {
          from: "News <n@x.com>",
          subject: "Weekly",
          labels: ["Label_Newsletter"],
        }),
      ],
    });

    const home = await run(provider);

    expect(home.handledLabels).toEqual([
      { labelId: "Label_Newsletter", name: "Newsletter", count: 1 },
    ]);
  });
});

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

function run(emailProvider: EmailProvider) {
  return getHomeData({
    emailAccountId: "account-1",
    userEmail: USER,
    emailProvider,
    logger: createTestLogger(),
    now: NOW,
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
