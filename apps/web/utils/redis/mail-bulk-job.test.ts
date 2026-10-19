import { describe, expect, it, vi } from "vitest";
import { redis } from "@/utils/redis";
import {
  isStaleMailBulkJob,
  type MailBulkJobState,
  mailBulkJobStore,
} from "@/utils/redis/mail-bulk-job";

vi.mock("@/utils/redis", () => ({ redis: { eval: vi.fn() } }));

describe("mailBulkJobStore.transition", () => {
  it("moves the status only from the expected ones, atomically", async () => {
    vi.mocked(redis.eval).mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(
      mailBulkJobStore.transition("job-1", ["listing"], "applying"),
    ).resolves.toBe(true);
    await expect(
      mailBulkJobStore.transition("job-1", ["listing"], "applying"),
    ).resolves.toBe(false);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('HGET", KEYS[1], "status"'),
      ["mail-bulk-job:job-1"],
      ["applying", expect.any(String), "listing"],
    );
  });
});

describe("isStaleMailBulkJob", () => {
  const job = (overrides: Partial<MailBulkJobState>): MailBulkJobState => ({
    emailAccountId: "account-1",
    action: "archive",
    status: "applying",
    total: 0,
    conversations: 0,
    applied: 0,
    failed: 0,
    capped: false,
    updatedAt: 0,
    ...overrides,
  });

  it("flags a running job silent for more than ten minutes", () => {
    const now = 11 * 60 * 1000;
    expect(isStaleMailBulkJob(job({ updatedAt: 0 }), now)).toBe(true);
    expect(isStaleMailBulkJob(job({ updatedAt: now - 60_000 }), now)).toBe(
      false,
    );
    expect(isStaleMailBulkJob(job({ status: "done" }), now)).toBe(false);
  });
});
