import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockEmailAccountWithAccount } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { removeCueLabelsAction } from "@/utils/actions/cue-labels";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));

const {
  mockCreateEmailProvider,
  mockGetLabels,
  mockDeleteLabel,
  mockRemoveLabelFromMailSplits,
} = vi.hoisted(() => ({
  mockCreateEmailProvider: vi.fn(),
  mockGetLabels: vi.fn(),
  mockDeleteLabel: vi.fn(),
  mockRemoveLabelFromMailSplits: vi.fn(),
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: (...args: Parameters<typeof mockCreateEmailProvider>) =>
    mockCreateEmailProvider(...args),
}));

vi.mock("@/utils/split-inbox/splits.server", () => ({
  removeLabelFromMailSplits: (
    ...args: Parameters<typeof mockRemoveLabelFromMailSplits>
  ) => mockRemoveLabelFromMailSplits(...args),
}));

const EMAIL_ACCOUNT_ID = "email-account-1";

describe("removeCueLabelsAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setProvider("google");
    mockGetLabels.mockResolvedValue([
      { id: "Label_reply", name: "To Reply", type: "user" },
      { id: "Label_news", name: "Newsletter", type: "user" },
      { id: "Label_work", name: "Work", type: "user" },
    ]);
    mockDeleteLabel.mockResolvedValue(undefined);
    mockCreateEmailProvider.mockResolvedValue({
      name: "google",
      getLabels: mockGetLabels,
      deleteLabel: mockDeleteLabel,
    });
  });

  it("deletes the selected labels and stops Cue's rules applying them", async () => {
    const result = await removeCueLabelsAction(EMAIL_ACCOUNT_ID, {
      labelIds: ["Label_reply", "Label_news"],
    });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data?.results).toEqual([
      { labelId: "Label_reply", name: "To Reply", status: "removed" },
      { labelId: "Label_news", name: "Newsletter", status: "removed" },
    ]);
    expect(mockDeleteLabel.mock.calls.map(([id]) => id)).toEqual([
      "Label_reply",
      "Label_news",
    ]);
    expect(mockRemoveLabelFromMailSplits).toHaveBeenCalledWith({
      emailAccountId: EMAIL_ACCOUNT_ID,
      labelId: "Label_reply",
    });
    expect(prisma.action.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        emailAccountId: EMAIL_ACCOUNT_ID,
        type: "LABEL",
        OR: expect.arrayContaining([{ labelId: "Label_reply" }]),
      }),
    });
  });

  it("never deletes a label that isn't one of Cue's", async () => {
    const result = await removeCueLabelsAction(EMAIL_ACCOUNT_ID, {
      labelIds: ["Label_work"],
    });

    expect(result?.data?.results).toEqual([
      { labelId: "Label_work", name: null, status: "not_found" },
    ]);
    expect(mockDeleteLabel).not.toHaveBeenCalled();
    expect(mockRemoveLabelFromMailSplits).not.toHaveBeenCalled();
    expect(prisma.action.deleteMany).not.toHaveBeenCalled();
  });

  it("reports a label Gmail couldn't delete and still removes the rest", async () => {
    mockDeleteLabel.mockImplementation(async (id: string) => {
      if (id === "Label_reply") throw new Error("Gmail is down");
    });

    const result = await removeCueLabelsAction(EMAIL_ACCOUNT_ID, {
      labelIds: ["Label_reply", "Label_news"],
    });

    expect(result?.data?.results).toEqual([
      { labelId: "Label_reply", name: "To Reply", status: "failed" },
      { labelId: "Label_news", name: "Newsletter", status: "removed" },
    ]);
    expect(mockRemoveLabelFromMailSplits).toHaveBeenCalledTimes(1);
    expect(mockRemoveLabelFromMailSplits).toHaveBeenCalledWith({
      emailAccountId: EMAIL_ACCOUNT_ID,
      labelId: "Label_news",
    });
  });

  it("refuses Outlook accounts", async () => {
    setProvider("microsoft");

    const result = await removeCueLabelsAction(EMAIL_ACCOUNT_ID, {
      labelIds: ["Label_reply"],
    });

    expect(result?.serverError).toBeDefined();
    expect(mockDeleteLabel).not.toHaveBeenCalled();
  });

  it("requires at least one label", async () => {
    const result = await removeCueLabelsAction(EMAIL_ACCOUNT_ID, {
      labelIds: [],
    });

    expect(result?.validationErrors).toBeDefined();
    expect(mockDeleteLabel).not.toHaveBeenCalled();
  });
});

function setProvider(provider: "google" | "microsoft") {
  prisma.emailAccount.findUnique.mockResolvedValue(
    getMockEmailAccountWithAccount({
      email: "user@example.com",
      userId: "user-1",
      provider,
    }) as never,
  );
}
