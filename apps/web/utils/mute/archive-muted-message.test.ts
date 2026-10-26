import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { createMockEmailProvider } from "@/utils/__mocks__/email-provider";
import {
  claimNewMailReaction,
  releaseNewMailReaction,
} from "@/utils/redis/new-mail-reaction";
import { archiveMutedMessage } from "./archive-muted-message";

vi.mock("@/utils/redis/new-mail-reaction", () => ({
  claimNewMailReaction: vi.fn(),
  releaseNewMailReaction: vi.fn(),
}));

const logger = createTestLogger();

async function archive(
  withoutClaim: "archive" | "skip",
  archiveMessage = vi.fn().mockResolvedValue(undefined),
) {
  const provider = createMockEmailProvider({ archiveMessage });
  const outcome = await archiveMutedMessage({
    emailAccountId: "account",
    messageId: "message",
    provider,
    withoutClaim,
    logger,
  });
  return { outcome, provider };
}

describe("archiveMutedMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimNewMailReaction).mockResolvedValue("claimed");
  });

  it("archives only the new message", async () => {
    const { outcome, provider } = await archive("skip");

    expect(outcome).toBe("archived");
    expect(provider.archiveMessage).toHaveBeenCalledExactlyOnceWith("message");
  });

  it("doesn't archive again once another path did", async () => {
    vi.mocked(claimNewMailReaction).mockResolvedValue("taken");

    const { outcome, provider } = await archive("archive");

    expect(outcome).toBe("already_handled");
    expect(provider.archiveMessage).not.toHaveBeenCalled();
  });

  it("releases its claim when the archive fails, so a retry can archive", async () => {
    const failure = new Error("offline");

    await expect(
      archive("archive", vi.fn().mockRejectedValue(failure)),
    ).rejects.toBe(failure);

    expect(releaseNewMailReaction).toHaveBeenCalledExactlyOnceWith({
      emailAccountId: "account",
      messageId: "message",
      logger,
    });
  });

  it.each([
    ["archive", "archived", 1],
    ["skip", "skipped", 0],
  ] as const)("with Redis down, a caller asking to %s gets %s", async (withoutClaim, expected, archives) => {
    vi.mocked(claimNewMailReaction).mockResolvedValue("unavailable");

    const { outcome, provider } = await archive(withoutClaim);

    expect(outcome).toBe(expected);
    expect(provider.archiveMessage).toHaveBeenCalledTimes(archives);
  });
});
