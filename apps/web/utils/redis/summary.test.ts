import { beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/utils/redis";
import { getSummary, saveSummary } from "./summary";

vi.mock("@/utils/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn() },
}));

describe("summary cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The cached text is a whole email; keyed by it and kept forever, every
  // summary grew the store without bound.
  it("keys a summary by a short hash of its text and lets it expire", async () => {
    const text = "x".repeat(20_000);
    await saveSummary(text, "Short summary");

    const [key, value, options] = vi.mocked(redis.set).mock.calls[0];
    expect(key.length).toBeLessThan(100);
    expect(value).toBe("Short summary");
    expect(options).toMatchObject({ ex: expect.any(Number) });

    vi.mocked(redis.get).mockResolvedValue("Short summary");
    expect(await getSummary(text)).toBe("Short summary");
    expect(redis.get).toHaveBeenCalledWith(key);
  });
});
