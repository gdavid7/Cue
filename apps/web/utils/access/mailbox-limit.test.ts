import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { getMailboxLimitResponse } from "@/utils/access/mailbox-limit";

vi.mock("@/utils/prisma");

describe("getMailboxLimitResponse", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("lets an approved person add their own extra mailboxes", async () => {
    prisma.emailAccount.count.mockResolvedValue(2);

    await expect(
      getMailboxLimitResponse({
        userId: "u1",
        isReconnect: false,
        maxExtraMailboxes: 2,
        waitlistEnabled: true,
      }),
    ).resolves.toBeNull();
  });

  it("stops one approval from covering more mailboxes than the beta allows", async () => {
    prisma.emailAccount.count.mockResolvedValue(3);

    const response = await getMailboxLimitResponse({
      userId: "u1",
      isReconnect: false,
      maxExtraMailboxes: 2,
      waitlistEnabled: true,
    });

    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual(
      expect.objectContaining({ isKnownError: true }),
    );
  });

  it("never blocks reconnecting a mailbox, or anyone while the waitlist is off", async () => {
    prisma.emailAccount.count.mockResolvedValue(10);

    await expect(
      getMailboxLimitResponse({
        userId: "u1",
        isReconnect: true,
        maxExtraMailboxes: 2,
        waitlistEnabled: true,
      }),
    ).resolves.toBeNull();
    await expect(
      getMailboxLimitResponse({
        userId: "u1",
        isReconnect: false,
        maxExtraMailboxes: 2,
        waitlistEnabled: false,
      }),
    ).resolves.toBeNull();
    expect(prisma.emailAccount.count).not.toHaveBeenCalled();
  });
});
