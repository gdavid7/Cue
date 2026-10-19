import { GraphError } from "@microsoft/microsoft-graph-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { admitGmailCall, GmailCallDeferredError } from "@/utils/gmail/quota";
import {
  compactMailboxSyncMessage,
  decodeMailboxSyncCursor,
  encodeMailboxSyncCursor,
  InvalidMailboxSyncCursorError,
} from "@/utils/email/mailbox-sync";
import { ProviderRateLimitModeError } from "@/utils/email/rate-limit-mode-error";
import { syncPageSchema } from "@inboxzero/mail-core/sync";
import { createEmailProviderMailboxSource } from "./source";
import { searchQueryToPredicate } from "@/utils/mail-search/search-query-predicate";
import { currentGmailQuotaContext } from "@/utils/gmail/quota";
import type { EmailProvider } from "@/utils/email/types";
import type { ParsedMessage } from "@/utils/types";
import { createTestLogger } from "@/__tests__/helpers";
import {
  createHostRuntime,
  createMailEngine,
} from "@inboxzero/mail-core/engine";
import { createNodeSqliteDriver } from "@inboxzero/mail-sqlite/node";
import { createSqliteMailStore } from "@inboxzero/mail-sqlite/store";
import { redis } from "@/utils/redis";
import { forgetEmailProviderRateLimitState } from "@/utils/redis/email-provider-rate-limit";
import {
  LocalMailSyncPausedError,
  withLocalMailSyncBudget,
} from "@/utils/email/local-mail-sync-budget";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn(), eval: vi.fn() },
}));
vi.mock("@/utils/email/local-mail-sync-budget", async (original) => ({
  ...(await original<typeof import("@/utils/email/local-mail-sync-budget")>()),
  withLocalMailSyncBudget: vi.fn(
    (_input: unknown, operation: (signal: AbortSignal) => Promise<unknown>) =>
      operation(new AbortController().signal),
  ),
}));

const logger = createTestLogger();

beforeEach(() => {
  vi.mocked(withLocalMailSyncBudget).mockClear();
});

describe("createEmailProviderMailboxSource", () => {
  it("continues provider search after the first page", async () => {
    const searchMessages = vi.fn(
      async ({ pageToken }: { pageToken?: string }) => ({
        messages: [searchMessage(pageToken ? "second" : "first")],
        nextPageToken: pageToken ? undefined : "next-page",
      }),
    );
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: { name: "google", searchMessages } as unknown as EmailProvider,
    });
    const input = {
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "search-1",
      signal: new AbortController().signal,
      predicate: {
        kind: "text",
        field: "any",
        value: "invoice",
        match: "phrase",
      } as const,
      pageSize: 20,
    };
    await expect(
      source.search({ ...input, page: null }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { matches: [{ messageId: "first" }], nextPage: "next-page" },
    });
    await expect(
      source.search({ ...input, page: "next-page" }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { matches: [{ messageId: "second" }], nextPage: null },
    });
    expect(searchMessages).toHaveBeenLastCalledWith({
      query: "",
      mailboxSearch: {
        mailbox: "all",
        text: { kind: "text", field: "any", value: "invoice", match: "phrase" },
      },
      maxResults: 20,
      pageToken: "next-page",
    });
  });

  it("caps Microsoft provider searches to Outlook list page size", async () => {
    const searchMessages = vi.fn(
      async ({ pageToken }: { pageToken?: string }) => ({
        messages: [searchMessage(pageToken ? "second" : "first")],
        nextPageToken: pageToken ? undefined : "next-page",
      }),
    );
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "microsoft",
        searchMessages,
      } as unknown as EmailProvider,
    });
    await source.search({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "search-1",
      signal: new AbortController().signal,
      predicate: {
        kind: "text",
        field: "any",
        value: "invoice",
        match: "phrase",
      },
      page: null,
      pageSize: 50,
    });
    expect(searchMessages).toHaveBeenCalledWith({
      query: "",
      mailboxSearch: {
        mailbox: "all",
        text: { kind: "text", field: "any", value: "invoice", match: "phrase" },
      },
      maxResults: 20,
      pageToken: undefined,
    });
  });

  it("reports a search the provider rejects as unsupported so it is not retried", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "microsoft",
        searchMessages: vi.fn(async () => {
          throw Object.assign(new Error("Syntax error in search query"), {
            statusCode: 400,
          });
        }),
      } as unknown as EmailProvider,
    });
    await expect(
      source.search(searchInput("acc-1", { value: "to:someone" })),
    ).resolves.toEqual({ status: "unsupported" });
  });

  it("pauses a search when the provider fails transiently", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        searchMessages: vi.fn(async () => {
          throw Object.assign(new Error("Backend error"), { status: 503 });
        }),
      } as unknown as EmailProvider,
    });
    await expect(
      source.search(searchInput("acc-1", { value: "invoice" })),
    ).resolves.toMatchObject({ status: "paused", reason: "unavailable" });
  });

  it("includes spam when the search predicate is scoped to that mailbox", async () => {
    const searchMessages = vi.fn(async () => ({
      messages: [searchMessage("spam-hit", ["SPAM"])],
      nextPageToken: undefined,
    }));
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: { name: "google", searchMessages } as unknown as EmailProvider,
    });
    await expect(
      source.search({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "search-spam",
        signal: new AbortController().signal,
        predicate: {
          kind: "all",
          predicates: [
            { kind: "text", field: "any", value: "invoice", match: "phrase" },
            { kind: "mailbox", mailbox: "spam" },
          ],
        },
        page: null,
        pageSize: 20,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { matches: [{ messageId: "spam-hit" }] },
    });
    expect(searchMessages).toHaveBeenCalledWith({
      query: "",
      mailboxSearch: {
        mailbox: "spam",
        text: { kind: "text", field: "any", value: "invoice", match: "phrase" },
      },
      maxResults: 20,
      pageToken: undefined,
    });
  });

  it("retries conversation membership when the provider is unavailable", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        async getThread() {
          throw new Error("503 Service unavailable");
        },
      } as unknown as EmailProvider,
    });
    await expect(
      source.readConversationMembership({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "membership-1",
        signal: new AbortController().signal,
        conversation: { accountId: "acc-1", conversationId: "c-1" },
        resolutionId: "resolution-1",
        page: null,
        pageSize: 20,
      }),
    ).resolves.toMatchObject({ status: "paused", reason: "unavailable" });
  });

  it("requests a scoped rebuild when the provider cursor is expired", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        localMailSyncStrategy: "history",
        async getMailboxSyncPage() {
          throw new InvalidMailboxSyncCursorError();
        },
        async getMessagesWithPagination() {
          throw new InvalidMailboxSyncCursorError();
        },
      } as unknown as EmailProvider,
    });
    const result = await source.readChanges({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      position: {
        streamId: "primary",
        generation: "g1",
        checkpoint: "expired",
      },
      pageSize: 20,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      status: "reset_required",
      scopeId: "primary",
    });
  });

  it("treats an explicit reset page as expired history", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "microsoft",
        localMailSyncStrategy: "folder-delta",
        async getMailboxSyncPage() {
          return {
            reset: true,
            cursor: "",
            upsertedMessages: [],
            deletedMessageIds: [],
            hasMore: false,
          };
        },
      } as unknown as EmailProvider,
    });
    const result = await source.readChanges({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      position: {
        streamId: "inbox",
        generation: "g1",
        checkpoint: "delta",
      },
      pageSize: 20,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      status: "reset_required",
      scopeId: "inbox",
    });
  });

  it("pauses catch-up when the provider is throttled", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        localMailSyncStrategy: "history",
        async getMailboxSyncPage() {
          throw new ProviderRateLimitModeError({ provider: "google" });
        },
        async getMessagesWithPagination() {
          throw new ProviderRateLimitModeError({ provider: "google" });
        },
      } as unknown as EmailProvider,
    });
    const result = await source.readChanges({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      position: {
        streamId: "primary",
        generation: "g1",
        checkpoint: "1",
      },
      pageSize: 20,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "paused",
      reason: "throttled",
    });
  });

  describe("Graph throttling", () => {
    const session = { accountId: "acc-1", generation: "g1" };
    const signal = new AbortController().signal;
    const calls: Array<
      [
        string,
        (
          source: ReturnType<typeof createEmailProviderMailboxSource>,
        ) => Promise<unknown>,
      ]
    > = [
      [
        "discovering folders",
        (source) =>
          source.discoverScopes({ session, page: null, signal } as never),
      ],
      [
        "starting a folder bootstrap",
        (source) =>
          source.beginBootstrap({
            session,
            scope: { id: "inbox-id", kind: "folder", folderId: "inbox-id" },
            afterMs: 0,
            signal,
          } as never),
      ],
      [
        "enumerating a folder",
        (source) =>
          source.enumerate({
            session,
            page: JSON.stringify({ scopeId: "inbox-id", folderId: "inbox-id" }),
            pageSize: 20,
            signal,
          } as never),
      ],
      [
        "reading folder changes",
        (source) =>
          source.readChanges({
            session,
            requestId: "r1",
            position: {
              streamId: "inbox-id",
              generation: "g1",
              checkpoint: "1",
            },
            pageSize: 20,
            signal,
          }),
      ],
      [
        "hydrating bodies",
        (source) =>
          source.hydrate({
            session,
            requestId: "r1",
            signal,
            keys: [{ accountId: "acc-1", messageId: "m1" }],
            purpose: "body",
          }),
      ],
      [
        "reading a conversation",
        (source) =>
          source.readConversationMembership({
            session,
            conversation: { accountId: "acc-1", conversationId: "c1" },
            resolutionId: "res-1",
            page: null,
            pageSize: 20,
            signal,
          } as never),
      ],
      [
        "searching",
        (source) =>
          source.search({
            session,
            predicate: { kind: "text", field: "any", value: "invoice" },
            page: null,
            pageSize: 20,
            signal,
          } as never),
      ],
    ];

    it.each(
      calls,
    )("pauses for Graph's Retry-After when %s is throttled", async (_name, call) => {
      // Each case records a window for the same account. Without this, the
      // previous case's window stays in this instance's rate-limit memo, and a
      // case that starts within the same millisecond sees an equal window
      // already recorded and correctly skips the write.
      forgetEmailProviderRateLimitState("acc-1");
      vi.mocked(redis.get).mockResolvedValue(null);
      vi.mocked(redis.set).mockClear();
      const throttle = () => {
        const error = new GraphError(
          429,
          "Application is over its MailboxConcurrency limit.",
        );
        error.code = "ApplicationThrottled";
        error.headers = new Headers({ "Retry-After": "7" });
        throw error;
      };
      const source = createEmailProviderMailboxSource({
        logger,
        accountId: "acc-1",
        provider: {
          name: "microsoft",
          localMailSyncStrategy: "folder-delta",
          getFolders: throttle,
          getMailboxSyncPage: throttle,
          getMessagesWithPagination: throttle,
          getMessagesBatch: throttle,
          getThread: throttle,
          getThreadMessages: throttle,
          searchMessages: throttle,
        } as unknown as EmailProvider,
      });

      const result = await call(source);

      expect(result).toEqual({
        status: "paused",
        reason: "throttled",
        retryAfterMs: 7000,
      });
      expect(redis.set).toHaveBeenCalledWith(
        "email-provider-rate-limit:acc-1",
        expect.any(String),
        expect.anything(),
      );
    });
  });

  it("does not replace a failed delta cursor with a mailbox list page token", async () => {
    const getMessagesWithPagination = vi.fn();
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        localMailSyncStrategy: "history",
        async getMailboxSyncPage() {
          throw new Error("provider down");
        },
        getMessagesWithPagination,
      } as unknown as EmailProvider,
    });
    const result = await source.readChanges({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      position: {
        streamId: "primary",
        generation: "g1",
        checkpoint: "history-cursor",
      },
      pageSize: 20,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      status: "paused",
      retryAfterMs: 1000,
      reason: "unavailable",
    });
    expect(getMessagesWithPagination).not.toHaveBeenCalled();
  });

  it("exposes Outlook folders as sync scopes, with custom folders at low priority", async () => {
    const getFolders = vi.fn().mockResolvedValue([
      {
        id: "inbox",
        displayName: "Inbox",
        systemType: "INBOX",
        childFolders: [{ id: "child", displayName: "Child", childFolders: [] }],
      },
      {
        id: "archive",
        displayName: "Archive",
        systemType: "ARCHIVE",
        childFolders: [],
      },
    ]);
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "microsoft",
        localMailSyncStrategy: "folder-delta",
        getFolders,
      } as unknown as EmailProvider,
    });
    const result = await source.discoverScopes({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      page: null,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      status: "ok",
      value: {
        scopes: [
          { id: "inbox", kind: "folder", folderId: "inbox", priority: "high" },
          { id: "child", kind: "folder", folderId: "child", priority: "low" },
          {
            id: "archive",
            kind: "folder",
            folderId: "archive",
            priority: "high",
          },
        ],
        nextPage: null,
      },
    });
    expect(getFolders).toHaveBeenCalled();
  });

  it("enumerates an Outlook folder scope and starts catch-up from its folder cursor", async () => {
    const getMailboxSyncPage = vi.fn().mockResolvedValue({
      cursor: "folder-cursor",
      reset: true,
      upsertedMessages: [],
      deletedMessageIds: [],
      hasMore: false,
    });
    const getMessagesWithPagination = vi.fn().mockResolvedValue({
      messages: [],
    });
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "microsoft",
        localMailSyncStrategy: "folder-delta",
        getMailboxSyncPage,
        getMessagesWithPagination,
      } as unknown as EmailProvider,
    });
    const bootstrap = await source.beginBootstrap({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r-bootstrap",
      signal: new AbortController().signal,
      scope: { id: "archive", kind: "folder", folderId: "archive" },
      afterMs: 0,
    });
    expect(bootstrap.status).toBe("ok");
    if (bootstrap.status !== "ok") throw new Error("expected ok");
    expect(bootstrap.value.catchUpFrom).toEqual({
      streamId: "archive",
      generation: "g1",
      checkpoint: "folder-cursor",
    });
    const result = await source.enumerate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      bootstrapId: bootstrap.value.bootstrapId,
      page: bootstrap.value.enumerationToken,
      pageSize: 25,
    });
    expect(result).toMatchObject({
      status: "ok",
      value: {
        scopeId: "archive",
        catchUpFrom: {
          streamId: "archive",
          checkpoint: "folder-cursor",
        },
      },
    });
    expect(getMessagesWithPagination).toHaveBeenCalledWith({
      maxResults: 20,
      folderId: "archive",
      pageToken: undefined,
      includeDrafts: true,
    });
    expect(getMailboxSyncPage).toHaveBeenCalledWith({
      after: new Date(0),
      folderId: "archive",
      includeBodies: true,
      limit: 1,
    });
  });

  it("keeps the bootstrap catch-up cursor across paged enumeration", async () => {
    const getMailboxSyncPage = vi.fn().mockResolvedValueOnce({
      cursor: "before-enumeration-cursor",
      reset: true,
      upsertedMessages: [],
      deletedMessageIds: [],
      hasMore: true,
    });
    const getMessagesWithPagination = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [],
        nextPageToken: "page-2",
      })
      .mockResolvedValueOnce({
        messages: [],
      });
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "microsoft",
        localMailSyncStrategy: "folder-delta",
        getMailboxSyncPage,
        getMessagesWithPagination,
      } as unknown as EmailProvider,
    });
    const bootstrap = await source.beginBootstrap({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r-bootstrap",
      signal: new AbortController().signal,
      scope: { id: "archive", kind: "folder", folderId: "archive" },
      afterMs: 0,
    });
    expect(bootstrap.status).toBe("ok");
    if (bootstrap.status !== "ok") throw new Error("expected ok");

    const firstPage = await source.enumerate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      bootstrapId: bootstrap.value.bootstrapId,
      page: bootstrap.value.enumerationToken,
      pageSize: 25,
    });
    expect(firstPage.status).toBe("ok");
    if (firstPage.status !== "ok") throw new Error("expected ok");
    expect(firstPage.value.nextPage).toBeTruthy();
    if (!firstPage.value.nextPage) throw new Error("expected next page");

    const finalPage = await source.enumerate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r2",
      signal: new AbortController().signal,
      bootstrapId: bootstrap.value.bootstrapId,
      page: firstPage.value.nextPage,
      pageSize: 25,
    });

    expect(finalPage).toMatchObject({
      status: "ok",
      value: {
        nextPage: null,
        catchUpFrom: {
          streamId: "archive",
          generation: "g1",
          checkpoint: "before-enumeration-cursor",
        },
      },
    });
    expect(getMailboxSyncPage).toHaveBeenCalledTimes(1);
  });

  it("maps folder delta removals to removed-from-scope changes", async () => {
    const deltaCursor = `folder-cursor-${"x".repeat(2000)}`;
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "microsoft",
        localMailSyncStrategy: "folder-delta",
        async getMailboxSyncPage() {
          return {
            cursor: deltaCursor,
            reset: false,
            upsertedMessages: [],
            deletedMessageIds: ["deleted-1"],
            removedMessageIds: ["moved-1"],
            hasMore: false,
          };
        },
      } as unknown as EmailProvider,
    });
    const result = await source.readChanges({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      position: {
        streamId: "archive",
        generation: "g1",
        checkpoint: "folder-cursor",
      },
      pageSize: 20,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "page",
      page: {
        changes: [
          {
            kind: "message_deleted",
            key: { accountId: "acc-1", messageId: "deleted-1" },
          },
          {
            kind: "removed_from_scope",
            key: { accountId: "acc-1", messageId: "moved-1" },
            scopeId: "archive",
          },
        ],
      },
    });
    if (result.status !== "page") throw new Error("expected a page");
    expect(() => syncPageSchema.parse(result.page)).not.toThrow();
  });

  it("hydrates delta meeting invitations instead of storing an empty body", async () => {
    const invitation = compactMailboxSyncMessage({
      id: "invite-1",
      threadId: "t1",
      historyId: "12",
      date: "2026-01-01T00:00:00.000Z",
      subject: "Invite",
      snippet: "A new event has been scheduled",
      headers: { from: "ada@example.com", to: "me@example.com", date: "" },
      labelIds: ["INBOX"],
      textHtml: "<p>A new event has been scheduled</p>",
      textPlain: "A new event has been scheduled",
      isMeetingInvitation: true,
      inline: [],
    } as ParsedMessage);
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        localMailSyncStrategy: "history",
        async getMailboxSyncPage() {
          return {
            cursor: "next",
            reset: false,
            upsertedMessages: [invitation],
            deletedMessageIds: [],
            hasMore: false,
          };
        },
      } as unknown as EmailProvider,
    });
    const result = await source.readChanges({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      position: { streamId: "primary", generation: "g1", checkpoint: "1" },
      pageSize: 20,
      signal: new AbortController().signal,
    });
    if (result.status !== "page") throw new Error("expected a page");
    expect(result.page.bodies ?? []).toEqual([]);
    expect(result.page.requiredHydration).toEqual([
      { accountId: "acc-1", messageId: "invite-1" },
    ]);
  });

  it("batches folder reads, warming the provider with the first and capping concurrency", async () => {
    const folders = ["inbox", "a", "b", "c", "d", "e"];
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "microsoft",
        localMailSyncStrategy: "folder-delta",
        async getMailboxSyncPage({ folderId }: { folderId: string }) {
          started.push(`${folderId}:${inFlight}`);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return {
            cursor: `${folderId}-next`,
            reset: false,
            upsertedMessages: [],
            deletedMessageIds: [],
            removedMessageIds: [],
            hasMore: false,
          };
        },
      } as unknown as EmailProvider,
    });

    const results = await source.readChangesBatch({
      session: { accountId: "acc-1", generation: "g1" },
      reads: folders.map((streamId, index) => ({
        requestId: `r${index}`,
        position: { streamId, generation: "g1", checkpoint: "cursor" },
      })),
      pageSize: 20,
      signal: new AbortController().signal,
    });

    expect(started[0]).toBe("inbox:0");
    expect(started[1]).toBe("a:0");
    expect(maxInFlight).toBe(3);
    expect(
      results.map(
        (result) => result.status === "page" && result.page.to.checkpoint,
      ),
    ).toEqual(folders.map((folder) => `${folder}-next`));
  });

  // Opening a conversation fills it from membership. A draft-only one used
  // to resolve to no messages, so the reader stayed blank until a full sync
  // happened to bring the draft.
  it("lists the drafts of a conversation that has nothing else", async () => {
    const source = membershipSource([{ id: "draft", labelIds: ["DRAFT"] }]);
    expect(await readMembershipKeys(source)).toEqual(["draft"]);
  });

  // Triage commands act on membership, so drafts beside other messages stay
  // out of it: archiving a conversation must not move its unsent reply.
  it("leaves drafts out of a conversation that has other messages", async () => {
    const source = membershipSource([
      { id: "received", labelIds: ["INBOX"] },
      { id: "draft", labelIds: ["DRAFT"] },
    ]);
    expect(await readMembershipKeys(source)).toEqual(["received"]);
  });

  it("pages conversation membership instead of truncating the thread", async () => {
    const messages = Array.from({ length: 3 }, (_, index) => ({
      id: `m${index + 1}`,
      threadId: "c1",
      headers: { from: "ada@example.com" },
      labelIds: ["INBOX"],
      snippet: `m${index + 1}`,
    }));
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        async getThread() {
          return { messages, historyId: "h1" };
        },
      } as unknown as EmailProvider,
    });
    const first = await source.readConversationMembership({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      conversation: { accountId: "acc-1", conversationId: "c1" },
      resolutionId: "res",
      page: null,
      pageSize: 2,
    });
    expect(first).toMatchObject({
      status: "ok",
      value: {
        status: "page",
        page: {
          nextPage: "2",
          keys: [
            { accountId: "acc-1", messageId: "m1" },
            { accountId: "acc-1", messageId: "m2" },
          ],
        },
      },
    });
    const second = await source.readConversationMembership({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r2",
      signal: new AbortController().signal,
      conversation: { accountId: "acc-1", conversationId: "c1" },
      resolutionId: "res",
      page: "2",
      pageSize: 2,
    });
    expect(second).toMatchObject({
      status: "ok",
      value: {
        status: "page",
        page: {
          nextPage: null,
          keys: [{ accountId: "acc-1", messageId: "m3" }],
        },
      },
    });
  });

  it("enumerates mailbox pages including drafts", async () => {
    const getMessagesWithPagination = vi.fn().mockResolvedValue({
      messages: [],
    });
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMessagesWithPagination,
        async getMailboxSyncPage() {
          return {
            cursor: "gmail-cursor",
            reset: true,
            upsertedMessages: [],
            deletedMessageIds: [],
            hasMore: false,
          };
        },
      } as unknown as EmailProvider,
    });
    await source.enumerate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      bootstrapId: "mailbox",
      page: "{}",
      pageSize: 50,
    });
    // A scan's first Gmail page is smaller so the inbox fills sooner.
    expect(getMessagesWithPagination).toHaveBeenCalledWith({
      maxResults: 25,
      pageToken: undefined,
      includeDrafts: true,
    });
  });

  it("advertises and uses the Outlook list page size for Microsoft enumeration", async () => {
    const getMessagesWithPagination = vi.fn().mockResolvedValue({
      messages: [],
    });
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "microsoft",
        localMailSyncStrategy: "folder-delta",
        getMessagesWithPagination,
      } as unknown as EmailProvider,
    });
    await expect(
      source.describe({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "describe-1",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { maxPageSize: 20 },
    });
    await source.enumerate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      bootstrapId: "mailbox",
      page: JSON.stringify({ folderId: "inbox", scopeId: "inbox" }),
      pageSize: 50,
    });
    expect(getMessagesWithPagination).toHaveBeenCalledWith({
      maxResults: 20,
      folderId: "inbox",
      pageToken: undefined,
      includeDrafts: true,
    });
  });

  it("stores a provider history cursor when enumeration finishes", async () => {
    const cursor = encodeMailboxSyncCursor({
      version: 1,
      provider: "google",
      phase: "delta",
      historyId: "42",
      after: "1970-01-01T00:00:00.000Z",
    });
    const getMailboxSyncPage = vi.fn().mockResolvedValue({
      cursor,
      reset: true,
      upsertedMessages: [],
      deletedMessageIds: [],
      hasMore: false,
    });
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMailboxSyncPage,
        async getMessagesWithPagination() {
          return {
            messages: [
              {
                id: "m1",
                threadId: "t1",
                historyId: "9",
                headers: { from: "ada@example.com" },
                labelIds: ["INBOX"],
                snippet: "Hi",
              },
            ],
          };
        },
      } as unknown as EmailProvider,
    });
    const result = await source.enumerate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      bootstrapId: "mailbox",
      page: "{}",
      pageSize: 50,
    });
    expect(result).toMatchObject({
      status: "ok",
      value: {
        nextPage: null,
        catchUpFrom: {
          streamId: "primary",
          generation: "g1",
          checkpoint: cursor,
        },
      },
    });
    expect(getMailboxSyncPage).toHaveBeenCalledWith({
      after: new Date(0),
      includeBodies: true,
      limit: 1,
    });
  });

  it("encodes the newest Gmail history id when the provider cursor is unavailable", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        async getMailboxSyncPage() {
          throw new Error("profile unavailable");
        },
        async getMessagesWithPagination() {
          return {
            messages: [
              {
                id: "old",
                threadId: "t1",
                historyId: "10",
                headers: { from: "ada@example.com" },
                labelIds: ["INBOX"],
                snippet: "Old",
              },
              {
                id: "new",
                threadId: "t2",
                historyId: "99",
                headers: { from: "ada@example.com" },
                labelIds: ["INBOX"],
                snippet: "New",
              },
            ],
          };
        },
      } as unknown as EmailProvider,
    });
    const result = await source.enumerate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      bootstrapId: "mailbox",
      page: "{}",
      pageSize: 50,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value.nextPage).toBeNull();
    if (result.value.nextPage !== null) throw new Error("expected last page");
    expect(
      decodeMailboxSyncCursor(
        result.value.catchUpFrom.checkpoint ?? "",
        "google",
      ),
    ).toMatchObject({
      historyId: "99",
      phase: "delta",
      provider: "google",
    });
  });

  it("returns enumerated bodies when the provider already fetched them", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        async getMessagesWithPagination() {
          return {
            messages: [
              {
                id: "draft-1",
                threadId: "t1",
                historyId: "9",
                headers: { from: "me@example.com" },
                labelIds: ["DRAFT"],
                snippet: "First",
                textPlain: "First saved reply",
                textHtml: "<p>First saved reply</p>",
                attachments: [
                  {
                    attachmentId: "att-1",
                    filename: "reader-preview.png",
                    mimeType: "image/png",
                    size: 12,
                    headers: {
                      "content-description": "",
                      "content-id": "",
                      "content-transfer-encoding": "base64",
                      "content-type": "image/png",
                    },
                  },
                ],
                isMeetingInvitation: true,
                inline: [],
              },
              {
                id: "empty-1",
                threadId: "t2",
                historyId: "10",
                headers: { from: "ada@example.com" },
                labelIds: ["INBOX"],
                snippet: "Hi",
              },
            ],
          };
        },
        async getMailboxSyncPage() {
          throw new Error("unused");
        },
      } as unknown as EmailProvider,
    });
    const result = await source.enumerate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      bootstrapId: "mailbox",
      page: "{}",
      pageSize: 50,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value.bodies).toEqual([
      {
        key: { accountId: "acc-1", messageId: "draft-1" },
        version: "9",
        html: "<p>First saved reply</p>",
        text: "First saved reply",
        attachments: [
          {
            attachmentId: "att-1",
            filename: "reader-preview.png",
            mimeType: "image/png",
            size: 12,
            inline: false,
            contentId: null,
          },
        ],
        isMeetingInvitation: true,
      },
    ]);
    expect(result.value.requiredHydration).toEqual([
      { accountId: "acc-1", messageId: "empty-1" },
    ]);
  });

  it("hydrates attachment descriptors and meeting invitations with the body", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        async getMessagesBatch() {
          return [
            {
              id: "msg-1",
              threadId: "t1",
              historyId: "11",
              headers: { from: "ada@example.com" },
              labelIds: ["INBOX"],
              snippet: "Invite",
              textPlain: "Please join",
              attachments: [
                {
                  attachmentId: "att-ics",
                  filename: "invite.ics",
                  mimeType: "text/calendar",
                  size: 80,
                  headers: {
                    "content-description": "",
                    "content-id": "",
                    "content-transfer-encoding": "base64",
                    "content-type": "text/calendar",
                  },
                },
              ],
              isMeetingInvitation: true,
              inline: [],
            },
          ];
        },
      } as unknown as EmailProvider,
    });
    const result = await source.hydrate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      keys: [{ accountId: "acc-1", messageId: "msg-1" }],
      purpose: "body",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value.bodies).toEqual([
      {
        key: { accountId: "acc-1", messageId: "msg-1" },
        version: "11",
        html: null,
        text: "Please join",
        attachments: [
          {
            attachmentId: "att-ics",
            filename: "invite.ics",
            mimeType: "text/calendar",
            size: 80,
            inline: false,
            contentId: null,
          },
        ],
        isMeetingInvitation: true,
      },
    ]);
  });

  it.each([
    [401, "blocked_auth"],
    [503, "paused"],
  ])("preserves hydration failures (%s)", async (status, expected) => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "microsoft",
        async getMessagesBatch() {
          throw Object.assign(new Error(`Provider returned ${status}`), {
            status,
          });
        },
      } as unknown as EmailProvider,
    });
    const result = await source.hydrate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      keys: [{ accountId: "acc-1", messageId: "m1" }],
      purpose: "body",
    });
    expect(result.status).toBe(expected);
    if (result.status === "ok") {
      expect(result.value.unresolved).toEqual([
        { key: { accountId: "acc-1", messageId: "m1" }, reason: "not_found" },
      ]);
    }
  });

  it("hydrates Outlook messages through the provider batch instead of one read per message", async () => {
    const getMessage = vi.fn();
    const getMessagesBatch = vi.fn(async (ids: string[]) =>
      ids
        .filter((id) => id !== "gone")
        .map((id) => ({ ...searchMessage(id), textHtml: `<p>${id}</p>` })),
    );
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "microsoft",
        getMessage,
        getMessagesBatch,
      } as unknown as EmailProvider,
    });
    const ids = [
      ...Array.from({ length: 19 }, (_, index) => `m-${index}`),
      "gone",
    ];

    const result = await source.hydrate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      keys: ids.map((messageId) => ({ accountId: "acc-1", messageId })),
      purpose: "body",
    });

    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value.bodies).toHaveLength(19);
    expect(result.value.unresolved).toEqual([
      { key: { accountId: "acc-1", messageId: "gone" }, reason: "not_found" },
    ]);
    expect(getMessagesBatch).toHaveBeenCalledTimes(1);
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("hydrates Gmail messages in one batch and reports the ones it could not read", async () => {
    const getMessage = vi.fn();
    const getMessagesBatch = vi.fn(async (ids: string[]) =>
      ids
        .filter((id) => id !== "gone")
        .map((id) => ({
          id,
          threadId: `t-${id}`,
          historyId: "5",
          headers: { from: "ada@example.com" },
          labelIds: ["INBOX"],
          snippet: "Hi",
          textPlain: "Hello",
        })),
    );
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMessage,
        getMessagesBatch,
      } as unknown as EmailProvider,
    });
    const keys = ["a", "gone", "b"].map((messageId) => ({
      accountId: "acc-1",
      messageId,
    }));
    const result = await source.hydrate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      keys,
      purpose: "body",
    });
    expect(result).toMatchObject({
      status: "ok",
      value: {
        bodies: [
          { key: { messageId: "a" }, text: "Hello" },
          { key: { messageId: "b" }, text: "Hello" },
        ],
        unresolved: [
          {
            key: { accountId: "acc-1", messageId: "gone" },
            reason: "not_found",
          },
        ],
      },
    });
    expect(getMessagesBatch).toHaveBeenCalledTimes(1);
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("backs off for Gmail's quota window and records rate-limit mode when Gmail throttles", async () => {
    forgetEmailProviderRateLimitState("acc-1");
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.set).mockClear();
    const quotaError = Object.assign(
      new Error(
        "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'",
      ),
      { status: 403, errors: [{ reason: "rateLimitExceeded" }] },
    );
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        async getMessagesBatch() {
          throw quotaError;
        },
      } as unknown as EmailProvider,
    });
    const result = await source.hydrate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      keys: [{ accountId: "acc-1", messageId: "m1" }],
      purpose: "body",
    });
    expect(result).toMatchObject({ status: "paused", reason: "throttled" });
    if (result.status !== "paused") throw new Error("expected paused");
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(30_000);
    expect(redis.set).toHaveBeenCalledWith(
      "email-provider-rate-limit:acc-1",
      expect.any(String),
      expect.anything(),
    );
  });

  it("leaves account-wide rate-limit mode alone when only the backfill is throttled", async () => {
    vi.mocked(redis.set).mockClear();
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        async getMessagesWithPagination() {
          throw Object.assign(new Error("Rate limit exceeded"), {
            status: 429,
          });
        },
      } as unknown as EmailProvider,
    });
    await expect(
      source.enumerate({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "r1",
        signal: new AbortController().signal,
        bootstrapId: "mailbox",
        page: JSON.stringify({ scopeId: "history" }),
        pageSize: 50,
      }),
    ).resolves.toMatchObject({ status: "paused", reason: "throttled" });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("gives back only the part of a page's sync budget the gate never let through", async () => {
    // A page reserves its whole cost before its Gmail calls reach the gate,
    // one admission at a time: the list, then each batch of messages. When a
    // later batch is turned away, what the earlier calls spent stays spent.
    const deferred = new GmailCallDeferredError(5000, "background");
    const getMessagesWithPagination = vi.fn(async () => {
      await admitGmailCall({ emailAccountId: "acc-1", cost: 5 });
      for (let batch = 0; batch < 3; batch++)
        await admitGmailCall({ emailAccountId: "acc-1", cost: 200 });
      throw deferred;
    });
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMessagesWithPagination,
      } as unknown as EmailProvider,
    });
    const result = await source.enumerate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      bootstrapId: "mailbox",
      page: JSON.stringify({ scopeId: "history", pageToken: "page-2" }),
      pageSize: 50,
    });

    expect(result).toMatchObject({ status: "paused", reason: "throttled" });
    const [reservation] =
      vi.mocked(withLocalMailSyncBudget).mock.calls[0] ?? [];
    expect(reservation?.cost).toBe(1005);
    expect(reservation?.unspentCost?.(deferred)).toBe(1005 - 605);
    // Any other failure may have reached Gmail, so nothing is given back.
    expect(reservation?.unspentCost?.(new Error("Gmail failed"))).toBe(0);
  });

  it("returns the sync budget's wait as a throttled pause", async () => {
    vi.mocked(withLocalMailSyncBudget).mockRejectedValueOnce(
      new LocalMailSyncPausedError(12_000),
    );
    const getMessagesWithPagination = vi.fn();
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMessagesWithPagination,
      } as unknown as EmailProvider,
    });
    await expect(
      source.enumerate({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "r1",
        signal: new AbortController().signal,
        bootstrapId: "mailbox",
        page: JSON.stringify({ scopeId: "history" }),
        pageSize: 50,
      }),
    ).resolves.toEqual({
      status: "paused",
      retryAfterMs: 12_000,
      reason: "throttled",
    });
    expect(getMessagesWithPagination).not.toHaveBeenCalled();
  });

  it("asks Gmail for a first sync's first page at the priority of someone waiting", async () => {
    const priorities: string[] = [];
    const getMessagesWithPagination = vi.fn(async () => {
      priorities.push(currentGmailQuotaContext().priority);
      return { messages: [], nextPageToken: "next" };
    });
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMessagesWithPagination,
      } as unknown as EmailProvider,
    });
    const enumerate = (token: object) =>
      source.enumerate({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "r1",
        signal: new AbortController().signal,
        bootstrapId: "mailbox",
        page: JSON.stringify(token),
        pageSize: 50,
      });

    await enumerate({ scopeId: "primary", initial: true });
    await enumerate({ scopeId: "primary", initial: true, pageToken: "next" });
    // A resync after expired history: nobody is waiting on an empty inbox.
    await enumerate({ scopeId: "primary" });
    await enumerate({ scopeId: "history", initial: true });

    expect(priorities).toEqual(["interactive", "sync", "sync", "background"]);
  });

  it("remembers a first sync in the primary scan's page token only", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMessagesWithPagination: vi.fn(),
      } as unknown as EmailProvider,
    });
    const begin = (id: string, initial: boolean) =>
      source.beginBootstrap({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "r1",
        signal: new AbortController().signal,
        scope: { id, kind: "account", folderId: null },
        afterMs: null,
        initial,
      });
    const tokenOf = async (begun: ReturnType<typeof begin>) => {
      const result = await begun;
      if (result.status !== "ok") throw new Error("expected ok");
      return JSON.parse(result.value.enumerationToken);
    };

    expect(await tokenOf(begin("primary", true))).toMatchObject({
      initial: true,
    });
    expect(await tokenOf(begin("primary", false))).not.toHaveProperty(
      "initial",
    );
    expect(await tokenOf(begin("history", true))).not.toHaveProperty("initial");
  });

  it("scans recent Gmail mail first and backfills older mail in a separate background scope", async () => {
    const now = Date.now();
    const getMessagesWithPagination = vi.fn(
      async (_options: { after?: Date; before?: Date }) => ({ messages: [] }),
    );
    const getMailboxSyncPage = vi.fn(async () => ({
      cursor: encodeMailboxSyncCursor({
        version: 1,
        provider: "google",
        phase: "delta",
        historyId: "42",
        after: "1970-01-01T00:00:00.000Z",
      }),
      reset: true,
      upsertedMessages: [],
      deletedMessageIds: [],
      hasMore: false,
    }));
    const advanceMailboxSyncCursor = vi.fn(async (cursor: string) => cursor);
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMessagesWithPagination,
        getMailboxSyncPage,
        advanceMailboxSyncCursor,
      } as unknown as EmailProvider,
    });
    const discovered = await source.discoverScopes({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "scopes",
      signal: new AbortController().signal,
      page: null,
    });
    if (discovered.status !== "ok") throw new Error("expected ok");
    const scopes = discovered.value.scopes;
    expect(scopes.map((scope) => scope.id)).toEqual(["primary", "history"]);
    expect(scopes[1]?.priority).toBe("low");

    const windows: Array<{ after?: Date; before?: Date }> = [];
    for (const scope of scopes) {
      const bootstrap = await source.beginBootstrap({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: `begin-${scope.id}`,
        signal: new AbortController().signal,
        scope,
        afterMs: null,
      });
      if (bootstrap.status !== "ok") throw new Error("expected ok");
      const page = await source.enumerate({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: `enum-${scope.id}`,
        signal: new AbortController().signal,
        bootstrapId: bootstrap.value.bootstrapId,
        page: bootstrap.value.enumerationToken,
        pageSize: 50,
      });
      expect(page).toMatchObject({
        status: "ok",
        value: { nextPage: null, catchUpFrom: { streamId: scope.id } },
      });
      windows.push(getMessagesWithPagination.mock.calls.at(-1)?.[0] ?? {});
    }
    const [recent, history] = windows;
    expect(recent?.before).toBeUndefined();
    expect(history?.after).toBeUndefined();
    const recentFrom = recent?.after?.getTime() ?? 0;
    const historyTo = history?.before?.getTime() ?? 0;
    expect(recentFrom).toBeGreaterThan(now - 30 * 24 * 60 * 60 * 1000);
    expect(recentFrom).toBeLessThan(now);
    // Overlapping windows leave no unsynced gap between the two scans.
    expect(historyTo).toBeGreaterThan(recentFrom);
    expect(withLocalMailSyncBudget).toHaveBeenCalledWith(
      expect.objectContaining({ priority: "backfill" }),
      expect.any(Function),
    );

    const historyChanges = await source.readChanges({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "history-changes",
      position: {
        streamId: "history",
        generation: "g1",
        checkpoint: "history-cursor",
      },
      pageSize: 50,
      signal: new AbortController().signal,
    });
    expect(historyChanges).toMatchObject({
      status: "page",
      page: { changes: [], roundComplete: true },
    });
    // Catch-up for every message runs through the primary stream; the
    // backfill scope only checks that its history is still held.
    expect(getMailboxSyncPage).toHaveBeenCalledTimes(2);
    expect(advanceMailboxSyncCursor).toHaveBeenCalledWith("history-cursor");
  });

  it("starts Gmail catch-up from history rather than resuming a full mailbox snapshot", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        async getMailboxSyncPage() {
          return {
            cursor: encodeMailboxSyncCursor({
              version: 1,
              provider: "google",
              phase: "snapshot",
              historyId: "77",
              after: "1970-01-01T00:00:00.000Z",
              pageToken: "snapshot-page-2",
            }),
            reset: true,
            upsertedMessages: [],
            deletedMessageIds: [],
            hasMore: true,
          };
        },
      } as unknown as EmailProvider,
    });
    const bootstrap = await source.beginBootstrap({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "begin",
      signal: new AbortController().signal,
      scope: { id: "primary", kind: "account", folderId: null },
      afterMs: null,
    });
    if (bootstrap.status !== "ok") throw new Error("expected ok");
    expect(
      decodeMailboxSyncCursor(
        bootstrap.value.catchUpFrom?.checkpoint ?? "",
        "google",
      ),
    ).toEqual({
      version: 1,
      provider: "google",
      phase: "delta",
      historyId: "77",
      after: "1970-01-01T00:00:00.000Z",
    });
  });

  it("emits an empty body observation when hydrate finds no text", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        async getMessagesBatch() {
          return [
            {
              id: "empty-1",
              threadId: "t2",
              historyId: "10",
              headers: { from: "ada@example.com" },
              labelIds: ["INBOX"],
              snippet: "Hi",
              inline: [],
            },
          ];
        },
      } as unknown as EmailProvider,
    });
    const result = await source.hydrate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      keys: [{ accountId: "acc-1", messageId: "empty-1" }],
      purpose: "body",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value.bodies).toEqual([
      {
        key: { accountId: "acc-1", messageId: "empty-1" },
        version: "10",
        html: null,
        text: null,
        attachments: [],
        isMeetingInvitation: false,
      },
    ]);
  });

  it("blocks catch-up when provider authentication fails", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        localMailSyncStrategy: "history",
        async getMailboxSyncPage() {
          throw new Error("401 unauthorized");
        },
        async getMessagesWithPagination() {
          throw new Error("401 unauthorized");
        },
      } as unknown as EmailProvider,
    });
    const result = await source.readChanges({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      position: {
        streamId: "primary",
        generation: "g1",
        checkpoint: "1",
      },
      pageSize: 20,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ status: "blocked_auth" });
  });

  it.each([
    {
      name: "Gmail rejecting a revoked access token",
      error: Object.assign(
        new Error("Request had invalid authentication credentials."),
        { response: { status: 401 } },
      ),
    },
    {
      name: "a refresh that found the grant revoked",
      error: Object.assign(new Error("No refresh token"), {
        cause: new Error("invalid_grant"),
      }),
    },
  ])("reports $name as needing reconnect, not as offline", async ({
    error,
  }) => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        localMailSyncStrategy: "history",
        async getMailboxSyncPage() {
          throw error;
        },
      } as unknown as EmailProvider,
    });
    const result = await source.readChanges({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      position: { streamId: "primary", generation: "g1", checkpoint: "1" },
      pageSize: 20,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ status: "blocked_auth" });
  });

  it("streams attachment bytes from the provider", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        localMailSyncStrategy: "history",
        async getAttachmentStream(messageId, attachmentId, signal) {
          expect(messageId).toBe("m1");
          expect(attachmentId).toBe("att-1");
          expect(signal).toBeDefined();
          return new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          });
        },
      } as unknown as EmailProvider,
    });
    const result = await source.readAttachment({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      key: { accountId: "acc-1", messageId: "m1" },
      attachmentId: "att-1",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.value.bytes) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
  });

  it("pauses attachment reads when the provider is unavailable", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        localMailSyncStrategy: "history",
        async getAttachmentStream() {
          throw new Error("provider down");
        },
      } as unknown as EmailProvider,
    });
    await expect(
      source.readAttachment({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "r1",
        signal: new AbortController().signal,
        key: { accountId: "acc-1", messageId: "m1" },
        attachmentId: "att-1",
      }),
    ).resolves.toEqual({
      status: "paused",
      retryAfterMs: 1000,
      reason: "unavailable",
    });
  });

  it("does not retry a missing provider attachment", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        localMailSyncStrategy: "history",
        async getAttachmentStream() {
          throw Object.assign(new Error("Unable to stream attachment"), {
            status: 404,
          });
        },
      } as unknown as EmailProvider,
    });
    await expect(
      source.readAttachment({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "r1",
        signal: new AbortController().signal,
        key: { accountId: "acc-1", messageId: "missing" },
        attachmentId: "att-1",
      }),
    ).resolves.toEqual({
      status: "not_found",
    });
  });
});

function searchInput(accountId: string, text: { value: string }) {
  return {
    session: { accountId, generation: "g1" },
    requestId: "search-1",
    signal: new AbortController().signal,
    predicate: {
      kind: "text",
      field: "any",
      value: text.value,
      match: "phrase",
    } as const,
    page: null,
    pageSize: 20,
  };
}

function searchMessage(id: string, labelIds: string[] = []) {
  return {
    id,
    threadId: id,
    headers: { from: "sender@example.com", to: "user@example.com" },
    subject: "invoice",
    snippet: "invoice",
    labelIds,
    internalDate: "1767225600000",
  };
}

describe("Gmail history expiry", () => {
  it("re-syncs older mail when Gmail no longer holds the mailbox history", async () => {
    const day = 24 * 60 * 60 * 1000;
    const mailbox = new Map<string, ParsedMessage>([
      ["recent", gmailMessage("recent", Date.now() - day)],
      ["old", gmailMessage("old", Date.now() - 30 * day)],
    ]);
    let historyExpired = false;
    const cursor = encodeMailboxSyncCursor({
      version: 1,
      provider: "google",
      phase: "delta",
      historyId: "100",
      after: "1970-01-01T00:00:00.000Z",
    });
    const provider = {
      name: "google",
      async getMessagesWithPagination(options: {
        after?: Date;
        before?: Date;
      }) {
        return {
          messages: [...mailbox.values()].filter((message) => {
            const at = Number(message.internalDate);
            return (
              (!options.after || at >= options.after.getTime()) &&
              (!options.before || at < options.before.getTime())
            );
          }),
        };
      },
      async getMailboxSyncPage(options: { cursor?: string }) {
        if (options.cursor && historyExpired) {
          return {
            cursor,
            reset: true,
            upsertedMessages: [],
            deletedMessageIds: [],
            hasMore: true,
          };
        }
        return {
          cursor,
          reset: !options.cursor,
          upsertedMessages: [],
          deletedMessageIds: [],
          hasMore: false,
        };
      },
      async advanceMailboxSyncCursor(current: string) {
        return historyExpired ? null : current;
      },
    } as unknown as EmailProvider;
    let now = 1_000_000;
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: createEmailProviderMailboxSource({
        logger,
        provider,
        accountId: "acc-1",
      }),
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime({ nowMs: () => now }),
    });
    const starredMessageIds = async () => {
      const { view } = await store.readMailboxView({
        accountIds: ["acc-1"],
        predicate: { kind: "starred", value: true },
        order: "newest_first",
        pageSize: 25,
        after: null,
      });
      return view.conversations.map((conversation) => conversation.key);
    };
    const runFor = async (rounds: number) => {
      for (let round = 0; round < rounds; round++) {
        await engine.runUntil(now + 20);
      }
    };

    await engine.requestSync(["acc-1"]);
    await runFor(5);
    expect(await starredMessageIds()).toEqual([]);

    // Offline past Gmail's history retention: changes to old mail are gone
    // from history, so only a fresh scan can bring them in.
    historyExpired = true;
    mailbox.set("old", gmailMessage("old", Date.now() - 30 * day, ["STARRED"]));
    now += 11 * 60_000;
    await runFor(5);
    historyExpired = false;
    now += 11 * 60_000;
    await runFor(10);

    expect(await starredMessageIds()).toEqual([
      { accountId: "acc-1", conversationId: "t-old" },
    ]);
    await engine.close();
  });

  it("sends the bodies of at most 50 messages on one catch-up page and hydrates the rest", async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `m-${index}`);
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: {
        name: "google",
        async getMailboxSyncPage() {
          return {
            cursor: "next",
            reset: false,
            upsertedMessages: ids.map((id) => ({
              ...searchMessage(id),
              textPlain: `body of ${id}`,
            })),
            includesBodies: true,
            deletedMessageIds: [],
            hasMore: false,
          };
        },
      } as unknown as EmailProvider,
    });

    const result = await source.readChanges({
      session: { accountId: "a", generation: "g1" },
      requestId: "r1",
      position: { streamId: "primary", generation: "g1", checkpoint: "1" },
      pageSize: 50,
      signal: new AbortController().signal,
    });
    if (result.status !== "page") throw new Error("expected a page");

    const withBody = (result.page.bodies ?? []).map(
      (body) => body.key.messageId,
    );
    const hydrated = result.page.requiredHydration.map((key) => key.messageId);
    expect(withBody.length).toBeLessThanOrEqual(50);
    expect([...withBody, ...hydrated].sort()).toEqual([...ids].sort());
  });

  it("asks Outlook folder deltas for the bodies they carry", async () => {
    const getMailboxSyncPage = vi.fn(async () => ({
      cursor: "next",
      reset: false,
      upsertedMessages: [
        { ...searchMessage("new-1"), textHtml: "<p>body of new-1</p>" },
      ],
      includesBodies: true,
      deletedMessageIds: [],
      hasMore: false,
    }));
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: {
        name: "microsoft",
        getMailboxSyncPage,
      } as unknown as EmailProvider,
    });

    const result = await source.readChanges({
      session: { accountId: "a", generation: "g1" },
      requestId: "r1",
      position: { streamId: "inbox-id", generation: "g1", checkpoint: "1" },
      pageSize: 20,
      signal: new AbortController().signal,
    });

    if (result.status !== "page") throw new Error("expected a page");
    expect(getMailboxSyncPage).toHaveBeenCalledWith(
      expect.objectContaining({ includeBodies: true, folderId: "inbox-id" }),
    );
    expect(result.page.bodies?.map((body) => body.html)).toEqual([
      "<p>body of new-1</p>",
    ]);
    expect(result.page.requiredHydration).toEqual([]);
  });

  it("fetches each Gmail message a catch-up brings in once, body included", async () => {
    const fetches = new Map<string, number>();
    const fetch = (id: string) => {
      fetches.set(id, (fetches.get(id) ?? 0) + 1);
      return {
        ...searchMessage(id),
        textPlain: `body of ${id}`,
        textHtml: `<p>body of ${id}</p>`,
      } as ParsedMessage;
    };
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: {
        name: "google",
        // Like the real provider: the delta reads full messages and keeps
        // their bodies only when asked to.
        async getMailboxSyncPage(options: { includeBodies?: boolean }) {
          const messages = ["new-1", "new-2"].map(fetch);
          return {
            cursor: "next",
            reset: false,
            upsertedMessages: options.includeBodies
              ? messages
              : messages.map(compactMailboxSyncMessage),
            includesBodies: options.includeBodies === true,
            deletedMessageIds: [],
            hasMore: false,
          };
        },
        getMessagesBatch: async (ids: string[]) => ids.map(fetch),
      } as unknown as EmailProvider,
    });
    const session = { accountId: "a", generation: "g1" };

    const result = await source.readChanges({
      session,
      requestId: "r1",
      position: { streamId: "primary", generation: "g1", checkpoint: "1" },
      pageSize: 50,
      signal: new AbortController().signal,
    });
    if (result.status !== "page") throw new Error("expected a page");
    // What the engine does with a page: hydrate whatever came without a body.
    if (result.page.requiredHydration.length > 0) {
      await source.hydrate({
        session,
        requestId: "h1",
        keys: result.page.requiredHydration,
        purpose: "body",
        signal: new AbortController().signal,
      });
    }

    expect(Object.fromEntries(fetches)).toEqual({ "new-1": 1, "new-2": 1 });
    expect(result.page.bodies?.map((body) => body.text)).toEqual([
      "body of new-1",
      "body of new-2",
    ]);
  });
});

describe("structured mailbox search", () => {
  it("returns the messages and bodies it fetched so they are not fetched again", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: {
        name: "google",
        searchMessages: async () => ({
          messages: [
            { ...searchMessage("with-body"), textPlain: "invoice total" },
            { ...searchMessage("no-body"), textPlain: null, textHtml: null },
          ],
        }),
        getMessage: async (id: string) => ({
          ...searchMessage(id),
          textPlain: null,
          textHtml: null,
        }),
      } as unknown as EmailProvider,
    });
    const result = await source.search({
      session: { accountId: "a", generation: "1" },
      requestId: "search",
      signal: new AbortController().signal,
      page: null,
      pageSize: 20,
      predicate: {
        kind: "text",
        field: "any",
        value: "invoice",
        match: "term",
      },
    });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.value.changes?.map((change) => change.kind)).toEqual([
      "message_patch",
      "message_patch",
    ]);
    expect(result.value.bodies).toEqual([
      expect.objectContaining({
        key: { accountId: "a", messageId: "with-body" },
        text: "invoice total",
      }),
    ]);
  });

  it.each([
    "google",
    "microsoft",
  ])("rechecks %s text candidates using a single canonical field", async (name) => {
    const messages = [
      {
        ...searchMessage("split-fields"),
        subject: "alpha",
        snippet: "beta",
        textPlain: "",
      },
      {
        ...searchMessage("subject-match"),
        subject: "alpha beta",
        snippet: "",
        textPlain: "",
      },
      {
        ...searchMessage("body-match"),
        subject: "Elsewhere",
        snippet: "",
        textPlain: "alpha beta",
      },
      {
        ...searchMessage("html-match"),
        subject: "Elsewhere",
        snippet: "",
        textHtml: "<p>alpha <strong>beta</strong></p>",
      },
    ];
    const getMessage = vi.fn();
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: {
        name,
        searchMessages: async () => ({ messages }),
        getMessage,
      } as unknown as EmailProvider,
    });
    await expect(
      source.search({
        session: { accountId: "a", generation: "1" },
        requestId: "search",
        signal: new AbortController().signal,
        page: null,
        pageSize: 20,
        predicate: {
          kind: "text",
          field: "any",
          value: "alpha beta",
          match: "term",
        },
      }),
    ).resolves.toMatchObject({
      status: "ok",
      value: {
        matches: [
          { messageId: "subject-match" },
          { messageId: "body-match" },
          { messageId: "html-match" },
        ],
      },
    });
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("rejects metadata exclusions before loading omitted candidate bodies", async () => {
    const getMessage = vi.fn();
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: {
        name: "microsoft",
        getMessage,
        searchMessages: async () => ({
          messages: [
            { ...searchMessage("already-read"), subject: "", snippet: "" },
            {
              ...searchMessage("spam", ["SPAM", "UNREAD"]),
              subject: "",
              snippet: "",
            },
            {
              ...searchMessage("sent", ["SENT", "UNREAD"]),
              subject: "",
              snippet: "",
            },
          ],
        }),
      } as unknown as EmailProvider,
    });
    await expect(
      source.search({
        session: { accountId: "a", generation: "1" },
        requestId: "search",
        signal: new AbortController().signal,
        page: null,
        pageSize: 20,
        predicate: {
          kind: "all",
          predicates: [
            { kind: "text", field: "any", value: "alpha beta", match: "term" },
            { kind: "read", value: false },
            { kind: "not", predicate: { kind: "role", role: "sent" } },
          ],
        },
      }),
    ).resolves.toMatchObject({ status: "ok", value: { matches: [] } });
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("loads a missing body projection before rejecting an any-field match and keeps pagination", async () => {
    const getMessage = vi.fn(async () => ({
      ...searchMessage("body-hit"),
      textPlain: "alpha beta",
    }));
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: {
        name: "microsoft",
        getMessage,
        searchMessages: async () => ({
          messages: [
            { ...searchMessage("body-hit"), subject: "alpha", snippet: "beta" },
          ],
          nextPageToken: "next",
        }),
      } as unknown as EmailProvider,
    });
    await expect(
      source.search({
        session: { accountId: "a", generation: "1" },
        requestId: "search",
        signal: new AbortController().signal,
        page: null,
        pageSize: 20,
        predicate: {
          kind: "text",
          field: "any",
          value: "alpha beta",
          match: "term",
        },
      }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { matches: [{ messageId: "body-hit" }], nextPage: "next" },
    });
    expect(getMessage).toHaveBeenCalledWith("body-hit");
  });

  it("does not hide a missing body when provider hydration fails", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: {
        name: "microsoft",
        getMessage: vi
          .fn()
          .mockRejectedValue(new Error("body download failed")),
        searchMessages: async () => ({
          messages: [
            { ...searchMessage("body-hit"), subject: "alpha", snippet: "beta" },
          ],
        }),
      } as unknown as EmailProvider,
    });
    await expect(
      source.search({
        session: { accountId: "a", generation: "1" },
        requestId: "search",
        signal: new AbortController().signal,
        page: null,
        pageSize: 20,
        predicate: {
          kind: "text",
          field: "any",
          value: "alpha beta",
          match: "term",
        },
      }),
    ).rejects.toThrow("body download failed");
  });

  it("filters all chips on the same message and preserves an empty-page continuation", async () => {
    const searchMessages = vi.fn(
      async ({ pageToken }: { pageToken?: string }) => ({
        messages: [
          pageToken
            ? {
                ...searchMessage("match", ["UNREAD", "STARRED"]),
                hasAttachment: true,
              }
            : { ...searchMessage("wrong", ["UNREAD"]), hasAttachment: true },
        ],
        nextPageToken: pageToken ? undefined : "second",
      }),
    );
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: {
        name: "microsoft",
        searchMessages,
      } as unknown as EmailProvider,
    });
    const input = {
      session: { accountId: "a", generation: "1" },
      requestId: "search",
      signal: new AbortController().signal,
      pageSize: 20,
      predicate: {
        kind: "all",
        predicates: [
          { kind: "read", value: false },
          { kind: "starred", value: true },
          { kind: "has_attachment", value: true },
        ],
      } as const,
    };
    await expect(
      source.search({
        ...input,
        predicate: { kind: "all", predicates: [...input.predicate.predicates] },
        page: null,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { matches: [], nextPage: "second" },
    });
    await expect(
      source.search({
        ...input,
        predicate: { kind: "all", predicates: [...input.predicate.predicates] },
        page: "second",
      }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { matches: [{ messageId: "match" }], nextPage: null },
    });
  });

  it("keeps canonical archive scope and permits explicit sent/draft exclusions", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: {
        name: "microsoft",
        searchMessages: async () => ({
          messages: [
            searchMessage("custom"),
            searchMessage("sent", ["SENT"]),
            searchMessage("draft", ["DRAFT"]),
            searchMessage("inbox", ["INBOX"]),
            searchMessage("spam", ["SPAM"]),
            searchMessage("trash", ["TRASH"]),
          ],
        }),
      } as unknown as EmailProvider,
    });
    const input = {
      session: { accountId: "a", generation: "1" },
      requestId: "search",
      signal: new AbortController().signal,
      pageSize: 20,
      page: null,
    };
    await expect(
      source.search({
        ...input,
        predicate: { kind: "mailbox", mailbox: "archive" },
      }),
    ).resolves.toMatchObject({
      status: "ok",
      value: {
        matches: [
          { messageId: "custom" },
          { messageId: "sent" },
          { messageId: "draft" },
        ],
      },
    });
    await expect(
      source.search({
        ...input,
        predicate: {
          kind: "all",
          predicates: [
            { kind: "mailbox", mailbox: "archive" },
            { kind: "not", predicate: { kind: "role", role: "sent" } },
            { kind: "not", predicate: { kind: "role", role: "draft" } },
          ],
        },
      }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { matches: [{ messageId: "custom" }] },
    });
  });
});

function gmailMessage(
  id: string,
  receivedAtMs: number,
  extraLabels: string[] = [],
): ParsedMessage {
  return {
    id,
    threadId: `t-${id}`,
    historyId: extraLabels.length ? "2" : "1",
    internalDate: String(receivedAtMs),
    date: new Date(receivedAtMs).toISOString(),
    subject: id,
    snippet: id,
    headers: {
      from: "ada@example.com",
      to: "me@example.com",
      subject: id,
      date: new Date(receivedAtMs).toISOString(),
    },
    labelIds: ["INBOX", ...extraLabels],
    textPlain: id,
    inline: [],
  } as unknown as ParsedMessage;
}

// Answers as the providers do: drafts only when asked for them.
function membershipSource(messages: { id: string; labelIds: string[] }[]) {
  const thread = messages.map((message) => ({
    ...message,
    threadId: "c1",
    headers: { from: "me@example.com" },
    snippet: message.id,
  }));
  const withoutDrafts = () =>
    thread.filter((message) => !message.labelIds.includes("DRAFT"));
  return createEmailProviderMailboxSource({
    logger,
    accountId: "acc-1",
    provider: {
      name: "google",
      async getThread(_id: string, options?: { includeDrafts?: boolean }) {
        return {
          messages: options?.includeDrafts ? thread : withoutDrafts(),
          historyId: "h1",
        };
      },
      async getThreadMessages() {
        return withoutDrafts();
      },
    } as unknown as EmailProvider,
  });
}

async function readMembershipKeys(
  source: ReturnType<typeof createEmailProviderMailboxSource>,
) {
  const result = await source.readConversationMembership({
    session: { accountId: "acc-1", generation: "g1" },
    requestId: "r1",
    signal: new AbortController().signal,
    conversation: { accountId: "acc-1", conversationId: "c1" },
    resolutionId: "res",
    page: null,
    pageSize: 20,
  });
  if (result.status !== "ok" || result.value.status !== "page") {
    throw new Error(`Unexpected membership result: ${result.status}`);
  }
  return result.value.page.keys.map((key) => key.messageId);
}

describe("typed search", () => {
  const NOW = new Date("2026-10-15T15:00:00Z");

  function typedSearchInput(query: string) {
    const predicate = searchQueryToPredicate(query, { now: NOW });
    if (predicate?.kind !== "all") throw new Error("Expected a scoped search");
    const [search] = predicate.predicates;
    return {
      session: { accountId: "a", generation: "1" },
      requestId: "search",
      signal: new AbortController().signal,
      page: null,
      pageSize: 20,
      predicate: search,
    };
  }

  it("goes through Gmail's quota gate as interactive and waits when it is held back", async () => {
    const priorities: string[] = [];
    const searchMessages = vi.fn(async () => {
      priorities.push(currentGmailQuotaContext().priority);
      throw new GmailCallDeferredError(7000, "interactive");
    });
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: { name: "google", searchMessages } as unknown as EmailProvider,
    });
    await expect(source.search(typedSearchInput("larger:5M"))).resolves.toEqual(
      {
        status: "paused",
        retryAfterMs: 7000,
        reason: "throttled",
      },
    );
    expect(priorities).toEqual(["interactive"]);
  });

  it.each([
    "from:amy@example.com",
    "to:bob@example.com",
    "larger:10M older_than:2y",
    "dinner OR movie -in:chats",
  ])("sends %s to Gmail as typed and keeps every match it returns", async (query) => {
    const searchMessages = vi.fn(async () => ({
      messages: [
        // Neither carries what the query asked for, so only Gmail's answer
        // can vouch for them.
        { ...searchMessage("old-1"), internalDate: "946684800000" },
        { ...searchMessage("old-2"), textPlain: "body" },
      ],
      nextPageToken: "next",
    }));
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: { name: "google", searchMessages } as unknown as EmailProvider,
    });
    const result = await source.search(typedSearchInput(query));
    expect(searchMessages).toHaveBeenCalledWith({
      query,
      maxResults: 20,
      pageToken: undefined,
    });
    expect(result).toMatchObject({
      status: "ok",
      value: {
        matches: [{ messageId: "old-1" }, { messageId: "old-2" }],
        nextPage: "next",
        semantics: "exact",
      },
    });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.value.changes).toHaveLength(2);
    expect(result.value.bodies).toEqual([
      expect.objectContaining({ key: { accountId: "a", messageId: "old-2" } }),
    ]);
  });

  it("asks Outlook for the sender and checks the rest of the query itself", async () => {
    const searchMessages = vi.fn(async () => ({
      messages: [
        {
          ...searchMessage("unread-from-amy", ["UNREAD"]),
          headers: { from: "amy@example.com", to: "user@example.com" },
        },
        {
          ...searchMessage("read-from-amy"),
          headers: { from: "amy@example.com", to: "user@example.com" },
        },
      ],
    }));
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: {
        name: "microsoft",
        searchMessages,
      } as unknown as EmailProvider,
    });
    const result = await source.search(
      typedSearchInput("from:amy@example.com is:unread"),
    );
    expect(searchMessages).toHaveBeenCalledWith({
      query: "",
      mailboxSearch: {
        mailbox: "all",
        addresses: [{ field: "from", value: "amy@example.com" }],
        read: false,
      },
      maxResults: 20,
      pageToken: undefined,
    });
    expect(result).toMatchObject({
      status: "ok",
      value: {
        matches: [{ messageId: "unread-from-amy" }],
        semantics: "candidates_require_local_filter",
      },
    });
  });

  it.each([
    "is:unread",
    // Outlook's answer couldn't be checked for a size, so it isn't asked.
    "from:amy@example.com size>1MB",
  ])("leaves the typed Outlook search %s to the store", async (query) => {
    const searchMessages = vi.fn();
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "a",
      provider: {
        name: "microsoft",
        searchMessages,
      } as unknown as EmailProvider,
    });
    await expect(source.search(typedSearchInput(query))).resolves.toEqual({
      status: "unsupported",
    });
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("shows a sender's mail the store doesn't hold yet, and what only Gmail can match", async () => {
    const mailbox = new Map<string, ParsedMessage>([
      [
        "from-amy",
        {
          ...gmailMessage("from-amy", Date.parse("2019-05-01T00:00:00Z")),
          headers: {
            from: "Amy <amy@example.com>",
            to: "user@example.com",
            date: "2019-05-01",
          },
        } as ParsedMessage,
      ],
      ["big-attachment", gmailMessage("big-attachment", NOW.getTime())],
    ]);
    const searchMessages = vi.fn(async ({ query }: { query: string }) => ({
      messages: [
        query.startsWith("from:amy")
          ? mailbox.get("from-amy")
          : mailbox.get("big-attachment"),
      ],
    }));
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "a",
      provider: "google",
      generation: "g1",
    });
    const engine = createMailEngine({
      store,
      source: createEmailProviderMailboxSource({
        logger,
        accountId: "a",
        provider: {
          name: "google",
          searchMessages,
        } as unknown as EmailProvider,
      }),
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime(),
    });
    async function searchView(query: string) {
      const predicate = searchQueryToPredicate(query, { now: NOW });
      if (!predicate) throw new Error("No predicate");
      const view = engine.observeMailbox({
        accountIds: ["a"],
        predicate,
        order: "newest_first",
        pageSize: 25,
        after: null,
      });
      for (let round = 0; round < 10; round++) {
        await engine.runUntil(Date.now() + 50);
        if (view.getSnapshot().data?.conversations.length) break;
      }
      const ids = view
        .getSnapshot()
        .data?.conversations.map((row) => row.key.conversationId);
      view.close();
      return ids;
    }
    try {
      expect(await searchView("from:amy@example.com")).toEqual(["t-from-amy"]);
      expect(await searchView("larger:10M")).toEqual(["t-big-attachment"]);
      expect(searchMessages.mock.calls.map(([call]) => call.query)).toEqual([
        "from:amy@example.com",
        "larger:10M",
      ]);
    } finally {
      await engine.close();
    }
  });
});
