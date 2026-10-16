import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { getEmailAccount, getMockMessage } from "@/__tests__/helpers";
import { bulkProcessInboxEmails } from "@/utils/ai/choose-rule/bulk-process-emails";
import { runRules } from "@/utils/ai/choose-rule/run-rules";
import { createEmailProvider } from "@/utils/email/provider";
import { createScopedLogger } from "@/utils/logger";

vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/utils/ai/choose-rule/run-rules", () => ({ runRules: vi.fn() }));

const logger = createScopedLogger("bulk-process-emails-test");

describe("bulkProcessInboxEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createEmailProvider).mockResolvedValue({
      getInboxMessages: vi.fn(async () => [getMockMessage({ id: "m1" })]),
    } as never);
    prisma.rule.findMany.mockResolvedValue([{ id: "rule-1" }] as never);
  });

  it("sorts with only the rules it is given", async () => {
    await bulkProcessInboxEmails({
      emailAccount: getEmailAccount() as never,
      provider: "google",
      maxEmails: 10,
      skipArchive: true,
      ruleIds: ["rule-1"],
      logger,
    });

    expect(prisma.rule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          enabled: true,
          id: { in: ["rule-1"] },
        }),
      }),
    );
    expect(runRules).toHaveBeenCalledTimes(1);
  });
});
