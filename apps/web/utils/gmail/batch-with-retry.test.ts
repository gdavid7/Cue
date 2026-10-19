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

  it("gives up on an interactive read when Gmail names a distant time", async () => {
    const retryAt = new Date(Date.now() + 90_000).toISOString();
    getBatch.mockResolvedValue([
      { id: "m1" },
      batchError(429, "rateLimitExceeded", `Retry after ${retryAt}`),
    ]);

    const result = await runWithGmailQuota({ priority: "interactive" }, () =>
      fetchBatch(createScopedLogger("batch-with-retry-test")),
    );

    expect(sleep).not.toHaveBeenCalled();
    expect(getBatch).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([{ id: "m1" }]);
    expect(result.unloadedIds).toEqual(["m2"]);
  });

  it("keeps an interactive read's total sleep within its budget across chunks", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const failed = new Set<string>();
    getBatch.mockImplementation(async (ids: string[]) =>
      ids.map((id) => {
        if (failed.has(id)) return { id };
        failed.add(id);
        return batchError(503, "backendError", "Backend Error");
      }),
    );
    const ids = Array.from({ length: 100 }, (_, i) => `m${i}`);

    const result = await runWithGmailQuota({ priority: "interactive" }, () =>
      fetchBatch(createScopedLogger("batch-with-retry-test"), ids),
    );

    const slept = sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
    expect(slept).toBeLessThanOrEqual(15_000);
    expect(result.unloadedIds.length).toBeGreaterThan(0);
    expect(result.items.length + result.unloadedIds.length).toBe(100);
  });

  it("includes the status and reason Gmail gave in the retry log", async () => {
    getBatch
      .mockResolvedValueOnce([batchError(503, "backendError", "Backend Error")])
      .mockResolvedValueOnce([{ id: "m1" }]);
    const logger = createScopedLogger("batch-with-retry-test");
    const warn = vi.spyOn(logger, "warn");

    await fetchBatch(logger, ["m1"]);

    expect(warn).toHaveBeenCalledWith(
      "Retrying Gmail batch items",
      expect.objectContaining({ firstCode: 503, firstReason: "backendError" }),
    );
  });

  it("keeps the backoff within the blocking limit when Gmail names a distant time", async () => {
    const retryAt = new Date(Date.now() + 120_000).toISOString();
    getBatch
      .mockResolvedValueOnce([
        batchError(429, "rateLimitExceeded", `Retry after ${retryAt}`),
      ])
      .mockResolvedValueOnce([{ id: "m1" }]);

    await runWithGmailQuota({ priority: "sync" }, () =>
      fetchBatch(createScopedLogger("batch-with-retry-test"), ["m1"]),
    );

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
