import { beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/utils/redis";
import { createScopedLogger } from "@/utils/logger";
import {
  TRACKER_HINT_MESSAGE,
  publishLocalMailHint,
  publishTrackerHint,
} from "./local-mail-hints";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/redis", () => ({
  redis: { publish: vi.fn() },
}));
const logger = createScopedLogger("local-mail-hints-test");

describe("local mail hints", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it("publishes every change, without message data, so a quick second email is not dropped", async () => {
    await publishLocalMailHint("account-a", logger);
    await publishLocalMailHint("account-a", logger);
    expect(redis.publish).toHaveBeenCalledTimes(2);
    expect(redis.publish).toHaveBeenCalledWith("local-mail:account-a", "{}");
  });
  it("publishes a tracker hint Today can tell apart from new mail", async () => {
    await publishTrackerHint("account-a", logger);
    expect(redis.publish).toHaveBeenCalledWith(
      "local-mail:account-a",
      TRACKER_HINT_MESSAGE,
    );
    expect(TRACKER_HINT_MESSAGE).not.toBe("{}");
  });
  it("fails open when Redis publish fails", async () => {
    vi.mocked(redis.publish).mockRejectedValue(new Error("Unavailable"));
    await expect(
      publishLocalMailHint("account-a", logger),
    ).resolves.toBeUndefined();
  });
});
