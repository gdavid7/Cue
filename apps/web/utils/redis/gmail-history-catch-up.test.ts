import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { redis } from "@/utils/redis";
import { countEmptyGmailHistoryRun } from "./gmail-history-catch-up";

vi.mock("@/utils/redis", () => ({
  redis: { incr: vi.fn(), expire: vi.fn(), del: vi.fn() },
}));

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
