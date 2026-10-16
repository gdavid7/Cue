import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { redis } from "@/utils/redis";
import {
  countEmptyGmailHistoryRun,
  getGmailHistoryCatchUpTarget,
  raiseGmailHistoryCatchUpTarget,
} from "./gmail-history-catch-up";

vi.mock("@/utils/redis", () => ({
  redis: {
    incr: vi.fn(),
    expire: vi.fn(),
    del: vi.fn(),
    eval: vi.fn(),
    get: vi.fn(),
  },
}));

describe("Gmail history catch-up target", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only ever raises the target, comparing ids too large for numbers as strings", async () => {
    await raiseGmailHistoryCatchUpTarget(
      "account-1",
      "90071992547409931234",
      logger,
    );

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("#current > #requested"),
      ["gmail-history-catch-up-target:account-1"],
      ["90071992547409931234", "86400"],
    );
  });

  it("compares ids without leading zeros, so a padded id can't outrank a larger one", async () => {
    await raiseGmailHistoryCatchUpTarget("account-1", "0001500", logger);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      ["gmail-history-catch-up-target:account-1"],
      ["1500", "86400"],
    );
  });

  it("reads back the stored id exactly", async () => {
    vi.mocked(redis.get).mockResolvedValue("h90071992547409931234");

    expect(await getGmailHistoryCatchUpTarget("account-1", logger)).toBe(
      "90071992547409931234",
    );
  });
});

const logger = createTestLogger();

describe("countEmptyGmailHistoryRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts empty runs in a row, forgetting them after an hour", async () => {
    vi.mocked(redis.incr).mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await countEmptyGmailHistoryRun("account-1", logger)).toBe(1);
    expect(await countEmptyGmailHistoryRun("account-1", logger)).toBe(2);

    expect(redis.expire).toHaveBeenCalledExactlyOnceWith(
      "gmail-history-empty-runs:account-1",
      3600,
    );
  });

  it("counts every run as the first when Redis is unavailable", async () => {
    vi.mocked(redis.incr).mockRejectedValue(new Error("Unavailable"));

    expect(await countEmptyGmailHistoryRun("account-1", logger)).toBe(1);
  });
});
