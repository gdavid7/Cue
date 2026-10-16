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

type Row = { messageId: string; status: ExecutedRuleStatus; createdAt: Date };
type Outcome = "sort" | "fail" | "defer";

const logger = createTestLogger();
const emailAccount = { ...getEmailAccount(), id: "account-1" } as never;
const getInboxMessages = vi.fn();
const STARTED_AT = 1_700_000_000_000;
const messages = ["m1", "m2", "m3", "m4"].map((id, index) =>
  getMockMessage({ id, threadId: `t${index + 1}` }),
);
const job = {
  emailAccount,
  provider: "google",
  maxEmails: 20,
  skipArchive: true,
  logger,
};

// Executed rules this test's mailbox has, and what running the rules on a
// message does: sort it (a row), fail after writing an ERROR row, or hit a
// quota deferral before writing anything.
let rows: Row[];
let outcomes: Record<string, Outcome[]>;

describe("bulkProcessInboxEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
    outcomes = {};
    vi.mocked(createEmailProvider).mockResolvedValue({
      getInboxMessages,
    } as never);
    getInboxMessages.mockReset().mockResolvedValue(messages);
    prisma.rule.findMany.mockResolvedValue([{ id: "rule-1" }] as never);
    prisma.executedRule.findMany.mockImplementation((async ({
      where,
    }: {
      where: { messageId: { in: string[] } };
    }) =>
      rows.filter((row) =>
        where.messageId.in.includes(row.messageId),
      )) as never);
    vi.mocked(runRules)
      .mockReset()
      .mockImplementation(async ({ message }) => {
        const outcome = outcomes[message.id]?.shift() ?? "sort";
        if (outcome === "defer") {
          throw new GmailCallDeferredError(10_000, "background");
        }
        rows.push({
          messageId: message.id,
          status:
            outcome === "fail"
              ? ExecutedRuleStatus.ERROR
              : ExecutedRuleStatus.SKIPPED,
          createdAt: new Date(),
        });
        if (outcome === "fail") throw new Error("action failed");
        return [];
      });
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
      processedTotal: 0,
      deferrals: 1,
    });
    expect((body as { startedAt: number }).startedAt).toBeGreaterThanOrEqual(
      before,
    );
    expect(notBefore.getTime()).toBeGreaterThanOrEqual(before + 45_000);
  });

  it("sorts every message on a first run, even ones earlier pushes skipped", async () => {
    rows = messages.map((message) => ({
      messageId: message.id,
      status: ExecutedRuleStatus.SKIPPED,
      createdAt: new Date(Date.now() - 60_000),
    }));

    await bulkProcessInboxEmails(job);

    expect(ranOn()).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("on resume skips every message this run touched, including ones that errored", async () => {
    rows = [
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
    ];

    await bulkProcessInboxEmails({
      ...job,
      startedAt: STARTED_AT,
      processedTotal: 2,
      deferrals: 1,
    });

    expect(ranOn()).toEqual(["m3", "m4"]);
  });

  it("stops at a deferral mid-run instead of failing the rest of the mail", async () => {
    outcomes.m2 = ["defer"];

    await bulkProcessInboxEmails(job);

    expect(ranOn()).toEqual(["m1", "m2"]);
    expect(publishToQstashAt).toHaveBeenCalledTimes(1);
    expect(lastResumeBody()).toMatchObject({
      processedTotal: 1,
      deferrals: 1,
    });
  });

  it("gives every resume its own id and still ends a chain that stalls", async () => {
    // Defer at fetch, defer at fetch, sort three then defer, then defer at
    // fetch from then on.
    getInboxMessages
      .mockRejectedValueOnce(new GmailCallDeferredError(10_000, "background"))
      .mockRejectedValueOnce(new GmailCallDeferredError(10_000, "background"))
      .mockResolvedValueOnce(messages)
      .mockRejectedValue(new GmailCallDeferredError(10_000, "background"));
    outcomes.m4 = ["defer"];

    const runs = await runChain();

    const ids = vi
      .mocked(publishToQstashAt)
      .mock.calls.map(([options]) => options.deduplicationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      vi
        .mocked(publishToQstashAt)
        .mock.calls.map(([{ body }]) => [
          (body as { processedTotal: number }).processedTotal,
          (body as { deferrals: number }).deferrals,
        ]),
    ).toEqual([
      [0, 1],
      [0, 2],
      [3, 1],
      [3, 2],
      [3, 3],
      [3, 4],
      [3, 5],
    ]);
    expect(runs).toBe(8);
    expect(ranOn()).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("does not keep resetting the cap on a message that always fails", async () => {
    outcomes.m1 = Array.from({ length: 10 }, () => "fail");
    outcomes.m2 = Array.from({ length: 10 }, () => "defer");

    const runs = await runChain();

    expect(runs).toBe(6);
    expect(ranOn().filter((id) => id === "m1")).toHaveLength(1);
  });

  it("sorts with only the rules it is given", async () => {
    await bulkProcessInboxEmails({ ...job, ruleIds: ["rule-1"] });

    expect(prisma.rule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          enabled: true,
          id: { in: ["rule-1"] },
        }),
      }),
    );
    expect(ranOn()).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("resumes a deferred sort with only the rules it was given", async () => {
    getInboxMessages.mockRejectedValue(
      new GmailCallDeferredError(10_000, "background"),
    );

    await bulkProcessInboxEmails({ ...job, ruleIds: ["rule-1"] });

    expect(lastResumeBody()).toMatchObject({ ruleIds: ["rule-1"] });
  });

  it("does not reschedule a failure that is not a deferral", async () => {
    getInboxMessages.mockRejectedValue(new Error("boom"));

    await bulkProcessInboxEmails(job);

    expect(publishToQstashAt).not.toHaveBeenCalled();
  });
});

function ranOn() {
  return vi.mocked(runRules).mock.calls.map(([{ message }]) => message.id);
}

function lastResumeBody() {
  return vi.mocked(publishToQstashAt).mock.calls.at(-1)?.[0].body;
}

/** Runs the job, then each resume it schedules, until it stops scheduling. */
async function runChain() {
  let runs = 0;
  let resume: Record<string, unknown> | undefined = {};
  while (resume && runs < 20) {
    const scheduledBefore = vi.mocked(publishToQstashAt).mock.calls.length;
    await bulkProcessInboxEmails({ ...job, ...resume });
    runs++;
    resume =
      vi.mocked(publishToQstashAt).mock.calls.length > scheduledBefore
        ? (lastResumeBody() as Record<string, unknown>)
        : undefined;
  }
  return runs;
}
