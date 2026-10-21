import { afterEach, describe, expect, it, vi } from "vitest";
import { loadInboxPreview } from "./inbox-preview.server";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import { GMAIL_RECENT_WINDOW_MS } from "@/utils/mail-api/source";
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

  it("reads the tab the inbox opens on, such as Gmail's Primary, by its labels", async () => {
    passPlansThrough();
    mocks.getMessagesWithPagination.mockResolvedValue({
      messages: [message("m1", "t1", 1000)],
    });

    const preview = await loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
      tab: { splitId: "primary", labelIds: ["INBOX", "CATEGORY_PERSONAL"] },
    });

    // The newest of the tab itself, not of the whole inbox, whose newest
    // mail is mostly other tabs'.
    expect(mocks.getMessagesWithPagination).toHaveBeenCalledWith({
      labelIds: ["INBOX", "CATEGORY_PERSONAL"],
      maxResults: 10,
      format: "metadata",
      allowPartial: true,
    });
    expect(preview).toMatchObject({
      splitId: "primary",
      threads: [expect.objectContaining({ id: "t1" })],
    });
  });

  it("catches a mailbox that fell behind up with twenty inbox messages, handing the engine all of them", async () => {
    passPlansThrough();
    const now = Date.now();
    mocks.getMessagesWithPagination.mockResolvedValue({
      messages: [
        message("m1", "t1", now - 1000),
        message("m2", "t2", now - GMAIL_RECENT_WINDOW_MS - 24 * 3_600_000),
      ],
    });

    const preview = await loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
      catchUp: true,
    });

    expect(mocks.getMessagesWithPagination).toHaveBeenCalledWith({
      inboxOnly: true,
      maxResults: 20,
      format: "metadata",
      allowPartial: true,
    });
    // Unlike a tab's, these are the inbox's own newest, so none is left out
    // for being older than a first sync reaches.
    expect(
      preview?.changes.map(
        (change) => change.kind === "message_patch" && change.key.messageId,
      ),
    ).toEqual(["m1", "m2"]);
  });

  it("marks rows read from the whole inbox as no tab's", async () => {
    passPlansThrough();
    mocks.getMessagesWithPagination.mockResolvedValue({ messages: [] });

    const preview = await loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
    });

    expect(preview?.splitId).toBeNull();
  });

  it("reads ahead the tab a new mailbox is about to open, for the mail engine only", async () => {
    passPlansThrough();
    const now = Date.now();
    mocks.getMessagesWithPagination.mockImplementation(
      async ({ labelIds }: { labelIds?: string[] }) => ({
        messages: labelIds
          ? [message("m2", "t2", now - 2000), message("m1", "t1", now - 3000)]
          : [message("m3", "t3", now - 1000), message("m2", "t2", now - 2000)],
      }),
    );

    const preview = await loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
      readAhead: ["INBOX", "CATEGORY_PERSONAL"],
    });

    expect(mocks.getMessagesWithPagination).toHaveBeenCalledWith(
      expect.objectContaining({ labelIds: ["INBOX", "CATEGORY_PERSONAL"] }),
    );
    // The rows are still the whole inbox the page shows...
    expect(preview?.threads.map((thread) => thread.id)).toEqual(["t3", "t2"]);
    // ...and the engine gets each message once, so Primary already has mail
    // when the person picks it.
    expect(
      preview?.changes.map(
        (change) => change.kind === "message_patch" && change.key.messageId,
      ),
    ).toEqual(["m3", "m2", "m1"]);
  });

  it("still shows the inbox when reading ahead fails", async () => {
    passPlansThrough();
    mocks.getMessagesWithPagination.mockImplementation(
      async ({ labelIds }: { labelIds?: string[] }) => {
        if (labelIds) throw new GmailCallDeferredError(1000, "interactive");
        return { messages: [message("m1", "t1", Date.now())] };
      },
    );

    const preview = await loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
      readAhead: ["INBOX", "CATEGORY_PERSONAL"],
    });

    expect(preview?.threads.map((thread) => thread.id)).toEqual(["t1"]);
    // A deferral of the guess is not waited out for another try.
    expect(mocks.getMessagesWithPagination).toHaveBeenCalledTimes(2);
  });

  it("does not read ahead again when the rows wait out a quota deferral", async () => {
    vi.useFakeTimers();
    passPlansThrough();
    mocks.getMessagesWithPagination.mockImplementation(
      async ({ labelIds }: { labelIds?: string[] }) => {
        if (labelIds) return { messages: [] };
        if (mocks.getMessagesWithPagination.mock.calls.length <= 2)
          throw new GmailCallDeferredError(1000, "interactive");
        return { messages: [message("m1", "t1", Date.now())] };
      },
    );

    const preview = loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
      readAhead: ["INBOX", "CATEGORY_PERSONAL"],
    });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(preview).resolves.toMatchObject({
      threads: [expect.objectContaining({ id: "t1" })],
    });
    const readAheads = mocks.getMessagesWithPagination.mock.calls.filter(
      ([options]) => options.labelIds,
    );
    expect(readAheads).toHaveLength(1);
  });

  it("hands the engine a tab's mail only from the window its first sync covers", async () => {
    passPlansThrough();
    const now = Date.now();
    const weeksAgo = now - 21 * 24 * 60 * 60 * 1000;
    mocks.getMessagesWithPagination.mockImplementation(
      async ({ labelIds }: { labelIds?: string[] }) => ({
        messages: labelIds
          ? [
              message("recent", "t1", now - 1000),
              message("old", "t2", weeksAgo),
            ]
          : [message("inbox", "t3", now - 500)],
      }),
    );

    const preview = await loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
      readAhead: ["INBOX", "CATEGORY_PERSONAL"],
    });
    const tabPreview = await loadInboxPreview({
      emailAccountId: "acc-1",
      provider: "google",
      tab: { splitId: "primary", labelIds: ["INBOX", "CATEGORY_PERSONAL"] },
    });

    // Older mail arrives with the engine's backfill, next to the mail around
    // it, and only if it is still where it was.
    const handedOver = (loaded: typeof preview) =>
      loaded?.changes.map(
        (change) => change.kind === "message_patch" && change.key.messageId,
      );
    expect(handedOver(preview)).toEqual(["inbox", "recent"]);
    expect(handedOver(tabPreview)).toEqual(["recent"]);
    // The tab still shows its newest rows while the engine syncs.
    expect(tabPreview?.threads.map((thread) => thread.id)).toEqual([
      "t1",
      "t2",
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
    const changes = read.map((entry) =>
      parsedMessagePatch("acc-1", "google", entry as unknown as ParsedMessage),
    );
    expect(preview?.changes).toEqual(
      changes.map((change) => ({
        ...change,
        // A metadata read can't tell, so it leaves the stored flag alone.
        fields: expect.not.objectContaining({ hasAttachments: false }),
      })),
    );
    expect(preview?.changes?.[0]).toMatchObject({
      kind: "message_patch",
      key: { accountId: "acc-1", messageId: "m2" },
    });
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
