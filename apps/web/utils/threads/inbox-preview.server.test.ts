import { afterEach, describe, expect, it, vi } from "vitest";
import { loadInboxPreview } from "./inbox-preview.server";

const mocks = vi.hoisted(() => ({
  getMessagesWithPagination: vi.fn(),
  getThreadsWithQuery: vi.fn(),
  attachThreadPlans: vi.fn(),
  quotaContexts: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: async () => ({
    name: "google",
    getMessagesWithPagination: mocks.getMessagesWithPagination,
    getThreadsWithQuery: mocks.getThreadsWithQuery,
  }),
}));
vi.mock("@/utils/gmail/quota", () => ({
  runWithGmailQuota: (context: unknown, operation: () => unknown) => {
    mocks.quotaContexts.push(context);
    return operation();
  },
}));
vi.mock("@/utils/threads/load", () => ({
  attachThreadPlans: (input: unknown) => mocks.attachThreadPlans(input),
  toListThreads: (loaded: unknown) => loaded,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.quotaContexts = [];
});

describe("loadInboxPreview", () => {
  it("reads the newest inbox messages, about 205 Gmail units, at interactive priority", async () => {
    passPlansThrough();
    mocks.getMessagesWithPagination.mockResolvedValue({ messages: [] });

    await loadInboxPreview({ emailAccountId: "acc-1", provider: "google" });

    // A list (5 units) and ten message reads (20 each), in two batches of
    // 100 that each start the person's priority over sync. Whole threads
    // cost 40 each, 410 for ten, more than two seconds of Gmail's pace.
    expect(mocks.getMessagesWithPagination).toHaveBeenCalledWith({
      inboxOnly: true,
      maxResults: 10,
      // Headers are all a row shows, and a batch Gmail stops short still
      // shows what loaded.
      format: "metadata",
      allowPartial: true,
    });
    expect(mocks.getThreadsWithQuery).not.toHaveBeenCalled();
    expect(mocks.quotaContexts).toEqual([
      expect.objectContaining({
        caller: "mail/inbox-preview",
        priority: "interactive",
      }),
    ]);
  });

  it("lists each conversation once, newest first, its messages oldest first", async () => {
    passPlansThrough();
    mocks.getMessagesWithPagination.mockResolvedValue({
      messages: [
        message("m3", "t1", 3000),
        message("m2", "t2", 2000),
        message("m1", "t1", 1000),
      ],
    });

    const preview = await loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
    });

    expect(mocks.attachThreadPlans).toHaveBeenCalledWith(
      expect.objectContaining({ emailAccountId: "acc-1" }),
    );
    expect(
      preview?.threads.map((thread) => ({
        id: thread.id,
        messages: thread.messages.map((entry) => entry.id),
        snippet: thread.snippet,
      })),
    ).toEqual([
      { id: "t1", messages: ["m1", "m3"], snippet: "m3 snippet" },
      { id: "t2", messages: ["m2"], snippet: "m2 snippet" },
    ]);
  });

  it("gives up after a few seconds so the page is never held open for long", async () => {
    vi.useFakeTimers();
    mocks.getMessagesWithPagination.mockReturnValue(new Promise(() => {}));

    const preview = loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
    });
    await vi.advanceTimersByTimeAsync(6000);

    await expect(preview).resolves.toBeNull();
  });

  it("resolves to nothing when the provider fails", async () => {
    mocks.getMessagesWithPagination.mockRejectedValue(
      new Error("Gmail call deferred"),
    );

    await expect(
      loadInboxPreview({ emailAccountId: "acc-1", provider: "google" }),
    ).resolves.toBeNull();
  });
});

function passPlansThrough() {
  mocks.attachThreadPlans.mockImplementation(
    async ({ threads }: { threads: unknown[] }) => ({
      threads,
      nextPageToken: undefined,
    }),
  );
}

function message(id: string, threadId: string, receivedAtMs: number) {
  return {
    id,
    threadId,
    snippet: `${id} snippet`,
    subject: id,
    date: new Date(receivedAtMs).toISOString(),
    internalDate: String(receivedAtMs),
    labelIds: ["INBOX"],
    headers: { from: "a@example.com", to: "me@example.com", subject: id },
  };
}
