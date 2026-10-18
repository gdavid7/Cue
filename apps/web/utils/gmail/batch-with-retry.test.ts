import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import { getBatchWithRetry } from "./batch-with-retry";
import { runWithGmailQuota } from "@/utils/gmail/quota";

const { getBatch, sleep } = vi.hoisted(() => ({
  getBatch: vi.fn(),
  sleep: vi.fn(),
}));
vi.mock("@/utils/gmail/batch", () => ({ getBatch }));
vi.mock("@/utils/sleep", () => ({ sleep }));

describe("getBatchWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBatch.mockReset();
    sleep.mockReset().mockResolvedValue(undefined);
  });

  it("retries only the items Gmail refused, in halved batches", async () => {
    getBatch
      .mockResolvedValueOnce([
        { id: "m1" },
        batchError(503, "backendError", "Backend Error"),
        batchError(503, "backendError", "Backend Error"),
        batchError(503, "backendError", "Backend Error"),
      ])
      .mockResolvedValueOnce([{ id: "m2" }, { id: "m3" }])
      .mockResolvedValueOnce([{ id: "m4" }]);

    const result = await runWithGmailQuota({ priority: "sync" }, () =>
      fetchBatch(createScopedLogger("batch-with-retry-test"), [
        "m1",
        "m2",
        "m3",
        "m4",
      ]),
    );

    expect(getBatch.mock.calls.map(([ids]) => ids)).toEqual([
      ["m1", "m2", "m3", "m4"],
      ["m2", "m3"],
      ["m4"],
    ]);
    expect(result.items).toEqual([
      { id: "m1" },
      { id: "m2" },
      { id: "m3" },
      { id: "m4" },
    ]);
    expect(result.unloadedIds).toEqual([]);
  });

  it("waits for the time Gmail names before retrying", async () => {
    const retryAt = new Date(Date.now() + 7000).toISOString();
    getBatch
      .mockResolvedValueOnce([
        batchError(
          403,
          "userRateLimitExceeded",
          `User-rate limit exceeded. Retry after ${retryAt}`,
        ),
      ])
      .mockResolvedValueOnce([{ id: "m1" }]);

    await fetchBatch(createScopedLogger("batch-with-retry-test"), ["m1"]);

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(6000);
    expect(sleep.mock.calls[0][0]).toBeLessThanOrEqual(11_000);
  });

  it("keeps the backoff within the blocking limit when Gmail names a distant time", async () => {
    const retryAt = new Date(Date.now() + 120_000).toISOString();
    getBatch
      .mockResolvedValueOnce([
        batchError(429, "rateLimitExceeded", `Retry after ${retryAt}`),
      ])
      .mockResolvedValueOnce([{ id: "m1" }]);

    await fetchBatch(createScopedLogger("batch-with-retry-test"), ["m1"]);

    expect(sleep.mock.calls[0][0]).toBeLessThanOrEqual(11_000);
  });

  it("skips a message deleted since it was listed without a warning", async () => {
    getBatch.mockResolvedValue([
      { id: "m1" },
      batchError(404, "notFound", "Requested entity was not found."),
    ]);
    const logger = createScopedLogger("batch-with-retry-test");
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");

    const result = await fetchBatch(logger);

    expect(result).toEqual({ items: [{ id: "m1" }], unloadedIds: [] });
    expect(getBatch).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      "Skipping batch item due to non-retryable error",
      expect.objectContaining({ code: 404, reason: "notFound" }),
    );
  });

  it("still warns about other items Gmail refuses for good", async () => {
    getBatch.mockResolvedValue([
      { id: "m1" },
      batchError(400, "invalidArgument", "Invalid id value"),
    ]);
    const logger = createScopedLogger("batch-with-retry-test");
    const warn = vi.spyOn(logger, "warn");

    await fetchBatch(logger);

    expect(warn).toHaveBeenCalledWith(
      "Skipping batch item due to non-retryable error",
      expect.objectContaining({ code: 400, reason: "invalidArgument" }),
    );
  });
});

function fetchBatch(
  logger: ReturnType<typeof createScopedLogger>,
  ids = ["m1", "m2"],
) {
  return getBatchWithRetry<{ id: string }, { id: string }>({
    ids,
    endpoint: "/gmail/v1/users/me/messages",
    accessToken: "token",
    parse: (item) => item,
    logger,
  });
}

function batchError(code: number, reason: string, message: string) {
  return { error: { code, message, errors: [{ reason, message }] } };
}
