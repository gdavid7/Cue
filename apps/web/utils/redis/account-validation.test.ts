import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordingRedis } from "@/__tests__/mocks/recording-redis.mock";
import prisma from "@/utils/__mocks__/prisma";
import { getEmailAccount } from "./account-validation";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", async () => ({
  redis: (await import("@/__tests__/mocks/recording-redis.mock")).recordingRedis
    .client,
}));

describe("getEmailAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordingRedis.reset();
  });

  it("returns the address of an account the user owns", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "me@example.com",
    } as never);

    expect(
      await getEmailAccount({ userId: "user-1", emailAccountId: "account-1" }),
    ).toBe("me@example.com");
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: "account-1", userId: "user-1" },
      select: { email: true },
    });
  });

  it("returns null for an account the user does not own", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(null);

    expect(
      await getEmailAccount({ userId: "user-1", emailAccountId: "account-2" }),
    ).toBeNull();
  });

  // RD-3: the address is personal data, so it is never cached server-side,
  // and an account moved to another user is refused on the very next check.
  it("keeps the address out of the cache and sees a transfer at once", async () => {
    prisma.emailAccount.findUnique.mockResolvedValueOnce({
      email: "me@example.com",
    } as never);
    const key = { userId: "user-1", emailAccountId: "account-1" };
    expect(await getEmailAccount(key)).toBe("me@example.com");

    prisma.emailAccount.findUnique.mockResolvedValueOnce(null);
    expect(await getEmailAccount(key)).toBeNull();
    expect(recordingRedis.everythingWritten()).not.toContain("me@example.com");
  });
});
