import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createMockEmailProvider } from "@/utils/__mocks__/email-provider";
import { EmailSendOperationStatus } from "@/generated/prisma/enums";
import { createScopedLogger } from "@/utils/logger";
import { SafeError } from "@/utils/error";
import { runWithAuditContext } from "@/utils/audit/context";
import {
  GmailCallDeferredError,
  meterGmailCall,
  setGmailInitialSync,
} from "@/utils/gmail/quota";
import { executeDurableEmailSend } from "./durable-email-send";
import type { sendHtmlEmailWithOpenTracking } from "./sent-message-open/sent-message-open.server";

vi.mock("@/utils/prisma");
vi.mock("@/utils/email/sent-message-open/sent-message-open.server", () => ({
  sendHtmlEmailWithOpenTracking: ({
    email,
    emailProvider,
  }: Parameters<typeof sendHtmlEmailWithOpenTracking>[0]) =>
    emailProvider.sendEmailWithHtml(email),
}));

vi.mock("@/utils/gmail/quota-store", async () => {
  const { createMemoryGmailQuotaStore } = await import(
    "@/__tests__/mocks/gmail-quota-store.mock"
  );
  return { gmailQuotaStore: createMemoryGmailQuotaStore() };
});
vi.mock("@/utils/redis/email-provider-rate-limit", () => ({
  isEmailProviderRateLimitRedisConfigured: () => true,
}));

const input = {
  mutationId: "7f0c3b9e-2c1d-4d6e-9b2a-1f0e5d4c3b2a",
  queuedAt: Date.now(),
  threadId: "thread",
  messageIds: ["message"],
  email: {
    to: "person@example.com",
    subject: "Reply",
    messageHtml: "<p>Hello</p>",
  },
};

describe("executeDurableEmailSend", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prisma.emailSendOperation.findUnique.mockResolvedValue(null);
    prisma.emailSendOperation.create.mockImplementation((async ({
      data,
    }: {
      data: { payloadHash: string };
    }) => ({
      id: "operation",
      status: EmailSendOperationStatus.PROCESSING,
      ...data,
    })) as never);
  });

  it("rejects a pre-send failure with its message and releases the operation", async () => {
    const provider = createMockEmailProvider({
      sendEmailWithHtml: vi
        .fn()
        .mockRejectedValue(new SafeError("Email sending is disabled.")),
    });

    const outcome = await executeDurableEmailSend({
      logger: createScopedLogger("test"),
      emailAccountId: "account",
      getEmailProvider: async () => provider,
      input,
      provider: "google",
    });

    expect(outcome).toEqual({
      status: "rejected",
      error: "Email sending is disabled.",
    });
    expect(prisma.emailSendOperation.deleteMany).toHaveBeenCalledWith({
      where: { id: "operation" },
    });
    expect(prisma.emailSendOperation.updateMany).not.toHaveBeenCalled();
  });

  it("tells the sender when Outlook rejects the message as too large", async () => {
    const provider = createMockEmailProvider({
      sendEmailWithHtml: vi.fn().mockRejectedValue(
        Object.assign(new Error("The message exceeds the size limit."), {
          statusCode: 413,
          code: "ErrorMessageSizeExceeded",
        }),
      ),
    });

    const outcome = await executeDurableEmailSend({
      logger: createScopedLogger("test"),
      emailAccountId: "account",
      getEmailProvider: async () => provider,
      input,
      provider: "microsoft",
    });

    expect(outcome).toEqual({
      status: "rejected",
      error:
        "This message is too large for Outlook. Remove an attachment and try again.",
    });
    expect(prisma.emailSendOperation.deleteMany).toHaveBeenCalledWith({
      where: { id: "operation" },
    });
    expect(prisma.emailSendOperation.updateMany).not.toHaveBeenCalled();
  });

  it("rejects provider setup failures without marking delivery uncertain", async () => {
    const outcome = await executeDurableEmailSend({
      logger: createScopedLogger("test"),
      emailAccountId: "account",
      getEmailProvider: async () => {
        throw new Error("Provider unavailable");
      },
      input,
      provider: "google",
    });

    expect(outcome.status).toBe("rejected");
    expect(prisma.emailSendOperation.deleteMany).toHaveBeenCalled();
    expect(prisma.emailSendOperation.updateMany).not.toHaveBeenCalled();
  });

  it("keeps a persistence failure uncertain after the provider accepts the send", async () => {
    const provider = createMockEmailProvider({
      sendEmailWithHtml: vi
        .fn()
        .mockResolvedValue({ messageId: "sent", threadId: "thread" }),
    });
    prisma.emailSendOperation.update.mockRejectedValue(
      new SafeError("Storage failed"),
    );
    const outcome = await executeDurableEmailSend({
      logger: createScopedLogger("test"),
      emailAccountId: "account",
      getEmailProvider: async () => provider,
      input,
      provider: "google",
    });

    expect(outcome).toEqual({ status: "uncertain" });
    expect(prisma.emailSendOperation.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps unexplained provider failures uncertain", async () => {
    const provider = createMockEmailProvider({
      sendEmailWithHtml: vi.fn().mockRejectedValue(new Error("socket hang up")),
    });

    const outcome = await executeDurableEmailSend({
      logger: createScopedLogger("test"),
      emailAccountId: "account",
      getEmailProvider: async () => provider,
      input,
      provider: "google",
    });

    expect(outcome).toEqual({ status: "uncertain" });
    expect(prisma.emailSendOperation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "operation",
        status: EmailSendOperationStatus.PROCESSING,
      },
      data: { status: EmailSendOperationStatus.UNCERTAIN },
    });
    expect(prisma.emailSendOperation.deleteMany).not.toHaveBeenCalled();
  });

  it("releases a send the Gmail quota gate held back so it is retried, not marked uncertain", async () => {
    // Gaxios wraps errors thrown below it, as the gate's deferral is.
    const deferred = Object.assign(new Error("request failed"), {
      cause: new GmailCallDeferredError(12_000, "interactive"),
    });
    const provider = createMockEmailProvider({
      sendEmailWithHtml: vi.fn().mockRejectedValue(deferred),
    });

    const outcome = await executeDurableEmailSend({
      logger: createScopedLogger("test"),
      emailAccountId: "account",
      getEmailProvider: async () => provider,
      input,
      provider: "google",
    });

    expect(outcome).toEqual({ status: "retry" });
    expect(prisma.emailSendOperation.deleteMany).toHaveBeenCalledWith({
      where: { id: "operation" },
    });
    expect(prisma.emailSendOperation.updateMany).not.toHaveBeenCalled();
  });

  it("sends a scheduled email from a cron job ahead of background Gmail work", async () => {
    // A first sync holds every background Gmail call for over a minute.
    await setGmailInitialSync("account", true);
    const provider = createMockEmailProvider({
      sendEmailWithHtml: vi.fn(() =>
        meterGmailCall({ emailAccountId: "account", cost: 100 }, async () => ({
          messageId: "sent",
          threadId: "thread",
        })),
      ),
    });

    const outcome = await runWithAuditContext(
      { source: "cron/scheduled-actions" },
      () =>
        executeDurableEmailSend({
          logger: createScopedLogger("test"),
          emailAccountId: "account",
          getEmailProvider: async () => provider,
          input,
          provider: "google",
        }),
    );

    expect(outcome).toMatchObject({ status: "applied" });
  });
});
