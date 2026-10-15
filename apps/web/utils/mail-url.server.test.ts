import { beforeEach, describe, expect, it, vi } from "vitest";
import { MailSplitFilterKind } from "@/generated/prisma/enums";
import { OTHER_SPLIT_ID } from "@/utils/split-inbox/split-query";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  getMailSettings: vi.fn(),
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    emailAccount: {
      findMany: (...args: unknown[]) => mocks.findMany(...args),
    },
  },
}));

vi.mock("@/utils/split-inbox/settings.server", () => ({
  getMailSettings: (...args: unknown[]) => mocks.getMailSettings(...args),
}));

import { getMailRedirectPath } from "./mail-url.server";

const USER_ID = "user_1";

describe("getMailRedirectPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([
      { id: "acc_first", account: { provider: "google" } },
      { id: "acc_second", account: { provider: "google" } },
    ]);
    mocks.getMailSettings.mockResolvedValue({
      splits: [
        { id: "all", name: "All", order: -1, matchAll: true, filters: [] },
        {
          id: "cmv7j1ylm000306l1lyauwn5o",
          name: "Needs Reply",
          order: 0,
          matchAll: true,
          filters: [{ kind: MailSplitFilterKind.UNREAD, value: null }],
        },
      ],
    });
  });

  it("only numbers the signed-in user's own accounts, in connection order", async () => {
    await getMailRedirectPath({ userId: USER_ID, emailAccountId: null });
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
  });

  it("turns the old split address into the tab's slug", async () => {
    await expect(
      getMailRedirectPath({
        userId: USER_ID,
        emailAccountId: "acc_second",
        searchParams: { split: "cmv7j1ylm000306l1lyauwn5o" },
      }),
    ).resolves.toBe("/mail/u/1/needs-reply");
    expect(mocks.getMailSettings).toHaveBeenCalledWith({
      emailAccountId: "acc_second",
    });
  });

  it("reads the tab mail opens on as the inbox, and Gmail's Other by slug", async () => {
    await expect(
      getMailRedirectPath({
        userId: USER_ID,
        emailAccountId: "acc_first",
        searchParams: { split: "all" },
      }),
    ).resolves.toBe("/mail/u/0/inbox");
    await expect(
      getMailRedirectPath({
        userId: USER_ID,
        emailAccountId: "acc_first",
        searchParams: { split: OTHER_SPLIT_ID },
      }),
    ).resolves.toBe("/mail/u/0/inbox-other");
  });

  it.each([
    [{ type: "sent" }, "/mail/u/0/sent"],
    [{ type: "label", labelId: "Label_7" }, "/mail/u/0/label/Label_7"],
    [{ type: "folder", folderId: "AAMk" }, "/mail/u/0/folder/AAMk"],
    [{ q: "invoice", type: "sent" }, "/mail/u/0/search?q=invoice"],
    [{ "thread-id": "18c2f" }, "/mail/u/0/inbox/18c2f"],
    [
      {
        accountScope: "all",
        "thread-id": "t9",
        "thread-account-id": "acc_second",
      },
      "/mail/u/0/all-inboxes/inbox/t9?account=1",
    ],
  ])("translates %j", async (searchParams, expected) => {
    await expect(
      getMailRedirectPath({
        userId: USER_ID,
        emailAccountId: "acc_first",
        searchParams,
      }),
    ).resolves.toBe(expected);
  });

  it("keeps parameters that aren't about the view", async () => {
    await expect(
      getMailRedirectPath({
        userId: USER_ID,
        emailAccountId: "acc_first",
        searchParams: {
          type: "sent",
          settings: "open",
          utm_source: ["a", "b"],
        },
      }),
    ).resolves.toBe("/mail/u/0/sent?settings=open&utm_source=a&utm_source=b");
  });

  it("never reaches into another user's account", async () => {
    await expect(
      getMailRedirectPath({
        userId: USER_ID,
        emailAccountId: "someone_elses_account",
        searchParams: { "thread-id": "secret", labelId: "Label_1" },
      }),
    ).resolves.toBe("/mail/u/0/inbox");
    expect(mocks.getMailSettings).not.toHaveBeenCalled();
  });

  it("has nowhere to go without accounts", async () => {
    mocks.findMany.mockResolvedValue([]);
    await expect(
      getMailRedirectPath({ userId: USER_ID, emailAccountId: "acc_first" }),
    ).resolves.toBeNull();
  });
});
