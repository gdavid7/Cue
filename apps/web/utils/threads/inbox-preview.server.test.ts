import { afterEach, describe, expect, it, vi } from "vitest";
import { loadInboxPreview } from "./inbox-preview.server";

const mocks = vi.hoisted(() => ({
  loadThreads: vi.fn(),
  quotaContexts: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: async () => ({ name: "google" }),
}));
vi.mock("@/utils/split-inbox/native-categories", () => ({
  resolveNativeThreadsQuery: async ({ query }: { query: unknown }) => query,
}));
vi.mock("@/utils/gmail/quota", () => ({
  runWithGmailQuota: (context: unknown, operation: () => unknown) => {
    mocks.quotaContexts.push(context);
    return operation();
  },
}));
vi.mock("@/utils/threads/load", () => ({
  loadThreads: (input: unknown) => mocks.loadThreads(input),
  toListThreads: (loaded: unknown) => loaded,
}));

afterEach(() => {
  vi.useRealTimers();
  mocks.loadThreads.mockReset();
  mocks.quotaContexts = [];
});

describe("loadInboxPreview", () => {
  it("asks for the first screen of the inbox at interactive priority, waiting little", async () => {
    mocks.loadThreads.mockResolvedValue({ threads: [], nextPageToken: null });

    await loadInboxPreview({ emailAccountId: "acc-1", provider: "google" });

    // Ten conversations fit Gmail's per-second pacing; the engine fills the rest.
    expect(mocks.loadThreads).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ type: "inbox", limit: 10 }),
        messageFormat: "metadata",
      }),
    );
    expect(mocks.quotaContexts).toEqual([
      expect.objectContaining({
        priority: "interactive",
        maxTotalWaitMs: 2500,
      }),
    ]);
  });

  it("gives up after a few seconds so the page is never held open", async () => {
    vi.useFakeTimers();
    mocks.loadThreads.mockReturnValue(new Promise(() => {}));

    const preview = loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
    });
    await vi.advanceTimersByTimeAsync(3000);

    await expect(preview).resolves.toBeNull();
  });

  it("resolves to nothing when the provider fails", async () => {
    mocks.loadThreads.mockRejectedValue(new Error("Gmail call deferred"));

    await expect(
      loadInboxPreview({ emailAccountId: "acc-1", provider: "google" }),
    ).resolves.toBeNull();
  });
});
