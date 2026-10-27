import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import prisma from "@/utils/__mocks__/prisma";
import { GET } from "./route";

const createEmailProvider = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => vi.fn());

vi.mock("@/utils/email/provider", () => ({ createEmailProvider }));
vi.mock("@/utils/auth", () => ({ auth: authMock }));
vi.mock("@/utils/prisma");

const emailAccountId = "account-1";
const provider = { name: "google", getDraft: vi.fn() };

describe("GET /api/user/cue-authored-drafts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider.name = "google";
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    createEmailProvider.mockResolvedValue(provider);
    prisma.emailAccount.findUnique.mockResolvedValue({
      userId: "user-1",
      email: "developer@example.com",
      account: { provider: "google" },
    } as never);
    prisma.executedAction.findMany.mockResolvedValue([]);
    prisma.threadTracker.findMany.mockResolvedValue([]);
    prisma.meeting.findMany.mockResolvedValue([]);
    provider.getDraft.mockResolvedValue(null);
  });

  it("names a follow-up or meeting draft by its message's id, not its draft id", async () => {
    prisma.threadTracker.findMany.mockResolvedValue([
      { followUpDraftId: "r-follow-up", threadId: "t1" },
    ] as never);
    prisma.meeting.findMany.mockResolvedValue([
      { followUpDraftId: "r-meeting" },
    ] as never);
    provider.getDraft.mockImplementation(async (draftId: string) =>
      draft(`message-of-${draftId}`, "Following up on this."),
    );

    const body = await read(
      items(["t1", "message-of-r-follow-up"], ["t2", "message-of-r-meeting"]),
    );

    expect(body.messageIds.sort()).toEqual([
      "message-of-r-follow-up",
      "message-of-r-meeting",
    ]);
  });

  it("looks up only the given Gmail conversations' drafts, in the user's own account", async () => {
    await read(items(["t1", "m1"], ["t2", "m2"]));

    expect(prisma.executedAction.findMany.mock.calls[0][0]?.where).toEqual({
      executedRule: { emailAccountId, threadId: { in: ["t1", "t2"] } },
      type: "DRAFT_EMAIL",
      draftId: { not: null },
    });
    expect(prisma.threadTracker.findMany.mock.calls[0][0]?.where).toEqual({
      emailAccountId,
      threadId: { in: ["t1", "t2"] },
      followUpDraftId: { not: null },
    });
    expect(prisma.meeting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ emailAccountId }),
      }),
    );
  });

  it("leaves out a rule's draft once the user has edited it", async () => {
    prisma.executedAction.findMany.mockResolvedValue([
      ruleDraft("r-as-written", "t1", "Sounds good, see you then."),
      ruleDraft("r-edited", "t2", "Sounds good, see you then."),
    ] as never);
    provider.getDraft.mockImplementation(async (draftId: string) =>
      draftId === "r-as-written"
        ? draft("m-as-written", "Sounds good, see you then.")
        : draft("m-edited", "Sounds good, but can we do Friday instead?"),
    );

    expect(
      await read(items(["t1", "m-as-written"], ["t2", "m-edited"])),
    ).toEqual({
      messageIds: ["m-as-written"],
      checkedMessageIds: ["m-as-written", "m-edited"],
    });
  });

  it("counts a rule's draft with no text kept to compare as Cue's", async () => {
    prisma.executedAction.findMany.mockResolvedValue([
      ruleDraft("r-no-content", "t1", null),
    ] as never);
    provider.getDraft.mockResolvedValue(draft("m1", "Anything at all."));

    expect(await read(items(["t1", "m1"]))).toEqual({
      messageIds: ["m1"],
      checkedMessageIds: ["m1"],
    });
  });

  it("names nothing for a draft no longer in the mailbox", async () => {
    prisma.threadTracker.findMany.mockResolvedValue([
      { followUpDraftId: "r-gone", threadId: "t1" },
    ] as never);

    expect(await read(items(["t1", "m1"]))).toEqual({
      messageIds: [],
      checkedMessageIds: ["m1"],
    });
  });

  it("fails rather than answer when a Cue draft can't be read", async () => {
    prisma.threadTracker.findMany.mockResolvedValue([
      { followUpDraftId: "r-readable", threadId: "t1" },
      { followUpDraftId: "r-unreadable", threadId: "t1" },
    ] as never);
    provider.getDraft.mockImplementation(async (draftId: string) => {
      if (draftId === "r-unreadable") throw new Error("unavailable");
      return draft("m1", "Following up.");
    });

    const response = await GET(request(items(["t1", "m1"])), params());

    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  it("defers with a retry time when the Gmail gate defers a read", async () => {
    prisma.threadTracker.findMany.mockResolvedValue([
      { followUpDraftId: "r-follow-up", threadId: "t1" },
    ] as never);
    provider.getDraft.mockRejectedValue(
      new GmailCallDeferredError(5000, "background", "per_minute_budget"),
    );

    const response = await GET(request(items(["t1", "m1"])), params());

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
  });

  it("names an Outlook draft by its own id without reading it, unless its text needs comparing", async () => {
    provider.name = "microsoft";
    prisma.emailAccount.findUnique.mockResolvedValue({
      userId: "user-1",
      email: "developer@example.com",
      account: { provider: "microsoft" },
    } as never);
    prisma.threadTracker.findMany.mockResolvedValue([
      { followUpDraftId: "m-follow-up", threadId: "c1" },
    ] as never);
    prisma.executedAction.findMany.mockResolvedValue([
      ruleDraft("m-rule", "c2", "Sounds good."),
      ruleDraft("m-elsewhere", "c4", "Sounds good."),
    ] as never);
    provider.getDraft.mockResolvedValue(draft("m-rule", "Sounds good."));

    const body = await read(
      items(["c1", "m-follow-up"], ["c2", "m-rule"], ["c3", "m-users-own"]),
    );

    expect(body.messageIds.sort()).toEqual(["m-follow-up", "m-rule"]);
    expect(body.checkedMessageIds).toHaveLength(3);
    expect(provider.getDraft).toHaveBeenCalledTimes(1);
    expect(provider.getDraft).toHaveBeenCalledWith("m-rule");
  });

  it("isn't cached", async () => {
    const response = await GET(request(items(["t1", "m1"])), params());

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses an account that isn't the user's", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(null);

    const response = await GET(request(items(["t1", "m1"])), params());

    expect(response.status).toBe(403);
    expect(prisma.threadTracker.findMany).not.toHaveBeenCalled();
    expect(provider.getDraft).not.toHaveBeenCalled();
  });

  it("only reads the mailbox for a signed-in user", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET(request(items(["t1", "m1"])), params());

    expect(response.status).toBe(401);
    expect(provider.getDraft).not.toHaveBeenCalled();
  });

  it("reads a Gmail meeting draft only if Cue started it within ten minutes of a given draft's save", async () => {
    const year = 365 * 24 * 60 * 60_000;
    const recent = 2 * year;
    prisma.meeting.findMany.mockImplementation(
      meetingsWhere([
        { followUpDraftId: "r-near", startedAtMs: recent - 5 * 60_000 },
        { followUpDraftId: "r-late", startedAtMs: recent - 11 * 60_000 },
        // Between two drafts saved a year apart: no draft's window holds it.
        { followUpDraftId: "r-between", startedAtMs: year * 1.5 },
      ]) as never,
    );
    provider.getDraft.mockImplementation(async (draftId: string) =>
      draft(`message-of-${draftId}`, "Thanks for meeting."),
    );

    const body = await read(
      query([
        ["t1", "message-of-r-near", recent],
        ["t2", "message-of-r-late", year],
        ["t3", "message-of-r-between", year],
      ]),
    );

    expect(body.messageIds).toEqual(["message-of-r-near"]);
    expect(provider.getDraft).toHaveBeenCalledTimes(1);
    const where = prisma.meeting.findMany.mock.calls[0][0]
      ?.where as MeetingWhere;
    // A year apart, the two saves look up two narrow windows, not one wide one.
    expect(where.OR).toHaveLength(2);
    // No meeting starting after the newest save's window can match.
    expect(where.startTime?.lte).toEqual(new Date(recent + 10 * 60_000));
  });

  it("names an Outlook meeting draft by its id, edited or not, without reading it", async () => {
    provider.name = "microsoft";
    prisma.emailAccount.findUnique.mockResolvedValue({
      userId: "user-1",
      email: "developer@example.com",
      account: { provider: "microsoft" },
    } as never);
    prisma.meeting.findMany.mockImplementation(
      meetingsWhere([
        { followUpDraftId: "m-meeting", startedAtMs: 0 },
        { followUpDraftId: "m-other-meeting", startedAtMs: 0 },
      ]) as never,
    );

    const body = await read(items(["c1", "m-meeting"], ["c2", "m-users-own"]));

    expect(body.messageIds).toEqual(["m-meeting"]);
    expect(provider.getDraft).not.toHaveBeenCalled();
  });

  it("fails without reading the mailbox when there are more meeting drafts than one request reads", async () => {
    prisma.meeting.findMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, i) => ({
        followUpDraftId: `r${i}`,
      })) as never,
    );

    const response = await GET(request(items(["t1", "m1"])), params());

    expect(response.status).toBe(409);
    expect(provider.getDraft).not.toHaveBeenCalled();
  });

  it("answers for the newest conversations when old drafts of Cue's in the rest are more than one request reads", async () => {
    // Twenty conversations, each with three of Cue's drafts from before
    // replies became suggestions, all since sent or deleted.
    const threads = Array.from({ length: 20 }, (_, i) => `t${i}`);
    prisma.executedAction.findMany.mockResolvedValue(
      threads.flatMap((threadId) =>
        [1, 2, 3].map((n) =>
          ruleDraft(`r-${threadId}-${n}`, threadId, "Sounds good."),
        ),
      ) as never,
    );

    // t0 was saved most recently.
    const body = await read(
      query(
        threads.map((t, i) => [t, `m-${t}`, 100_000 - i] as const),
        PARTIAL,
      ),
    );

    expect(provider.getDraft.mock.calls.length).toBeLessThanOrEqual(40);
    expect(body.messageIds).toEqual([]);
    // Only whole conversations, newest first, as many as the reads allow.
    expect(body.checkedMessageIds).toEqual(
      threads.slice(0, 13).map((t) => `m-${t}`),
    );
  });

  it("never says it checked a draft whose conversation's drafts of Cue's it didn't read", async () => {
    prisma.executedAction.findMany.mockResolvedValue([
      ...Array.from({ length: 41 }, (_, i) =>
        ruleDraft(`r-old-${i}`, "t-crowded", "Sounds good."),
      ),
      ruleDraft("r-cue", "t-crowded", "Sounds good."),
    ] as never);
    provider.getDraft.mockImplementation(async (draftId: string) =>
      draftId === "r-cue" ? draft("m-cue", "Sounds good.") : null,
    );

    const body = await read(
      query(
        [
          ["t-crowded", "m-cue", 2000],
          ["t-quiet", "m-users-own", 1000],
        ],
        PARTIAL,
      ),
    );

    expect(body.checkedMessageIds).toEqual(["m-users-own"]);
    expect(body.messageIds).toEqual([]);
    expect(provider.getDraft).not.toHaveBeenCalled();
  });

  it("fails as before, without reading the mailbox, when a client that doesn't take a partial answer asks about more than one request reads", async () => {
    // A tab from before partial answers counts every draft in a 200 as
    // checked.
    prisma.executedAction.findMany.mockResolvedValue(
      Array.from({ length: 41 }, (_, i) =>
        ruleDraft(`r-old-${i}`, "t-crowded", "Sounds good."),
      ) as never,
    );

    const response = await GET(
      request(
        query([
          ["t-crowded", "m-cue", 2000],
          ["t-quiet", "m-users-own", 1000],
        ]),
      ),
      params(),
    );

    expect(response.status).toBe(409);
    expect(provider.getDraft).not.toHaveBeenCalled();
  });

  it("answers in full for a client that doesn't take a partial answer when every draft fits", async () => {
    prisma.executedAction.findMany.mockResolvedValue([
      ruleDraft("r-cue", "t1", "Sounds good."),
    ] as never);
    provider.getDraft.mockResolvedValue(draft("m-cue", "Sounds good."));

    expect(await read(items(["t1", "m-cue"], ["t2", "m-users-own"]))).toEqual({
      messageIds: ["m-cue"],
      checkedMessageIds: ["m-cue", "m-users-own"],
    });
  });

  it("reads an Outlook rule's draft for the draft with its id, whatever conversation the rule recorded", async () => {
    provider.name = "microsoft";
    prisma.emailAccount.findUnique.mockResolvedValue({
      userId: "user-1",
      email: "developer@example.com",
      account: { provider: "microsoft" },
    } as never);
    // The rule ran in a conversation id Outlook has since changed.
    prisma.executedAction.findMany.mockResolvedValue([
      ruleDraft("m-rule", "c-recorded", "Sounds good."),
    ] as never);
    provider.getDraft.mockResolvedValue(draft("m-rule", "Sounds good."));

    const body = await read(query([["c-current", "m-rule", 1500]], PARTIAL));

    expect(body.messageIds).toEqual(["m-rule"]);
    expect(provider.getDraft).toHaveBeenCalledWith("m-rule");
    // Looked up by draft id alone: a lookup scoped to the current
    // conversation would miss the rule's row and count the draft as checked.
    expect(prisma.executedAction.findMany.mock.calls[0][0]?.where).toEqual({
      executedRule: { emailAccountId },
      type: "DRAFT_EMAIL",
      draftId: { in: ["m-rule"] },
    });
    expect(prisma.threadTracker.findMany.mock.calls[0][0]?.where).toEqual({
      emailAccountId,
      followUpDraftId: { in: ["m-rule"] },
    });
  });

  it("fails without reading the mailbox when the lookup has more rows than it reads", async () => {
    prisma.executedAction.findMany.mockResolvedValue(
      Array.from({ length: 401 }, (_, i) =>
        ruleDraft(`r${i}`, "t1", "Sounds good."),
      ) as never,
    );

    const response = await GET(request(items(["t1", "m1"])), params());

    expect(response.status).toBe(409);
    expect(provider.getDraft).not.toHaveBeenCalled();
  });

  it("splits each item at its last colon", async () => {
    await read(items(["conversation:with:colons", "m1"]));

    expect(prisma.threadTracker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: { in: ["conversation:with:colons"] },
        }),
      }),
    );
  });

  it.each([
    ["an item with no colon", { items: "t1m1" }],
    ["an item with no conversation", { items: ":m1" }],
    ["an item with no message", { items: "t1:" }],
    ["no savedAtMs", { savedAtMs: null }],
    ["a savedAtMs per item missing", { savedAtMs: "1500" }],
    ["more savedAtMs than items", { savedAtMs: "1500,1500,1500" }],
    ["a non-numeric savedAtMs", { savedAtMs: "1500,soon" }],
    ["a negative savedAtMs", { savedAtMs: "1500,-1" }],
  ])("rejects %s", async (_, overrides) => {
    const response = await GET(
      request(
        query(
          [
            ["t1", "m1", 1500],
            ["t2", "m2", 1500],
          ],
          overrides,
        ),
      ),
      params(),
    );

    expect(response.status).toBe(400);
    expect(provider.getDraft).not.toHaveBeenCalled();
  });

  it("rejects more drafts than the lane reads", async () => {
    const many = Array.from(
      { length: 21 },
      (_, i) => [`t${i}`, `m${i}`] as [string, string],
    );

    const response = await GET(request(items(...many)), params());

    expect(response.status).toBe(400);
    expect(provider.getDraft).not.toHaveBeenCalled();
  });
});

const PARTIAL = { partial: "1" };

async function read(query: string) {
  const response = await GET(request(query), params());
  expect(response.status).toBe(200);
  return response.json();
}

function items(...pairs: [string, string][]) {
  return query(pairs.map(([t, m]) => [t, m, 1500]));
}

function query(
  drafts: (readonly [string, string, number])[],
  overrides: Record<string, string | null> = {},
) {
  const params = new URLSearchParams({
    items: drafts.map(([t, m]) => `${t}:${m}`).join(","),
    savedAtMs: drafts.map(([, , at]) => at).join(","),
  });
  for (const [key, value] of Object.entries(overrides))
    if (value === null) params.delete(key);
    else params.set(key, value);
  return params.toString();
}

function ruleDraft(draftId: string, threadId: string, content: string | null) {
  return { draftId, content, executedRule: { threadId } };
}

/** Meetings as the database would answer the route's lookup. */
function meetingsWhere(
  meetings: { followUpDraftId: string; startedAtMs: number }[],
) {
  return async ({ where }: { where: MeetingWhere }) =>
    meetings
      .filter(({ followUpDraftId, startedAtMs }) => {
        if (where.followUpDraftId.in)
          return where.followUpDraftId.in.includes(followUpDraftId);
        return (where.OR ?? []).some(
          ({ followUpDraftStartedAt: { gte, lte } }) =>
            startedAtMs >= gte.getTime() && startedAtMs <= lte.getTime(),
        );
      })
      .map(({ followUpDraftId }) => ({ followUpDraftId }));
}

type MeetingWhere = {
  followUpDraftId: { in?: string[] };
  startTime?: { lte: Date };
  OR?: { followUpDraftStartedAt: { gte: Date; lte: Date } }[];
};

function params() {
  return { params: Promise.resolve({}) };
}

function request(query: string) {
  return new NextRequest(
    `http://127.0.0.1/api/user/cue-authored-drafts?${query}`,
    {
      headers: {
        cookie: "better-auth.session_token=session",
        [EMAIL_ACCOUNT_HEADER]: emailAccountId,
      },
    },
  );
}

function draft(id: string, text: string) {
  return {
    id,
    threadId: `thread-${id}`,
    textPlain: text,
    textHtml: `<p>${text}</p>`,
    headers: {},
    inline: [],
    attachments: [],
    snippet: text,
  };
}
