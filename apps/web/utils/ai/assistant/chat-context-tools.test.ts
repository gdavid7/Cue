import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { searchContext } from "@/utils/thread-context/search-context";
import { searchContextTool } from "./chat-context-tools";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/posthog", () => ({ posthogCaptureEvent: vi.fn() }));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(async () => ({ name: "google" })),
}));
vi.mock("@/utils/thread-context/search-context", () => ({
  searchContext: vi.fn(async () => ({ results: [] })),
}));

describe("searchContextTool", () => {
  const searchTool = searchContextTool({
    email: "david@example.com",
    emailAccountId: "account-1",
    provider: "google",
    logger: createTestLogger(),
  });

  function run(input: unknown) {
    const parsed = (
      searchTool.inputSchema as unknown as { parse: (value: unknown) => never }
    ).parse(input);
    return searchTool.execute!(parsed, {
      toolCallId: "1",
      messages: [],
    } as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("searches around the thread it's given", async () => {
    await run({ query: "status", threadId: "thread-1" });

    expect(searchContext).toHaveBeenCalledWith(
      expect.objectContaining({ query: "status", threadId: "thread-1" }),
    );
  });

  it("searches without a thread when none is given", async () => {
    await run({ query: "status", threadId: null });

    expect(vi.mocked(searchContext).mock.calls[0]?.[0].threadId).toBe(
      undefined,
    );
  });
});
