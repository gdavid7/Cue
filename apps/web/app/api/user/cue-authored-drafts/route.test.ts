import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import prisma from "@/utils/__mocks__/prisma";
import { GET } from "./route";

const createEmailProvider = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => vi.fn());

vi.mock("@/utils/email/provider", () => ({ createEmailProvider }));
vi.mock("@/utils/auth", () => ({ auth: authMock }));
vi.mock("@/utils/prisma");

const emailAccountId = "account-1";
const provider = { getDraft: vi.fn() };

describe("GET /api/user/cue-authored-drafts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(await read()).toEqual({
      messageIds: ["message-of-r-follow-up", "message-of-r-meeting"],
    });
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

    expect(await read()).toEqual({ messageIds: ["m-as-written"] });
  });

  it("names nothing for a draft no longer in the mailbox", async () => {
    prisma.threadTracker.findMany.mockResolvedValue([
      { followUpDraftId: "r-gone" },
    ] as never);

    expect(await read()).toEqual({ messageIds: [] });
  });

  it("leaves a draft it couldn't read out by its own id", async () => {
    prisma.meeting.findMany.mockResolvedValue([
      { followUpDraftId: "outlook-message-id" },
    ] as never);
    provider.getDraft.mockRejectedValue(new Error("unavailable"));

    expect(await read()).toEqual({ messageIds: ["outlook-message-id"] });
  });

  it("only reads the mailbox for the user's own account", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(401);
    expect(provider.getDraft).not.toHaveBeenCalled();
  });
});

async function read() {
  const response = await GET(request(), { params: Promise.resolve({}) });
  expect(response.status).toBe(200);
  return response.json();
}

function request() {
  return new NextRequest("http://127.0.0.1/api/user/cue-authored-drafts", {
    headers: {
      cookie: "better-auth.session_token=session",
      [EMAIL_ACCOUNT_HEADER]: emailAccountId,
    },
  });
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
