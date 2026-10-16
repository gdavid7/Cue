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
vi.mock("@/utils/qstash", () => ({
  withQstashOrInternal: (handler: unknown) => handler,
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
  });

  it("resumes the archive with its deferral count", async () => {
    prisma.newsletter.findFirst.mockResolvedValue({
      status: NewsletterStatus.AUTO_ARCHIVED,
    } as never);

    const response = await POST(resume(), {} as never);

    expect(response.status).toBe(200);
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
        deferrals: 2,
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
});

function resume() {
  return new Request("http://localhost/api/user/senders/archive-existing", {
    method: "POST",
    body: JSON.stringify({
      emailAccountId: "account-1",
      provider: "google",
      senderEmail: "news@example.com",
      ownerEmail: "user@example.com",
      deferrals: 2,
    }),
  }) as never;
}
