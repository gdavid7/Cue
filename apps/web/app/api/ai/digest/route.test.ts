vi.mock("server-only", () => ({}));

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWithErrorTestMiddleware,
  getEmailAccount,
} from "@/__tests__/helpers";
import { POST } from "./route";
import prisma from "@/utils/__mocks__/prisma";
import { GmailCallDeferredError } from "@/utils/gmail/quota";

const {
  mockAiSummarizeEmailForDigest,
  mockCheckHasAccess,
  mockGetEmailAccountWithAi,
  mockReserveDigestSummarySlot,
  mockGetMessage,
  mockReleaseDigestSummarySlot,
  mockPublishToQstashAt,
} = vi.hoisted(() => ({
  mockReleaseDigestSummarySlot: vi.fn(),
  mockPublishToQstashAt: vi.fn(),
  mockGetMessage: vi.fn(),
  mockAiSummarizeEmailForDigest: vi.fn(),
  mockCheckHasAccess: vi.fn(),
  mockGetEmailAccountWithAi: vi.fn(),
  mockReserveDigestSummarySlot: vi.fn(),
}));

vi.mock("@/utils/prisma");

vi.mock("@/env", () => ({
  env: {
    DIGEST_MAX_SUMMARIES_PER_24H: 50,
    RESEND_FROM_EMAIL: "digest@example.com",
  },
}));

vi.mock("@/utils/middleware", () => createWithErrorTestMiddleware());

vi.mock("@/utils/qstash", () => ({
  withQstashOrInternal: (handler: unknown) => handler,
}));

vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAi: mockGetEmailAccountWithAi,
}));

vi.mock("@/utils/premium/server", () => ({
  checkHasAccess: mockCheckHasAccess,
}));

vi.mock("@/utils/digest/summary-limit", () => ({
  reserveDigestSummarySlot: mockReserveDigestSummarySlot,
  releaseDigestSummarySlot: mockReleaseDigestSummarySlot,
}));

vi.mock("@/utils/upstash", () => ({
  publishToQstashAt: mockPublishToQstashAt,
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi
    .fn()
    .mockResolvedValue({ getMessage: mockGetMessage }),
}));

vi.mock("@/utils/ai/digest/summarize-email-for-digest", () => ({
  aiSummarizeEmailForDigest: mockAiSummarizeEmailForDigest,
}));

describe("digest route action ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetEmailAccountWithAi.mockResolvedValue({
      ...getEmailAccount(),
      id: "account-a",
      userId: "user-a",
    });
    mockCheckHasAccess.mockResolvedValue(true);
    mockReleaseDigestSummarySlot.mockResolvedValue(undefined);
    mockReserveDigestSummarySlot.mockResolvedValue({
      reserved: true,
      reservationId: null,
      reservationSource: null,
    });
    mockAiSummarizeEmailForDigest.mockResolvedValue({
      content: "Summarized",
    });
    prisma.digest.findFirst.mockResolvedValue({
      id: "digest-a",
      items: [],
    } as unknown as Awaited<ReturnType<typeof prisma.digest.findFirst>>);
    mockGetMessage.mockResolvedValue({
      id: "message-1",
      threadId: "thread-1",
      headers: {
        from: "sender@example.com",
        to: "user@example.com",
        subject: "Important update",
      },
      textPlain: "Please summarize this.",
      snippet: "",
    });
  });

  it.each([
    "foreign-action-id",
    "missing-action-id",
  ])("skips %s without summarizing or reserving quota", async (actionId) => {
    prisma.executedAction.findFirst.mockResolvedValue(null);
    const response = await POST(createRequest(actionId));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(prisma.executedAction.findFirst).toHaveBeenCalledWith({
      where: {
        id: actionId,
        executedRule: {
          emailAccountId: "account-a",
        },
      },
      select: {
        executedRule: {
          select: {
            rule: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });
    expect(mockAiSummarizeEmailForDigest).not.toHaveBeenCalled();
    expect(mockReserveDigestSummarySlot).not.toHaveBeenCalled();
    expect(prisma.digestItem.upsert).not.toHaveBeenCalled();
  });

  it("summarizes and stores an action belonging to the requested account", async () => {
    prisma.executedAction.findFirst.mockResolvedValue({
      executedRule: { rule: { name: "Newsletters" } },
    } as unknown as Awaited<
      ReturnType<typeof prisma.executedAction.findFirst>
    >);
    prisma.digest.findFirst.mockResolvedValue({
      id: "digest-a",
      items: [],
    } as unknown as Awaited<ReturnType<typeof prisma.digest.findFirst>>);

    const response = await POST(createRequest("owned-action-id"));

    expect(response.status).toBe(200);
    expect(mockAiSummarizeEmailForDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleName: "Newsletters",
        emailAccount: expect.objectContaining({ id: "account-a" }),
      }),
    );
    expect(mockReserveDigestSummarySlot).toHaveBeenCalledWith({
      emailAccountId: "account-a",
      maxSummariesPer24h: 50,
    });
    expect(prisma.digestItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          digestId: "digest-a",
          actionId: "owned-action-id",
          messageId: "message-1",
          threadId: "thread-1",
          content: JSON.stringify({ content: "Summarized" }),
        },
      }),
    );
  });

  it("reads the message from the mailbox, since the job only names it", async () => {
    prisma.executedAction.findFirst.mockResolvedValue({
      executedRule: { rule: { name: "Newsletters" } },
    } as unknown as Awaited<
      ReturnType<typeof prisma.executedAction.findFirst>
    >);

    const response = await POST(createRequest("owned-action-id"));

    expect(response.status).toBe(200);
    expect(mockGetMessage).toHaveBeenCalledWith("message-1");
    expect(mockAiSummarizeEmailForDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        messageToSummarize: {
          id: "message-1",
          threadId: "thread-1",
          from: "sender@example.com",
          to: "user@example.com",
          subject: "Important update",
          content: "Please summarize this.",
        },
      }),
    );
  });

  it("resumes the job after a Gmail quota deferral instead of failing it", async () => {
    prisma.executedAction.findFirst.mockResolvedValue({
      executedRule: { rule: { name: "Newsletters" } },
    } as unknown as Awaited<
      ReturnType<typeof prisma.executedAction.findFirst>
    >);
    mockReserveDigestSummarySlot.mockResolvedValue({
      reserved: true,
      reservationId: "reservation-1",
      reservationSource: "redis",
    });
    mockGetMessage.mockRejectedValue(
      new GmailCallDeferredError(30_000, "sync"),
    );
    mockPublishToQstashAt.mockResolvedValue(true);

    const response = await POST(createRequest("owned-action-id"));

    expect(response.status).toBe(200);
    expect(mockPublishToQstashAt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/ai/digest",
        body: {
          emailAccountId: "account-a",
          actionId: "owned-action-id",
          messageId: "message-1",
          threadId: "thread-1",
          deferrals: 1,
        },
        deduplicationId: "digest-account-a-message-1-1",
      }),
    );
    expect(mockAiSummarizeEmailForDigest).not.toHaveBeenCalled();
    // The slot is handed back, so the resumed run can take it again.
    expect(mockReleaseDigestSummarySlot).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "reservation-1" }),
    );
  });

  it("asks the transport to retry a deferral it cannot schedule", async () => {
    prisma.executedAction.findFirst.mockResolvedValue({
      executedRule: { rule: { name: "Newsletters" } },
    } as unknown as Awaited<
      ReturnType<typeof prisma.executedAction.findFirst>
    >);
    mockGetMessage.mockRejectedValue(
      new GmailCallDeferredError(30_000, "sync"),
    );
    mockPublishToQstashAt.mockResolvedValue(false);

    const response = await POST(createRequest("owned-action-id"));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("reserves the daily summary slot before reading the mailbox and returns it on a skip", async () => {
    prisma.executedAction.findFirst.mockResolvedValue({
      executedRule: { rule: { name: "Newsletters" } },
    } as unknown as Awaited<
      ReturnType<typeof prisma.executedAction.findFirst>
    >);
    mockReserveDigestSummarySlot.mockResolvedValue({
      reserved: false,
      reservationId: null,
      reservationSource: null,
    });

    const capped = await POST(createRequest("owned-action-id"));
    expect(capped.status).toBe(200);
    expect(mockGetMessage).not.toHaveBeenCalled();

    mockReserveDigestSummarySlot.mockResolvedValue({
      reserved: true,
      reservationId: "reservation-1",
      reservationSource: "redis",
    });
    mockGetMessage.mockResolvedValue({
      id: "message-1",
      threadId: "thread-1",
      headers: {
        from: "digest@example.com",
        to: "user@example.com",
        subject: "Your digest",
      },
      textPlain: "Digest",
      snippet: "",
    });

    const fromUs = await POST(createRequest("owned-action-id"));
    expect(fromUs.status).toBe(200);
    expect(mockAiSummarizeEmailForDigest).not.toHaveBeenCalled();
    expect(mockReleaseDigestSummarySlot).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "reservation-1" }),
    );
  });

  it("skips a message deleted while the job waited", async () => {
    prisma.executedAction.findFirst.mockResolvedValue({
      executedRule: { rule: { name: "Newsletters" } },
    } as unknown as Awaited<
      ReturnType<typeof prisma.executedAction.findFirst>
    >);
    mockGetMessage.mockRejectedValue(
      new Error("Requested entity was not found."),
    );

    const response = await POST(createRequest("owned-action-id"));

    expect(response.status).toBe(200);
    expect(mockAiSummarizeEmailForDigest).not.toHaveBeenCalled();
  });

  it("still handles a job queued with the message itself, reading it by id", async () => {
    prisma.executedAction.findFirst.mockResolvedValue({
      executedRule: { rule: { name: "Newsletters" } },
    } as unknown as Awaited<
      ReturnType<typeof prisma.executedAction.findFirst>
    >);

    const response = await POST(
      new NextRequest("http://localhost:3000/api/ai/digest", {
        method: "POST",
        body: JSON.stringify({
          emailAccountId: "account-a",
          actionId: "owned-action-id",
          message: {
            id: "message-1",
            threadId: "thread-1",
            from: "sender@example.com",
            to: "user@example.com",
            subject: "Important update",
            content: "Please summarize this.",
          },
        }),
      }) as Parameters<typeof POST>[0],
    );

    expect(response.status).toBe(200);
    expect(mockGetMessage).toHaveBeenCalledWith("message-1");
    expect(mockAiSummarizeEmailForDigest).toHaveBeenCalled();
  });
});

function createRequest(actionId: string) {
  return new NextRequest("http://localhost:3000/api/ai/digest", {
    method: "POST",
    body: JSON.stringify({
      emailAccountId: "account-a",
      actionId,
      messageId: "message-1",
      threadId: "thread-1",
    }),
  }) as Parameters<typeof POST>[0];
}
