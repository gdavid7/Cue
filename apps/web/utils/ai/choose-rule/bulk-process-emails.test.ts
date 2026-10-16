import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestLogger,
  getEmailAccount,
  getMockMessage,
} from "@/__tests__/helpers";
import { ExecutedRuleStatus } from "@/generated/prisma/enums";
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
const STARTED_AT = 1_700_000_000_000;
const messages = [
  getMockMessage({ id: "m1", threadId: "t1" }),
  getMockMessage({ id: "m2", threadId: "t2" }),
  getMockMessage({ id: "m3", threadId: "t3" }),
];
const job = {
  emailAccount,
  provider: "google",
  maxEmails: 20,
  skipArchive: true,
  logger,
};

describe("bulkProcessInboxEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runRules).mockReset().mockResolvedValue([]);
    vi.mocked(createEmailProvider).mockResolvedValue({
      getInboxMessages,
    } as never);
    getInboxMessages.mockReset().mockResolvedValue(messages);
    prisma.rule.findMany.mockResolvedValue([{ id: "rule-1" }] as never);
    prisma.executedRule.findMany.mockResolvedValue([]);
  });

  it("schedules the job again after the Gmail quota gate defers the inbox fetch", async () => {
    getInboxMessages.mockRejectedValue(
      new GmailCallDeferredError(45_000, "background"),
    );
    const before = Date.now();

    await bulkProcessInboxEmails(job);

    expect(publishToQstashAt).toHaveBeenCalledTimes(1);
    const [{ path, body, notBefore }] =
      vi.mocked(publishToQstashAt).mock.calls[0];
    expect(path).toBe(BULK_PROCESS_INBOX_PATH);
    expect(body).toEqual({
      emailAccountId: "account-1",
      provider: "google",
      maxEmails: 20,
      skipArchive: true,
      startedAt: expect.any(Number),
      deferrals: 1,
    });
    expect((body as { startedAt: number }).startedAt).toBeGreaterThanOrEqual(
      before,
    );
    expect(notBefore.getTime()).toBeGreaterThanOrEqual(before + 45_000);
  });

  it("sorts every message on a first run, even ones earlier pushes skipped", async () => {
    prisma.executedRule.findMany.mockResolvedValue(
      messages.map((message) => ({
        messageId: message.id,
        status: ExecutedRuleStatus.SKIPPED,
        createdAt: new Date(STARTED_AT - 60_000),
      })) as never,
    );

    await bulkProcessInboxEmails(job);

    expect(sortedMessageIds()).toEqual(["m1", "m2", "m3"]);
  });

  it("on resume skips only mail this run sorted, and retries mail that errored", async () => {
    prisma.executedRule.findMany.mockResolvedValue([
      {
        messageId: "m1",
        status: ExecutedRuleStatus.SKIPPED,
        createdAt: new Date(STARTED_AT + 1000),
      },
      {
        messageId: "m2",
        status: ExecutedRuleStatus.ERROR,
        createdAt: new Date(STARTED_AT + 2000),
      },
      {
        messageId: "m3",
        status: ExecutedRuleStatus.SKIPPED,
        createdAt: new Date(STARTED_AT - 60_000),
      },
    ] as never);

    await bulkProcessInboxEmails({
      ...job,
      startedAt: STARTED_AT,
      deferrals: 1,
    });

    expect(sortedMessageIds()).toEqual(["m2", "m3"]);
  });

  it("stops at a deferral mid-run instead of failing the rest of the mail", async () => {
    vi.mocked(runRules)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new GmailCallDeferredError(10_000, "background"));

    await bulkProcessInboxEmails(job);

    expect(sortedMessageIds()).toEqual(["m1", "m2"]);
    expect(publishToQstashAt).toHaveBeenCalledTimes(1);
  });

  it("counts only deferrals in a row without progress toward the cap", async () => {
    vi.mocked(runRules)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new GmailCallDeferredError(10_000, "background"));

    await bulkProcessInboxEmails({
      ...job,
      startedAt: STARTED_AT,
      deferrals: 5,
    });

    expect(publishToQstashAt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(publishToQstashAt).mock.calls[0][0].body).toMatchObject({
      startedAt: STARTED_AT,
      deferrals: 1,
    });
  });

  it("does not collapse a resume after progress into an earlier one", async () => {
    getInboxMessages.mockRejectedValueOnce(
      new GmailCallDeferredError(10_000, "background"),
    );
    await bulkProcessInboxEmails({ ...job, startedAt: STARTED_AT });

    vi.mocked(runRules)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new GmailCallDeferredError(10_000, "background"));
    await bulkProcessInboxEmails({
      ...job,
      startedAt: STARTED_AT,
      deferrals: 1,
    });

    const [first, second] = vi
      .mocked(publishToQstashAt)
      .mock.calls.map(([options]) => options.deduplicationId);
    expect(first).not.toBe(second);
  });

  it("gives up after five deferrals in a row without progress", async () => {
    getInboxMessages.mockRejectedValue(
      new GmailCallDeferredError(45_000, "background"),
    );

    await bulkProcessInboxEmails({
      ...job,
      startedAt: STARTED_AT,
      deferrals: 5,
    });

    expect(publishToQstashAt).not.toHaveBeenCalled();
  });

  it("does not reschedule a failure that is not a deferral", async () => {
    getInboxMessages.mockRejectedValue(new Error("boom"));

    await bulkProcessInboxEmails(job);

    expect(publishToQstashAt).not.toHaveBeenCalled();
  });
});

function sortedMessageIds() {
  return vi.mocked(runRules).mock.calls.map(([{ message }]) => message.id);
}
