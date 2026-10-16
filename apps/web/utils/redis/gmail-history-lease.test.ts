import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { redis } from "@/utils/redis";
import {
  acquireGmailHistoryLease,
  releaseGmailHistoryLease,
} from "./gmail-history-lease";

vi.mock("@/utils/redis", () => ({
  redis: { set: vi.fn(), eval: vi.fn() },
}));

const logger = createTestLogger();

describe("Gmail history lease", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets one run at a time read an account's history", async () => {
    vi.mocked(redis.set).mockResolvedValueOnce("OK").mockResolvedValue(null);

    const first = await acquireGmailHistoryLease("account-1", logger);
    const second = await acquireGmailHistoryLease("account-1", logger);

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(redis.set).toHaveBeenCalledWith(
      "gmail-history-lease:account-1",
      expect.any(String),
      expect.objectContaining({ nx: true }),
    );
  });

  it("releases only its own lease", async () => {
    vi.mocked(redis.set).mockResolvedValue("OK");
    const lease = await acquireGmailHistoryLease("account-1", logger);

    await releaseGmailHistoryLease("account-1", lease, logger);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      ["gmail-history-lease:account-1"],
      [lease.acquired ? lease.token : ""],
    );
  });

  it("lets the run go ahead when Redis is unavailable, as before leases", async () => {
    vi.mocked(redis.set).mockRejectedValue(new Error("Unavailable"));

    const lease = await acquireGmailHistoryLease("account-1", logger);

    expect(lease.acquired).toBe(true);
    await releaseGmailHistoryLease("account-1", lease, logger);
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
