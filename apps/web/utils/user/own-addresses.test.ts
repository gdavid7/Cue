import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordingRedis } from "@/__tests__/mocks/recording-redis.mock";
import prisma from "@/utils/__mocks__/prisma";
import { getUserOwnAddresses, isOwnAddress } from "@/utils/user/own-addresses";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", async () => ({
  redis: (await import("@/__tests__/mocks/recording-redis.mock")).recordingRedis
    .client,
}));

describe("getUserOwnAddresses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordingRedis.reset();
  });

  it("returns every connected address of the user, normalized", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      { email: "Alice@Example.com" },
      { email: "alice.personal@gmail.com" },
    ] as never);

    expect(await getUserOwnAddresses("user-1")).toEqual([
      "alice@example.com",
      "alice.personal@gmail.com",
    ]);
    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
  });

  // RD-3: addresses stay out of the server cache, so a newly linked or removed
  // mailbox counts at once without anything to invalidate.
  it("reads the current addresses every time and caches none of them", async () => {
    prisma.emailAccount.findMany.mockResolvedValueOnce([
      { email: "a@example.com" },
    ] as never);
    await getUserOwnAddresses("user-1");

    prisma.emailAccount.findMany.mockResolvedValueOnce([
      { email: "a@example.com" },
      { email: "b@example.com" },
    ] as never);
    expect(await getUserOwnAddresses("user-1")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(recordingRedis.everythingWritten()).not.toContain("@example.com");
  });
});

describe("isOwnAddress", () => {
  it("matches a header against the user's addresses", () => {
    const own = ["a@example.com", "b@gmail.com"];
    expect(isOwnAddress("Alice <B@Gmail.com>", own)).toBe(true);
    expect(isOwnAddress("someone@else.com", own)).toBe(false);
    expect(isOwnAddress("", own)).toBe(false);
  });
});
