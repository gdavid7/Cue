import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { redis } from "@/utils/redis";
import { claimNewMailReaction } from "./new-mail-reaction";

vi.mock("@/utils/redis", () => ({ redis: { set: vi.fn(), del: vi.fn() } }));

const logger = createTestLogger();
const input = { emailAccountId: "account", messageId: "message", logger };

describe("claimNewMailReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims a message once, under its ids alone", async () => {
    vi.mocked(redis.set)
      .mockResolvedValueOnce("OK")
      .mockResolvedValueOnce(null);

    expect(await claimNewMailReaction(input)).toBe("claimed");
    expect(await claimNewMailReaction(input)).toBe("taken");
    expect(redis.set).toHaveBeenCalledWith(
      "new-mail-reaction:v1:account:message",
      "claimed",
      expect.objectContaining({ nx: true }),
    );
  });

  // Callers decide what an outage means; it is never read as "taken".
  it("reports Redis failing as unavailable", async () => {
    vi.mocked(redis.set).mockRejectedValueOnce(new Error("down"));

    expect(await claimNewMailReaction(input)).toBe("unavailable");
  });
});
