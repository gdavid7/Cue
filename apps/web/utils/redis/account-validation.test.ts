import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { redis } from "@/utils/redis";
import {
  createOwnedAccountMemo,
  getEmailAccount,
  invalidateAccountValidation,
} from "./account-validation";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn(), publish: vi.fn() },
}));
vi.mock("@/utils/redis/shared-subscriber", () => ({
  getSharedSubscriber: () => ({
    listen: () => ({ ready: Promise.resolve(), close: () => {} }),
  }),
}));

describe("getEmailAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(redis.set).mockResolvedValue("OK");
    vi.mocked(redis.del).mockResolvedValue(1);
  });

  // Every authenticated API request checks the account; an instance answers
  // repeat checks from memory instead of a Redis read each time.
  it("checks an owned account once per instance while fresh", async () => {
    vi.mocked(redis.get).mockResolvedValue("me@example.com");
    const key = { userId: "user-memo", emailAccountId: "account-memo" };

    expect(await getEmailAccount(key)).toBe("me@example.com");
    expect(await getEmailAccount(key)).toBe("me@example.com");

    expect(redis.get).toHaveBeenCalledOnce();
  });

  it("does not remember an account the user does not own", async () => {
    vi.mocked(redis.get).mockResolvedValue(null);
    prisma.emailAccount.findUnique.mockResolvedValue(null);
    const key = { userId: "user-other", emailAccountId: "account-other" };

    expect(await getEmailAccount(key)).toBeNull();
    expect(await getEmailAccount(key)).toBeNull();

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledTimes(2);
  });

  it("checks again after the ownership is invalidated", async () => {
    vi.mocked(redis.get).mockResolvedValue("me@example.com");
    const key = { userId: "user-moved", emailAccountId: "account-moved" };

    await getEmailAccount(key);
    await invalidateAccountValidation(key);
    vi.mocked(redis.get).mockResolvedValue(null);
    prisma.emailAccount.findUnique.mockResolvedValue(null);

    expect(await getEmailAccount(key)).toBeNull();
  });

  it("falls back to the database when Redis refuses", async () => {
    vi.mocked(redis.get).mockRejectedValue(new Error("limit exceeded"));
    vi.mocked(redis.set).mockRejectedValue(new Error("limit exceeded"));
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "me@example.com",
    } as never);

    expect(
      await getEmailAccount({
        userId: "user-db",
        emailAccountId: "account-db",
      }),
    ).toBe("me@example.com");
  });
});

describe("createOwnedAccountMemo", () => {
  // A merge or transfer moves an account to another user; every instance
  // must stop trusting the old owner at once, not when its memo expires.
  it("drops an invalidated account on every instance", async () => {
    const bus = fakeBus();
    const first = createOwnedAccountMemo(bus);
    const second = createOwnedAccountMemo(bus);
    const load = vi.fn(async () => "me@example.com");

    await first.get("account:u1:a1", load);
    await second.get("account:u1:a1", load);
    await first.invalidate("account:u1:a1");
    await second.get("account:u1:a1", load);
    await first.get("account:u1:a1", load);

    expect(load).toHaveBeenCalledTimes(4);
  });

  it("forgets everything when invalidations may have been missed", async () => {
    const bus = fakeBus();
    const memo = createOwnedAccountMemo(bus);
    const load = vi.fn(async () => "me@example.com");

    await memo.get("account:u1:a1", load);
    bus.drop();
    await memo.get("account:u1:a1", load);

    expect(load).toHaveBeenCalledTimes(2);
  });
});

function fakeBus() {
  const listeners = new Set<{
    onMessage: (message: string) => void;
    onLost: () => void;
  }>();
  return {
    listen(
      _channel: string,
      listener: { onMessage: (message: string) => void; onLost: () => void },
    ) {
      listeners.add(listener);
      return { ready: Promise.resolve() };
    },
    async publish(_channel: string, message: string) {
      for (const listener of listeners) listener.onMessage(message);
    },
    drop() {
      for (const listener of listeners) listener.onLost();
    },
  };
}
