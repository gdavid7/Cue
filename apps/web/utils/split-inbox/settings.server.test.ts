import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { getMailSettings } from "@/utils/split-inbox/settings.server";

vi.mock("@/utils/prisma");

describe("getMailSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { rules: [{ enabled: true }], replyTracking: true },
    { rules: [{ enabled: false }], replyTracking: false },
    { rules: [], replyTracking: false },
  ])("reports reply tracking as $replyTracking for To Reply rules $rules", async ({
    rules,
    replyTracking,
  }) => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      mailLayout: null,
      mailExpandedPreview: false,
      mailSplits: [],
      rules,
    } as never);

    const settings = await getMailSettings({ emailAccountId: "account" });

    expect(settings.replyTracking).toBe(replyTracking);
  });
});
