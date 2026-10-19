import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordingRedis } from "@/__tests__/mocks/recording-redis.mock";
import { summarise } from "@/app/api/ai/summarise/controller";
import { chatCompletionStream } from "@/utils/llms";

vi.mock("@/utils/redis", async () => ({
  redis: (await import("@/__tests__/mocks/recording-redis.mock")).recordingRedis
    .client,
}));
vi.mock("@/utils/llms", () => ({ chatCompletionStream: vi.fn() }));

describe("summarise", () => {
  beforeEach(() => {
    recordingRedis.reset();
    vi.clearAllMocks();
  });

  // RD-3: a summary is derived from the email, so it goes to the browser only.
  it("keeps neither the email nor its summary in the server cache", async () => {
    vi.mocked(chatCompletionStream).mockImplementation(async (options) => {
      await options.onEnd?.({ text: "Renewal priced at $48k" } as never);
      return {} as never;
    });

    await summarise({
      text: "Hi Sarah, the renewal is $48,000 per year.",
      userEmail: "me@example.com",
      userAi: { user: {}, userId: "u1", id: "a1" } as never,
    });

    expect(recordingRedis.everythingWritten()).not.toContain("Renewal");
    expect(recordingRedis.everythingWritten()).not.toContain("Sarah");
    expect(chatCompletionStream).toHaveBeenCalledTimes(1);
  });
});
