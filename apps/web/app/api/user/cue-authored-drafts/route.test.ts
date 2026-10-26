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
      { followUpDraftId: "r-follow-up" },
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

  it("looks up only the given conversations' drafts, in the user's own account", async () => {
    await read(items(["t1", "m1"], ["t2", "m2"]));

    expect(prisma.executedAction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          executedRule: { emailAccountId, threadId: { in: ["t1", "t2"] } },
        }),
      }),
    );
    expect(prisma.threadTracker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailAccountId,
          threadId: { in: ["t1", "t2"] },
        }),
      }),
    );
    expect(prisma.meeting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ emailAccountId }),
      }),
    );
  });

  it("leaves out a rule's draft once the user has edited it", async () => {
    prisma.executedAction.findMany.mockResolvedValue([
      { draftId: "r-as-written", content: "Sounds good, see you then." },
      { draftId: "r-edited", content: "Sounds good, see you then." },
    ] as never);
    provider.getDraft.mockImplementation(async (draftId: string) =>
      draftId === "r-as-written"
        ? draft("m-as-written", "Sounds good, see you then.")
        : draft("m-edited", "Sounds good, but can we do Friday instead?"),
    );

    expect(
      await read(items(["t1", "m-as-written"], ["t2", "m-edited"])),
    ).toEqual({ messageIds: ["m-as-written"] });
  });

  it("counts a rule's draft with no text kept to compare as Cue's", async () => {
    prisma.executedAction.findMany.mockResolvedValue([
      { draftId: "r-no-content", content: null },
    ] as never);
    provider.getDraft.mockResolvedValue(draft("m1", "Anything at all."));

    expect(await read(items(["t1", "m1"]))).toEqual({ messageIds: ["m1"] });
  });

  it("names nothing for a draft no longer in the mailbox", async () => {
    prisma.threadTracker.findMany.mockResolvedValue([
      { followUpDraftId: "r-gone" },
    ] as never);

    expect(await read(items(["t1", "m1"]))).toEqual({ messageIds: [] });
  });

  it("fails rather than answer when a Cue draft can't be read", async () => {
    prisma.threadTracker.findMany.mockResolvedValue([
      { followUpDraftId: "r-readable" },
      { followUpDraftId: "r-unreadable" },
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
      { followUpDraftId: "r-follow-up" },
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
      { followUpDraftId: "m-follow-up" },
    ] as never);
    prisma.executedAction.findMany.mockResolvedValue([
      { draftId: "m-rule", content: "Sounds good." },
      { draftId: "m-elsewhere", content: "Sounds good." },
    ] as never);
    provider.getDraft.mockResolvedValue(draft("m-rule", "Sounds good."));

    const body = await read(
      items(["c1", "m-follow-up"], ["c2", "m-rule"], ["c3", "m-users-own"]),
    );

    expect(body.messageIds.sort()).toEqual(["m-follow-up", "m-rule"]);
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

async function read(query: string) {
  const response = await GET(request(query), params());
  expect(response.status).toBe(200);
  return response.json();
}

function items(...pairs: [string, string][]) {
  return new URLSearchParams({
    items: pairs.map(([t, m]) => `${t}:${m}`).join(","),
    savedFromMs: "1000",
    savedToMs: "2000",
  }).toString();
}

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
