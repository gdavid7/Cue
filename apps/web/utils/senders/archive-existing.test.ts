import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import { publishToQstashAt } from "@/utils/upstash";
import {
  ARCHIVE_EXISTING_RESUME_PATH,
  INLINE_ARCHIVE_EXISTING_MESSAGE_LIMIT,
  archiveExistingSenderMail,
  runQueuedSenderArchive,
} from "./archive-existing";

vi.mock("@/utils/prisma");
vi.mock("@/utils/upstash", () => ({
  publishToQstashAt: vi.fn().mockResolvedValue(true),
}));

const logger = createTestLogger();

function provider() {
  return {
    name: "google",
    bulkArchiveSenderOrThrow: vi.fn().mockResolvedValue(0),
  };
}

describe("archiveExistingSenderMail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("archives a small backlog before returning", async () => {
    prisma.emailMessage.count.mockResolvedValue(2 as never);
    const emailProvider = provider();

    await expect(
      archiveExistingSenderMail({
        emailAccountId: "account-1",
        emailProvider: emailProvider as never,
        senderEmail: "news@example.com",
        ownerEmail: "user@example.com",
        logger,
      }),
    ).resolves.toBe("completed");

    expect(emailProvider.bulkArchiveSenderOrThrow).toHaveBeenCalledWith(
      "news@example.com",
      "user@example.com",
      "account-1",
    );
  });

  it("queues when local stats have no inbox rows", async () => {
    prisma.emailMessage.count.mockResolvedValue(0 as never);
    const emailProvider = provider();

    await expect(
      archiveExistingSenderMail({
        emailAccountId: "account-1",
        emailProvider: emailProvider as never,
        senderEmail: "news@example.com",
        ownerEmail: "user@example.com",
        logger,
      }),
    ).resolves.toBe("queued");
    await vi.waitFor(() => {
      expect(emailProvider.bulkArchiveSenderOrThrow).toHaveBeenCalled();
    });
  });

  it("queues a large backlog and keeps a later failure off the request", async () => {
    prisma.emailMessage.count.mockResolvedValue(
      (INLINE_ARCHIVE_EXISTING_MESSAGE_LIMIT + 1) as never,
    );
    const emailProvider = provider();
    emailProvider.bulkArchiveSenderOrThrow.mockRejectedValue(
      new Error("later"),
    );

    await expect(
      archiveExistingSenderMail({
        emailAccountId: "account-1",
        emailProvider: emailProvider as never,
        senderEmail: "news@example.com",
        ownerEmail: "user@example.com",
        logger,
      }),
    ).resolves.toBe("queued");
  });

  it("surfaces a failure while archiving a small backlog", async () => {
    prisma.emailMessage.count.mockResolvedValue(1 as never);
    const emailProvider = provider();
    emailProvider.bulkArchiveSenderOrThrow.mockRejectedValue(
      new Error("later"),
    );

    await expect(
      archiveExistingSenderMail({
        emailAccountId: "account-1",
        emailProvider: emailProvider as never,
        senderEmail: "news@example.com",
        ownerEmail: "user@example.com",
        logger,
      }),
    ).rejects.toThrow("later");
  });
});

describe("archiveExistingSenderMail when the Gmail quota gate defers it", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailMessage.count.mockResolvedValue(0 as never);
  });

  it("schedules the queued archive again after the deferral passes", async () => {
    const emailProvider = provider();
    emailProvider.bulkArchiveSenderOrThrow.mockRejectedValue(
      new GmailCallDeferredError(30_000, "background"),
    );
    const before = Date.now();

    await archiveExistingSenderMail({
      emailAccountId: "account-1",
      emailProvider: emailProvider as never,
      senderEmail: "news@example.com",
      ownerEmail: "user@example.com",
      logger,
    });

    await vi.waitFor(() => {
      expect(publishToQstashAt).toHaveBeenCalledTimes(1);
    });
    const [{ path, body, notBefore }] =
      vi.mocked(publishToQstashAt).mock.calls[0];
    expect(path).toBe(ARCHIVE_EXISTING_RESUME_PATH);
    expect(body).toEqual({
      emailAccountId: "account-1",
      provider: "google",
      senderEmail: "news@example.com",
      ownerEmail: "user@example.com",
      deferrals: 1,
    });
    expect(notBefore.getTime()).toBeGreaterThanOrEqual(before + 30_000);
  });

  it("gives up after repeated deferrals", async () => {
    const emailProvider = provider();
    emailProvider.bulkArchiveSenderOrThrow.mockRejectedValue(
      new GmailCallDeferredError(30_000, "background"),
    );

    await runQueuedSenderArchive({
      emailAccountId: "account-1",
      emailProvider: emailProvider as never,
      senderEmail: "news@example.com",
      ownerEmail: "user@example.com",
      logger,
      deferrals: 5,
    });

    expect(emailProvider.bulkArchiveSenderOrThrow).toHaveBeenCalled();
    expect(publishToQstashAt).not.toHaveBeenCalled();
  });
});
