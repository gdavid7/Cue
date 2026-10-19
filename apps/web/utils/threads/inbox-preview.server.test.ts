import { afterEach, describe, expect, it, vi } from "vitest";
import { loadInboxPreview } from "./inbox-preview.server";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import { parsedMessagePatch } from "@/utils/mail-api/observations";
import type { ParsedMessage } from "@/utils/types";

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
vi.mock("@/utils/gmail/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/gmail/quota")>()),
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
  it("reads the newest inbox messages as headers, at interactive priority, waiting up to four seconds", async () => {
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
        maxTotalWaitMs: 4000,
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

  it("carries the rows' messages as the mail engine records a metadata read", async () => {
    passPlansThrough();
    const read = [message("m2", "t2", 2000), message("m1", "t1", 1000)];
    mocks.getMessagesWithPagination.mockResolvedValue({ messages: read });

    const preview = await loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
    });

    // The engine shows these as its own rows, ready to open and triage,
    // before its first sync reads them again.
    expect(preview?.changes).toEqual(
      read.map((entry) =>
        parsedMessagePatch(
          "acc-1",
          "google",
          entry as unknown as ParsedMessage,
          {
            format: "metadata",
          },
        ),
      ),
    );
  });

  it("keys each row by the id the mail engine gives its conversation, for Outlook too", async () => {
    passPlansThrough();
    // Outlook's conversationId, as the message parser sets it.
    const outlook = message("AAMk-msg", "AAQk-conversation=", 1000);
    mocks.getMessagesWithPagination.mockResolvedValue({ messages: [outlook] });

    const preview = await loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "microsoft",
    });

    const patch = parsedMessagePatch(
      "acc-1",
      "microsoft",
      outlook as unknown as ParsedMessage,
    );
    // A click opens the row's id, which the engine must know by that id.
    expect(patch.kind === "message_patch" && patch.reference).toMatchObject({
      conversationId: preview?.threads[0]?.id,
      messageId: preview?.threads[0]?.messages[0]?.id,
    });
  });

  it("gives up after a few seconds so the page is never held open for long", async () => {
    vi.useFakeTimers();
    mocks.getMessagesWithPagination.mockReturnValue(new Promise(() => {}));

    const preview = loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
    });
    await vi.advanceTimersByTimeAsync(7500);

    await expect(preview).resolves.toBeNull();
  });

  it("waits out a short Gmail quota deferral and still shows the rows", async () => {
    vi.useFakeTimers();
    passPlansThrough();
    mocks.getMessagesWithPagination
      .mockRejectedValueOnce(new GmailCallDeferredError(1000, "interactive"))
      .mockResolvedValueOnce({ messages: [message("m1", "t1", 1000)] });

    const preview = loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
    });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(preview).resolves.toMatchObject({
      threads: [expect.objectContaining({ id: "t1" })],
    });
    expect(mocks.getMessagesWithPagination).toHaveBeenCalledTimes(2);
  });

  it("does not load again once the preview has given up", async () => {
    vi.useFakeTimers();
    mocks.getMessagesWithPagination.mockImplementationOnce(
      () =>
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new GmailCallDeferredError(2000, "interactive")),
            6000,
          ),
        ),
    );

    const preview = loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(preview).resolves.toBeNull();
    // Nobody is waiting for these rows, so the quota is left to the engine.
    expect(mocks.getMessagesWithPagination).toHaveBeenCalledTimes(1);
  });

  it("does not wait out a long Gmail quota deferral", async () => {
    vi.useFakeTimers();
    mocks.getMessagesWithPagination.mockRejectedValue(
      new GmailCallDeferredError(30_000, "interactive"),
    );

    const preview = loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(preview).resolves.toBeNull();
    expect(mocks.getMessagesWithPagination).toHaveBeenCalledTimes(1);
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
