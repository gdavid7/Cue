import { beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/utils/redis";
import { createScopedLogger } from "@/utils/logger";
import {
  claimPredraftSlot,
  PREDRAFTS_PER_ACCOUNT_PER_DAY,
} from "@/utils/redis/predraft-cap";

vi.mock("@/env", () => ({
  env: {
    REDIS_HTTP_URL: "https://redis.example.com",
    REDIS_HTTP_TOKEN: "token",
  },
}));

const counters = new Map<string, number>();
vi.mock("@/utils/redis", () => ({
  redis: {
    // INCR, as the claim script does, kept in memory.
    eval: vi.fn(async (_script: string, keys: string[]) => {
      const count = (counters.get(keys[0]) ?? 0) + 1;
      counters.set(keys[0], count);
      return count;
    }),
  },
}));

const logger = createScopedLogger("predraft-cap-test");
const NOW = new Date("2026-10-19T12:00:00Z");

describe("claimPredraftSlot", () => {
  beforeEach(() => {
    counters.clear();
    vi.clearAllMocks();
  });

  it("gives out the day's slots and refuses the next one", async () => {
    const claims = await Promise.all(
      Array.from({ length: PREDRAFTS_PER_ACCOUNT_PER_DAY + 1 }, () =>
        claimPredraftSlot({ emailAccountId: "account-1", logger, now: NOW }),
      ),
    );

    expect(PREDRAFTS_PER_ACCOUNT_PER_DAY).toBe(20);
    expect(claims.filter(Boolean)).toHaveLength(20);
    expect(claims.at(-1)).toBe(false);
  });

  it("counts each account and each day on its own", async () => {
    for (let i = 0; i < PREDRAFTS_PER_ACCOUNT_PER_DAY; i++) {
      await claimPredraftSlot({
        emailAccountId: "account-1",
        logger,
        now: NOW,
      });
    }

    await expect(
      claimPredraftSlot({ emailAccountId: "account-2", logger, now: NOW }),
    ).resolves.toBe(true);
    await expect(
      claimPredraftSlot({
        emailAccountId: "account-1",
        logger,
        now: new Date("2026-10-20T00:00:01Z"),
      }),
    ).resolves.toBe(true);
  });

  it("keys the counter by account ID and date only", async () => {
    await claimPredraftSlot({ emailAccountId: "account-1", logger, now: NOW });

    expect(vi.mocked(redis.eval).mock.calls[0]?.[1]).toEqual([
      "predraft-cap:v1:account-1:2026-10-19",
    ]);
  });

  it("drafts nothing when Redis fails", async () => {
    vi.mocked(redis.eval).mockRejectedValueOnce(new Error("down"));

    await expect(
      claimPredraftSlot({ emailAccountId: "account-1", logger, now: NOW }),
    ).resolves.toBe(false);
  });
});
