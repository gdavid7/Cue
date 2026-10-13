import { beforeEach, describe, expect, it, vi } from "vitest";
import { MailSplitFilterKind } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { applyInboxStyle } from "@/utils/split-inbox/inbox-styles.server";
import {
  createMailSplit,
  reorderMailSplits,
} from "@/utils/split-inbox/splits.server";

vi.mock("@/utils/prisma");
vi.mock("@/utils/split-inbox/splits.server", () => ({
  createMailSplit: vi.fn(),
  reorderMailSplits: vi.fn(),
}));

const ALL = { id: "all", name: "All", filters: [] };
const UNREAD = {
  id: "unread",
  name: "Unread",
  filters: [{ kind: MailSplitFilterKind.UNREAD, value: null }],
};

describe("applyInboxStyle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createMailSplit).mockImplementation(
      async ({ name }) => ({ status: "created", id: `new-${name}` }) as never,
    );
  });

  it("creates Focused and Other and moves them next to All", async () => {
    prisma.mailSplit.findMany
      .mockResolvedValueOnce([ALL, UNREAD] as never)
      .mockResolvedValueOnce([
        ALL,
        UNREAD,
        { id: "new-Focused", name: "Focused", filters: [{}] },
        { id: "new-Other", name: "Other", filters: [{}] },
      ] as never);

    await applyInboxStyle({
      emailAccountId: "account",
      provider: "microsoft",
      style: "focused-other",
    });

    expect(createMailSplit).toHaveBeenCalledWith({
      emailAccountId: "account",
      name: "Focused",
      matchAll: true,
      filters: [{ kind: MailSplitFilterKind.CATEGORY, value: "focused" }],
    });
    expect(reorderMailSplits).toHaveBeenCalledWith({
      emailAccountId: "account",
      ids: ["all", "new-Focused", "new-Other", "unread"],
    });
  });

  it("reuses a tab that already shows the same category instead of adding a duplicate", async () => {
    const promotions = {
      id: "deals",
      name: "Deals",
      filters: [
        { kind: MailSplitFilterKind.CATEGORY, value: "CATEGORY_PROMOTIONS" },
      ],
    };
    prisma.mailSplit.findMany.mockResolvedValue([ALL, promotions] as never);

    await applyInboxStyle({
      emailAccountId: "account",
      provider: "google",
      style: "tabs",
    });

    expect(
      vi.mocked(createMailSplit).mock.calls.map(([split]) => split.name),
    ).toEqual(["Primary", "Social", "Updates"]);
  });

  it("adds nothing for one inbox", async () => {
    await applyInboxStyle({
      emailAccountId: "account",
      provider: "google",
      style: "one-inbox",
    });

    expect(createMailSplit).not.toHaveBeenCalled();
    expect(reorderMailSplits).not.toHaveBeenCalled();
  });

  it("refuses a style the provider can't filter by", async () => {
    await expect(
      applyInboxStyle({
        emailAccountId: "account",
        provider: "microsoft",
        style: "tabs",
      }),
    ).rejects.toThrow("isn't available");
    expect(createMailSplit).not.toHaveBeenCalled();
  });

  it("explains the split limit rather than half-applying silently", async () => {
    prisma.mailSplit.findMany.mockResolvedValue([ALL] as never);
    vi.mocked(createMailSplit).mockResolvedValue({ status: "limit" });

    await expect(
      applyInboxStyle({
        emailAccountId: "account",
        provider: "google",
        style: "tabs",
      }),
    ).rejects.toThrow("You can only have");
    expect(reorderMailSplits).not.toHaveBeenCalled();
  });
});
