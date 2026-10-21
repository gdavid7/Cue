import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewsletterStatus } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import { runQueuedSenderArchive } from "@/utils/senders/archive-existing";
import { POST } from "./route";

vi.mock("@/utils/prisma");
vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithErrorTestMiddleware();
});
// Stands in for QStash signature or internal key verification.
vi.mock("@/utils/qstash", () => ({
  withQstashOrInternal:
    (handler: (...args: unknown[]) => unknown) =>
    (request: Request, ...rest: unknown[]) =>
      request.headers.get("x-test-verified")
        ? handler(request, ...rest)
        : new Response("Unauthorized", { status: 401 }),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn().mockResolvedValue({ name: "google" }),
}));
vi.mock("@/utils/senders/archive-existing", () => ({
  runQueuedSenderArchive: vi.fn(),
}));

describe("queued sender archive resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.newsletter.findFirst.mockResolvedValue({
      email: "news@example.com",
      status: NewsletterStatus.AUTO_ARCHIVED,
    } as never);
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "user@example.com",
    } as never);
  });

  it("resumes the archive with its start time and deferral count", async () => {
    const response = await POST(resume(), {} as never);

    expect(response.status).toBe(200);
    expect(prisma.newsletter.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sender-1", emailAccountId: "account-1" },
      }),
    );
    expect(createEmailProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "account-1",
        provider: "google",
      }),
    );
    expect(runQueuedSenderArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "account-1",
        senderEmail: "news@example.com",
        ownerEmail: "user@example.com",
        startedAt: 1_700_000_000_000,
        deferrals: 2,
      }),
    );
  });

  it("still resumes a job queued with the sender's address before ids", async () => {
    const response = await POST(
      resume({
        body: {
          emailAccountId: "account-1",
          provider: "google",
          senderEmail: "news@example.com",
          ownerEmail: "user@example.com",
          startedAt: 1_700_000_000_000,
          deferrals: 2,
        },
      }),
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(runQueuedSenderArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        senderEmail: "news@example.com",
        ownerEmail: "user@example.com",
      }),
    );
  });

  it("leaves the mail alone once the sender is no longer auto-archived", async () => {
    prisma.newsletter.findFirst.mockResolvedValue({
      status: NewsletterStatus.APPROVED,
    } as never);

    const response = await POST(resume(), {} as never);

    expect(response.status).toBe(200);
    expect(runQueuedSenderArchive).not.toHaveBeenCalled();
  });

  it("refuses a request that is neither signed nor internal", async () => {
    const response = await POST(resume({ verified: false }), {} as never);

    expect(response.status).toBe(401);
    expect(runQueuedSenderArchive).not.toHaveBeenCalled();
  });
});

function resume({
  verified = true,
  body = {
    emailAccountId: "account-1",
    provider: "google",
    newsletterId: "sender-1",
    startedAt: 1_700_000_000_000,
    deferrals: 2,
  },
}: {
  verified?: boolean;
  body?: Record<string, unknown>;
} = {}) {
  return new Request("http://localhost/api/user/senders/archive-existing", {
    method: "POST",
    headers: verified ? { "x-test-verified": "1" } : {},
    body: JSON.stringify(body),
  }) as never;
}
