import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  getUserOwnAddresses,
  invalidateUserOwnAddresses,
  isOwnAddress,
} from "@/utils/user/own-addresses";

const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

describe("getUserOwnAddresses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
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

  it("serves later reads from the cache until it is invalidated", async () => {
    prisma.emailAccount.findMany.mockResolvedValueOnce([
      { email: "a@example.com" },
    ] as never);
    await getUserOwnAddresses("user-1");

    prisma.emailAccount.findMany.mockResolvedValueOnce([
      { email: "a@example.com" },
      { email: "b@example.com" },
    ] as never);
    expect(await getUserOwnAddresses("user-1")).toEqual(["a@example.com"]);

    await invalidateUserOwnAddresses("user-1");
    expect(await getUserOwnAddresses("user-1")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("still answers from the database when the cache is down", async () => {
    const { redis } = await import("@/utils/redis");
    vi.mocked(redis.get).mockRejectedValueOnce(new Error("down"));
    vi.mocked(redis.set).mockRejectedValueOnce(new Error("down"));
    prisma.emailAccount.findMany.mockResolvedValue([
      { email: "a@example.com" },
    ] as never);

    expect(await getUserOwnAddresses("user-1")).toEqual(["a@example.com"]);
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
