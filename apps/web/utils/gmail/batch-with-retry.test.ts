import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import { getBatchWithRetry } from "./batch-with-retry";

const { getBatch } = vi.hoisted(() => ({ getBatch: vi.fn() }));
vi.mock("@/utils/gmail/batch", () => ({ getBatch }));

describe("getBatchWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

function fetchBatch(logger: ReturnType<typeof createScopedLogger>) {
  return getBatchWithRetry<{ id: string }, { id: string }>({
    ids: ["m1", "m2"],
    endpoint: "/gmail/v1/users/me/messages",
    accessToken: "token",
    parse: (item) => item,
    logger,
  });
}

function batchError(code: number, reason: string, message: string) {
  return { error: { code, message, errors: [{ reason, message }] } };
}
