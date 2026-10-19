import { beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/utils/redis";
import { createScopedLogger } from "@/utils/logger";
import {
  TRACKER_HINT_MESSAGE,
  localMailVersionKey,
  publishLocalMailHint,
  publishTrackerHint,
} from "./local-mail-hints";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/redis", () => ({
  redis: { publish: vi.fn(), eval: vi.fn() },
}));
const logger = createScopedLogger("local-mail-hints-test");

describe("local mail hints", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it("publishes every change, without message data, so a quick second email is not dropped", async () => {
    await publishLocalMailHint("account-a", logger);
    await publishLocalMailHint("account-a", logger);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(redis.eval).mock.calls;
    expect(first[1]).toEqual([localMailVersionKey("account-a")]);
    expect(first[2]).toEqual(
      expect.arrayContaining(["local-mail:account-a", "{}"]),
    );
    // Each push leaves a version a polling browser can tell from the last.
    expect(first[2]?.[0]).not.toBe(second[2]?.[0]);
  });
  it("publishes a tracker hint Today can tell apart from new mail, leaving the version", async () => {
    await publishTrackerHint("account-a", logger);
    expect(redis.publish).toHaveBeenCalledWith(
      "local-mail:account-a",
      TRACKER_HINT_MESSAGE,
    );
    expect(redis.eval).not.toHaveBeenCalled();
    expect(TRACKER_HINT_MESSAGE).not.toBe("{}");
  });
  it("fails open when Redis fails", async () => {
    vi.mocked(redis.eval).mockRejectedValue(new Error("Unavailable"));
    await expect(
      publishLocalMailHint("account-a", logger),
    ).resolves.toBeUndefined();
  });
});
