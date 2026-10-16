import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestLogger,
  getEmailAccount,
  getMockMessage,
} from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { runRules } from "@/utils/ai/choose-rule/run-rules";
import { createEmailProvider } from "@/utils/email/provider";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import { publishToQstashAt } from "@/utils/upstash";
import {
  BULK_PROCESS_INBOX_PATH,
  bulkProcessInboxEmails,
} from "./bulk-process-emails";

vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/utils/ai/choose-rule/run-rules", () => ({ runRules: vi.fn() }));
vi.mock("@/utils/upstash", () => ({
  publishToQstashAt: vi.fn().mockResolvedValue(true),
}));

const logger = createTestLogger();
const emailAccount = { ...getEmailAccount(), id: "account-1" } as never;
const getInboxMessages = vi.fn();

describe("bulkProcessInboxEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createEmailProvider).mockResolvedValue({
      getInboxMessages,
    } as never);
    prisma.rule.findMany.mockResolvedValue([{ id: "rule-1" }] as never);
    prisma.executedRule.findMany.mockResolvedValue([]);
  });

  it("schedules the job again after the Gmail quota gate defers the inbox fetch", async () => {
    getInboxMessages.mockRejectedValue(
      new GmailCallDeferredError(45_000, "background"),
    );
    const before = Date.now();

    await bulkProcessInboxEmails({
      emailAccount,
      provider: "google",
      maxEmails: 20,
      skipArchive: true,
      logger,
    });

    expect(publishToQstashAt).toHaveBeenCalledTimes(1);
    const [{ path, body, notBefore }] =
      vi.mocked(publishToQstashAt).mock.calls[0];
    expect(path).toBe(BULK_PROCESS_INBOX_PATH);
    expect(body).toEqual({
      emailAccountId: "account-1",
      provider: "google",
      maxEmails: 20,
      skipArchive: true,
      deferrals: 1,
    });
    expect(notBefore.getTime()).toBeGreaterThanOrEqual(before + 45_000);
  });

  it("stops at a deferral mid-run and the resumed run skips mail it already sorted", async () => {
    const messages = [
      getMockMessage({ id: "m1", threadId: "t1" }),
      getMockMessage({ id: "m2", threadId: "t2" }),
      getMockMessage({ id: "m3", threadId: "t3" }),
    ];
    getInboxMessages.mockResolvedValue(messages);
    vi.mocked(runRules)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new GmailCallDeferredError(10_000, "background"));

    await bulkProcessInboxEmails({
      emailAccount,
      provider: "google",
      maxEmails: 20,
      skipArchive: true,
      logger,
    });

    expect(sortedMessageIds()).toEqual(["m1", "m2"]);
    expect(publishToQstashAt).toHaveBeenCalledTimes(1);

    vi.mocked(runRules).mockReset().mockResolvedValue([]);
    prisma.executedRule.findMany.mockResolvedValue([
      { messageId: "m1" },
    ] as never);

    await bulkProcessInboxEmails({
      emailAccount,
      provider: "google",
      maxEmails: 20,
      skipArchive: true,
      logger,
      deferrals: 1,
    });

    expect(sortedMessageIds()).toEqual(["m2", "m3"]);
  });

  it("gives up after repeated deferrals instead of rescheduling forever", async () => {
    getInboxMessages.mockRejectedValue(
      new GmailCallDeferredError(45_000, "background"),
    );

    await bulkProcessInboxEmails({
      emailAccount,
      provider: "google",
      maxEmails: 20,
      skipArchive: true,
      logger,
      deferrals: 5,
    });

    expect(publishToQstashAt).not.toHaveBeenCalled();
  });

  it("does not reschedule a failure that is not a deferral", async () => {
    getInboxMessages.mockRejectedValue(new Error("boom"));

    await bulkProcessInboxEmails({
      emailAccount,
      provider: "google",
      maxEmails: 20,
      skipArchive: true,
      logger,
    });

    expect(publishToQstashAt).not.toHaveBeenCalled();
  });
});

function sortedMessageIds() {
  return vi.mocked(runRules).mock.calls.map(([{ message }]) => message.id);
}
