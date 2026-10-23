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
import { runWithAuditContext } from "@/utils/audit/context";
import {
  createEmailProviderMailboxSource,
  shouldLogLocalBudgetPause,
} from "./source";
import {
  createRequestMetrics,
  getRequestMetricsFields,
  runWithRequestMetrics,
} from "@/utils/request-metrics";
import { searchQueryToPredicate } from "@/utils/mail-search/search-query-predicate";
import {
  currentGmailQuotaContext,
  gmailBurstUnitsFor,
  gmailRequestCost,
} from "@/utils/gmail/quota";
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
  gmailMailSyncCosts,
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
    (
      _input: unknown,
      operation: (
        signal: AbortSignal,
        admission: { nextAdmitAfterMs: number | null },
      ) => Promise<unknown>,
    ) => operation(new AbortController().signal, { nextAdmitAfterMs: null }),
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
    } as unknown as ParsedMessage);
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
    expect(getMessagesWithPagination).toHaveBeenCalledWith({
      maxResults: 12,
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
    // As the engine's hydration route reads, at sync priority.
    const result = await runWithAuditContext(
      { source: "mail/v1/hydration" },
      () =>
        source.hydrate({
          session: { accountId: "acc-1", generation: "g1" },
          requestId: "r1",
          signal: new AbortController().signal,
          keys: [{ accountId: "acc-1", messageId: "m1" }],
          purpose: "body",
        }),
    );
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
      for (let batch = 0; batch < 2; batch++)
        await admitGmailCall({ emailAccountId: "acc-1", cost: 120 });
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
    // A backfill page of nine whole messages and its list.
    expect(reservation?.cost).toBe(545);
    expect(reservation?.unspentCost?.(deferred)).toBe(545 - 245);
    // Any other failure may have reached Gmail, so nothing is given back.
    expect(reservation?.unspentCost?.(new Error("Gmail failed"))).toBe(0);
  });

  it("never refunds a negative amount when a page admitted more than it reserved", async () => {
    const deferred = new GmailCallDeferredError(5000, "background");
    const getMessagesWithPagination = vi.fn(async () => {
      for (let batch = 0; batch < 5; batch++)
        await admitGmailCall({ emailAccountId: "acc-1", cost: 120 });
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
    await source.enumerate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      bootstrapId: "mailbox",
      page: JSON.stringify({ scopeId: "history", pageToken: "page-2" }),
      pageSize: 50,
    });
    const [reservation] =
      vi.mocked(withLocalMailSyncBudget).mock.calls[0] ?? [];
    // 600 admitted against a 545 reservation.
    expect(reservation?.unspentCost?.(deferred)).toBe(0);
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

  it("tells the client how long the sync budget holds its next backfill page", async () => {
    vi.mocked(withLocalMailSyncBudget).mockImplementationOnce(
      (_input, operation) =>
        operation(new AbortController().signal, { nextAdmitAfterMs: 6000 }),
    );
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMessagesWithPagination: vi.fn(async () => ({
          messages: [],
          nextPageToken: "page-3",
        })),
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

    if (result.status !== "ok" || result.value.nextPage === null)
      throw new Error("expected a next page");
    // The page's own time counts against the wait.
    expect(result.value.retryAfterMs).toBeGreaterThan(5000);
    expect(result.value.retryAfterMs).toBeLessThanOrEqual(6000);
    const [reservation] =
      vi.mocked(withLocalMailSyncBudget).mock.calls[0] ?? [];
    // The next page is priced like this one: nine messages and the list.
    expect(reservation?.nextCost).toBe(545);
  });

  it("caps the wait it gives at a minute", async () => {
    vi.mocked(withLocalMailSyncBudget).mockImplementationOnce(
      (_input, operation) =>
        operation(new AbortController().signal, {
          nextAdmitAfterMs: 10 * 60_000,
        }),
    );
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMessagesWithPagination: vi.fn(async () => ({
          messages: [],
          nextPageToken: "page-3",
        })),
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

    expect(result).toMatchObject({
      status: "ok",
      value: { retryAfterMs: 60_000 },
    });
  });

  it("gives no wait when the sync budget already covers the next page", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMessagesWithPagination: vi.fn(async () => ({
          messages: [],
          nextPageToken: "page-3",
        })),
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

    expect(result).toMatchObject({ status: "ok" });
    expect(result.status === "ok" && "retryAfterMs" in result.value).toBe(
      false,
    );
  });

  it("puts the sync budget's pause reason on the request's metrics", async () => {
    vi.mocked(withLocalMailSyncBudget).mockRejectedValueOnce(
      new LocalMailSyncPausedError(12_000, "account_budget"),
    );
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMessagesWithPagination: vi.fn(),
      } as unknown as EmailProvider,
    });
    const metrics = createRequestMetrics();
    await runWithRequestMetrics(metrics, () =>
      source.enumerate({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "r1",
        signal: new AbortController().signal,
        bootstrapId: "mailbox",
        page: JSON.stringify({ scopeId: "history" }),
        pageSize: 50,
      }),
    );
    expect(getRequestMetricsFields(metrics)).toMatchObject({
      pausedSource: "local_budget",
      pausedReason: "account_budget",
      pausedRetryAfterMs: 12_000,
    });
  });

  it("puts the quota gate's deferral reason on the request's metrics", async () => {
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMessagesWithPagination: vi.fn(async () => {
          throw new GmailCallDeferredError(7000, "sync", "sync_pause");
        }),
      } as unknown as EmailProvider,
    });
    const metrics = createRequestMetrics();
    const result = await runWithRequestMetrics(metrics, () =>
      source.enumerate({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "r1",
        signal: new AbortController().signal,
        bootstrapId: "mailbox",
        page: JSON.stringify({ scopeId: "primary", pageToken: "page-2" }),
        pageSize: 50,
      }),
    );
    expect(result).toEqual({
      status: "paused",
      retryAfterMs: 7000,
      reason: "throttled",
    });
    expect(getRequestMetricsFields(metrics)).toMatchObject({
      pausedSource: "quota_gate",
      pausedReason: "sync_pause",
      pausedRetryAfterMs: 7000,
    });
  });

  describe("enumeration log fields", () => {
    async function enumerationFields(page: Record<string, unknown>) {
      const source = createEmailProviderMailboxSource({
        logger,
        accountId: "acc-1",
        provider: {
          name: "google",
          getMessagesWithPagination: vi.fn(async () => ({ messages: [] })),
        } as unknown as EmailProvider,
      });
      const metrics = createRequestMetrics();
      await runWithRequestMetrics(metrics, () =>
        source.enumerate({
          session: { accountId: "acc-1", generation: "g1" },
          requestId: "r1",
          signal: new AbortController().signal,
          bootstrapId: "mailbox",
          page: JSON.stringify(page),
          pageSize: 50,
        }),
      );
      return getRequestMetricsFields(metrics);
    }

    it.each([
      [
        "a primary page",
        { scopeId: "primary", pageToken: "secret-token" },
        {
          scope: "primary",
          phase: "none",
          gatePriority: "sync",
          promoted: false,
        },
      ],
      [
        "a history page with no phase",
        { scopeId: "history", windowStartMs: 1 },
        {
          scope: "history",
          phase: "none",
          gatePriority: "background",
          promoted: false,
        },
      ],
      [
        "a history inbox page inside the first inbox allowance",
        { scopeId: "history", windowStartMs: 1, phase: "inbox", synced: 0 },
        {
          scope: "history",
          phase: "inbox",
          gatePriority: "sync",
          promoted: true,
        },
      ],
      [
        "a history inbox page past the first inbox allowance",
        { scopeId: "history", windowStartMs: 1, phase: "inbox", synced: 5000 },
        {
          scope: "history",
          phase: "inbox",
          gatePriority: "background",
          promoted: false,
        },
      ],
      [
        "a history rest page",
        { scopeId: "history", windowStartMs: 1, phase: "rest" },
        {
          scope: "history",
          phase: "rest",
          gatePriority: "background",
          promoted: false,
        },
      ],
    ])("is on %s", async (_name, page, expected) => {
      expect(await enumerationFields(page)).toMatchObject(expected);
    });

    it("carries no query, token or id text", async () => {
      const fields = await enumerationFields({
        scopeId: "history",
        windowStartMs: 1_700_000_000_000,
        phase: "inbox",
        phasePageToken: "secret-token",
        folderId: "folder-secret",
      });
      const logged = JSON.stringify(fields);
      expect(logged).not.toContain("secret");
      expect(logged).not.toContain("in:inbox");
      expect(logged).not.toContain("1700000000000");
    });

    it("is absent on requests that are not enumeration pages", () => {
      const fields = getRequestMetricsFields(createRequestMetrics());
      expect(fields.scope).toBeUndefined();
      expect(fields.gatePriority).toBeUndefined();
    });
  });

  describe("an engine older than the server's minimum", () => {
    async function enumerateAs(
      oldEngine: "missing_revision" | "below_minimum" | null,
      page: Record<string, unknown>,
    ) {
      const getMessagesWithPagination = vi.fn(async () => ({
        messages: [],
        nextPageToken: "next",
      }));
      const source = createEmailProviderMailboxSource({
        logger,
        accountId: "acc-1",
        oldEngine,
        provider: {
          name: "google",
          getMessagesWithPagination,
        } as unknown as EmailProvider,
      });
      const metrics = createRequestMetrics();
      const result = await runWithRequestMetrics(metrics, () =>
        source.enumerate({
          session: { accountId: "acc-1", generation: "g1" },
          requestId: "r1",
          signal: new AbortController().signal,
          bootstrapId: "mailbox",
          page: JSON.stringify(page),
          pageSize: 50,
        }),
      );
      return {
        result,
        fields: getRequestMetricsFields(metrics),
        listed: getMessagesWithPagination.mock.calls.length,
      };
    }

    it.each([
      [
        "missing_revision",
        { scopeId: "history", windowStartMs: 1, phase: "rest" },
      ],
      ["below_minimum", { scopeId: "history", pageToken: "p2" }],
    ] as const)("is refused a background backfill page for ten minutes (%s), before any Gmail call", async (reason, page) => {
      const { result, fields, listed } = await enumerateAs(reason, page);
      expect(result).toEqual({
        status: "paused",
        reason: "throttled",
        retryAfterMs: 10 * 60_000,
      });
      expect(listed).toBe(0);
      expect(fields).toMatchObject({
        pausedSource: "old_engine",
        pausedReason: reason,
        pausedRetryAfterMs: 10 * 60_000,
        gatePriority: "background",
      });
    });

    it.each([
      ["the primary scan", { scopeId: "primary", pageToken: "p2" }],
      [
        "a first sync's older inbox",
        { scopeId: "history", windowStartMs: 1, phase: "inbox", synced: 0 },
      ],
    ])("still lists %s, which a person is waiting on", async (_name, page) => {
      const { result, fields, listed } = await enumerateAs(
        "missing_revision",
        page,
      );
      expect(result).toMatchObject({ status: "ok" });
      expect(listed).toBe(1);
      expect(fields.pausedSource).toBeUndefined();
    });

    it("leaves a current engine's background backfill to the usual budget", async () => {
      const { result, fields, listed } = await enumerateAs(null, {
        scopeId: "history",
        windowStartMs: 1,
        phase: "rest",
      });
      expect(result).toMatchObject({ status: "ok" });
      expect(listed).toBe(1);
      expect(fields.pausedSource).toBeUndefined();
    });
  });

  it("logs a mailbox's local-budget pause at most once a minute", () => {
    expect(shouldLogLocalBudgetPause("rate-a", 1000)).toBe(true);
    expect(shouldLogLocalBudgetPause("rate-a", 30_000)).toBe(false);
    expect(shouldLogLocalBudgetPause("rate-b", 30_000)).toBe(true);
    expect(shouldLogLocalBudgetPause("rate-a", 61_000)).toBe(true);
  });

  it("reads a scan's first screen whole on its own, then pages its quota admits without waiting", async () => {
    const getMessagesWithPagination = vi.fn(async () => ({
      messages: [],
      nextPageToken: "next",
    }));
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
    const lastMaxResults = () =>
      (
        getMessagesWithPagination.mock.lastCall as unknown as [
          { maxResults: number },
        ]
      )[0].maxResults;
    const pageUnits = (messages: number) =>
      gmailMailSyncCosts.list + messages * gmailMailSyncCosts.message;

    // Whole messages, so the page leaves no hydration to hold the engine's
    // commands, and only a screen of them, so the inbox fills sooner.
    await enumerate({ scopeId: "primary", initial: true });
    expect(getMessagesWithPagination).toHaveBeenLastCalledWith({
      maxResults: 12,
      pageToken: undefined,
      includeDrafts: true,
    });

    // A larger page would hold its request in the gate while the bucket
    // refills, as 50-message pages did for about 12 seconds each.
    for (const [token, priority, expected] of [
      [{ scopeId: "primary", initial: true, pageToken: "next" }, "sync", 19],
      [{ scopeId: "history", initial: true }, "background", 9],
      [
        { scopeId: "history", initial: true, pageToken: "next" },
        "background",
        9,
      ],
    ] as const) {
      await enumerate(token);
      const size = lastMaxResults();
      expect(size).toBe(expected);
      expect(pageUnits(size)).toBeLessThanOrEqual(gmailBurstUnitsFor(priority));
      expect(pageUnits(size + 1)).toBeGreaterThan(gmailBurstUnitsFor(priority));
    }
    expect(getMessagesWithPagination).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageToken: "next", includeDrafts: true }),
    );
  });

  it("prices local sync units like the quota gate prices the same Gmail calls", () => {
    const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
    expect(gmailMailSyncCosts.list).toBe(gmailRequestCost("GET", base));
    expect(gmailMailSyncCosts.message).toBe(
      gmailRequestCost("GET", `${base}/m1`),
    );
  });

  it("keeps Outlook scan pages at its own page size", async () => {
    const getMessagesWithPagination = vi.fn(async () => ({
      messages: [],
      nextPageToken: "next",
    }));
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "microsoft",
        getMessagesWithPagination,
      } as unknown as EmailProvider,
    });
    await source.enumerate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      bootstrapId: "mailbox",
      page: JSON.stringify({ scopeId: "primary", pageToken: "next" }),
      pageSize: 50,
    });
    expect(getMessagesWithPagination).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxResults: 20 }),
    );
  });

  it("asks Gmail for a first sync's first page as sync, leaving a person's share free", async () => {
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

    expect(priorities).toEqual(["sync", "sync", "sync", "background"]);
  });

  it("lists a first sync's older inbox before the rest of its backfill window", async () => {
    const listed: Array<{ query?: string; before?: Date; pageToken?: string }> =
      [];
    // Two inbox pages, then one page of the window's other mail.
    const pages: Record<string, string | undefined> = {
      "in:inbox|": "inbox-2",
      "in:inbox|inbox-2": undefined,
      rest: undefined,
    };
    const mintedFor = new Map<string, string | undefined>();
    const tokens: string[] = [];
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        async getMessagesWithPagination(options: {
          query?: string;
          before?: Date;
          pageToken?: string;
        }) {
          listed.push(options);
          // Like Gmail's, a cursor only continues the query that minted it.
          if (
            options.pageToken &&
            mintedFor.get(options.pageToken) !== options.query
          )
            throw Object.assign(new Error("Invalid pageToken"), {
              status: 400,
            });
          const key = options.query?.startsWith("in:inbox")
            ? `in:inbox|${options.pageToken ?? ""}`
            : "rest";
          const nextPageToken = pages[key];
          if (nextPageToken) mintedFor.set(nextPageToken, options.query);
          return { messages: [], nextPageToken };
        },
        getMailboxSyncPage: vi.fn(async () => ({
          cursor: null,
          upsertedMessages: [],
          deletedMessageIds: [],
          hasMore: false,
        })),
      } as unknown as EmailProvider,
    });
    const context = {
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
    };
    const begun = await source.beginBootstrap({
      ...context,
      scope: { id: "history", kind: "account", folderId: null },
      afterMs: null,
      initial: true,
      windowedBackfill: true,
    });
    if (begun.status !== "ok") throw new Error("expected ok");
    let page: string | null = begun.value.enumerationToken;
    let windowStartMs: number | undefined;
    for (let i = 0; page && i < 5; i++) {
      tokens.push(page);
      const result = await source.enumerate({
        ...context,
        bootstrapId: begun.value.bootstrapId,
        page,
        pageSize: 50,
      });
      if (result.status !== "ok") throw new Error("expected ok");
      if (result.value.nextPage === null)
        windowStartMs = result.value.windowStartMs;
      page = result.value.nextPage;
    }

    expect(page).toBeNull();
    // Gmail lists newest first, so the inbox arrives newest first too; the
    // second query is the window's other mail, which the first never read.
    expect(listed.map((options) => options.query)).toEqual([
      "in:inbox",
      "in:inbox",
      expect.stringMatching(/^\{is:starred in:drafts after:\d+\} -in:inbox$/),
    ]);
    expect(listed.map((options) => options.pageToken)).toEqual([
      undefined,
      "inbox-2",
      undefined,
    ]);
    // Both cover only mail the recent scan leaves to the backfill.
    for (const options of listed)
      expect(options.before?.getTime()).toBeLessThan(Date.now());
    // The scan still reports the window it covered.
    expect(windowStartMs).toBeGreaterThan(0);

    // A server rolled back to before phases reads only `pageToken`, so on
    // every token this scan wrote it starts its one combined query from the
    // window start: more reads, but nothing an inbox cursor would skip.
    for (const token of tokens) {
      expect(readAsBeforePhases(token)).toEqual({
        query: expect.stringMatching(/^\{in:inbox is:starred in:drafts /),
        pageToken: undefined,
      });
    }
    // And this code never carries a cursor across phases, even one left in
    // `pageToken`.
    listed.length = 0;
    const stray = await source.enumerate({
      ...context,
      bootstrapId: begun.value.bootstrapId,
      page: JSON.stringify({
        ...JSON.parse(tokens.at(-1) ?? "{}"),
        pageToken: "inbox-2",
      }),
      pageSize: 50,
    });
    expect(stray.status).toBe("ok");
    expect(listed.map((options) => options.pageToken)).toEqual([undefined]);
  });

  it("reads a first sync's first inbox backfill pages at sync behind the primary scan, and the rest at background", async () => {
    const seen: Array<{ priority: string; afterInitialSync?: boolean }> = [];
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        async getMessagesWithPagination(options: { maxResults: number }) {
          const { priority, afterInitialSync } = currentGmailQuotaContext();
          seen.push({ priority, afterInitialSync });
          return {
            messages: Array.from({ length: options.maxResults }, (_, i) =>
              gmailMessage(`m${seen.length}-${i}`, Date.now() - i),
            ),
            nextPageToken: "next",
          };
        },
      } as unknown as EmailProvider,
    });
    const enumerate = async (page: string) => {
      const result = await source.enumerate({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "r1",
        signal: new AbortController().signal,
        bootstrapId: "mailbox",
        page,
        pageSize: 50,
      });
      if (result.status !== "ok" || !result.value.nextPage)
        throw new Error("expected another page");
      return result.value.nextPage;
    };
    let page = JSON.stringify({
      scopeId: "history",
      windowStartMs: Date.now() - 30 * 24 * 60 * 60 * 1000,
      phase: "inbox",
    });
    let listedAtSync = 0;
    const budgets: string[] = [];
    for (let i = 0; i < 20; i++) {
      page = await enumerate(page);
      const last = seen.at(-1);
      budgets.push(
        (
          vi.mocked(withLocalMailSyncBudget).mock.lastCall?.[0] as {
            priority: string;
          }
        ).priority,
      );
      if (last?.priority === "sync") listedAtSync = JSON.parse(page).synced;
    }

    // The first couple of hundred inbox messages come in sync's larger pages,
    // and only once the primary scan is done; then the long tail is paced
    // as background, as the whole backfill was before.
    const sync = seen.filter((entry) => entry.priority === "sync");
    expect(sync.length).toBeGreaterThan(5);
    expect(sync.every((entry) => entry.afterInitialSync === true)).toBe(true);
    expect(seen.slice(0, sync.length)).toEqual(sync);
    expect(seen.slice(sync.length).map((entry) => entry.priority)).toEqual(
      new Array(seen.length - sync.length).fill("background"),
    );
    expect(listedAtSync).toBeGreaterThanOrEqual(200);
    expect(listedAtSync).toBeLessThan(200 + 19);
    // It draws on the backfill's own share of the account's sync envelope
    // throughout, so it moves work earlier without spending more per minute.
    expect(new Set(budgets)).toEqual(new Set(["backfill"]));
  });

  it("starts the primary stream's catch-up over all time, so old mail moved into the inbox mid-backfill still arrives", async () => {
    const getMailboxSyncPage = vi.fn(async (options: { after: Date }) => ({
      cursor: encodeMailboxSyncCursor({
        version: 1,
        provider: "google",
        phase: "delta",
        historyId: "42",
        after: options.after.toISOString(),
      }),
      upsertedMessages: [],
      deletedMessageIds: [],
      hasMore: false,
    }));
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        getMailboxSyncPage,
      } as unknown as EmailProvider,
    });
    const begun = await source.beginBootstrap({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      scope: { id: "primary", kind: "account", folderId: null },
      afterMs: null,
      initial: true,
    });
    if (begun.status !== "ok") throw new Error("expected ok");
    const checkpoint = begun.value.catchUpFrom.checkpoint;
    if (!checkpoint) throw new Error("expected a checkpoint");
    // The delta read drops any message older than its cursor's `after`.
    expect(decodeMailboxSyncCursor(checkpoint, "google")).toMatchObject({
      after: new Date(0).toISOString(),
    });
  });

  it("keeps a backfill begun before inbox-first paging on its one combined query", async () => {
    const listed: Array<{ query?: string }> = [];
    const priorities: string[] = [];
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        async getMessagesWithPagination(options: { query?: string }) {
          listed.push(options);
          priorities.push(currentGmailQuotaContext().priority);
          return { messages: [], nextPageToken: "next" };
        },
      } as unknown as EmailProvider,
    });
    await source.enumerate({
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "r1",
      signal: new AbortController().signal,
      bootstrapId: "mailbox",
      page: JSON.stringify({
        scopeId: "history",
        windowStartMs: Date.now() - 30 * 24 * 60 * 60 * 1000,
        pageToken: "next",
      }),
      pageSize: 50,
    });
    expect(listed[0]?.query).toMatch(/^\{in:inbox is:starred in:drafts /);
    expect(priorities).toEqual(["background"]);
  });

  it("keeps a first backfill whole for a client that can't record a window", async () => {
    const listed: Array<{ query?: string; after?: Date }> = [];
    const source = createEmailProviderMailboxSource({
      logger,
      accountId: "acc-1",
      provider: {
        name: "google",
        async getMessagesWithPagination(options: {
          query?: string;
          after?: Date;
        }) {
          listed.push(options);
          return { messages: [] };
        },
        getMailboxSyncPage: vi.fn(async () => ({
          cursor: null,
          upsertedMessages: [],
          deletedMessageIds: [],
          hasMore: false,
        })),
      } as unknown as EmailProvider,
    });
    const backfill = async (windowedBackfill?: boolean) => {
      const begun = await source.beginBootstrap({
        session: { accountId: "acc-1", generation: "g1" },
        requestId: "r1",
        signal: new AbortController().signal,
        scope: { id: "history", kind: "account", folderId: null },
        afterMs: null,
        initial: true,
        ...(windowedBackfill && { windowedBackfill }),
      });
      if (begun.status !== "ok") throw new Error("expected ok");
      let page = begun.value.enumerationToken;
      for (;;) {
        const result = await source.enumerate({
          session: { accountId: "acc-1", generation: "g1" },
          requestId: "r1",
          signal: new AbortController().signal,
          bootstrapId: begun.value.bootstrapId,
          page,
          pageSize: 50,
        });
        if (result.status !== "ok" || !result.value.nextPage) return result;
        page = result.value.nextPage;
      }
    };

    // An older client drops the window from the result, so it would record a
    // 30-day scan as the whole mailbox.
    const whole = await backfill();
    expect(listed[0]?.query).toBeUndefined();
    expect(listed[0]?.after).toBeUndefined();
    expect(whole.status === "ok" && whole.value).not.toHaveProperty(
      "windowStartMs",
    );

    const windowed = await backfill(true);
    expect(listed[1]?.query).toBe("in:inbox");
    expect(
      windowed.status === "ok" && windowed.value.nextPage === null
        ? windowed.value.windowStartMs
        : undefined,
    ).toBeGreaterThan(0);
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
        async getAttachmentStream(
          messageId: string,
          attachmentId: string,
          signal?: AbortSignal,
        ) {
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

  it("first syncs the last 30 days plus the whole inbox, starred and drafts, then a resync covers everything", async () => {
    const day = 24 * 60 * 60 * 1000;
    const archived = (id: string, at: number) => ({
      ...gmailMessage(id, at),
      labelIds: [],
    });
    const mailbox = new Map<string, ParsedMessage>([
      ["recent", gmailMessage("recent", Date.now() - day)],
      ["month", archived("month", Date.now() - 20 * day)],
      ["old-inbox", gmailMessage("old-inbox", Date.now() - 400 * day)],
      ["old-archived", archived("old-archived", Date.now() - 400 * day)],
      [
        "old-starred",
        {
          ...archived("old-starred", Date.now() - 400 * day),
          labelIds: ["STARRED"],
        },
      ],
      [
        "old-draft",
        {
          ...archived("old-draft", Date.now() - 400 * day),
          labelIds: ["DRAFT"],
        },
      ],
    ]);
    const listed: Array<{ query?: string; after?: Date; before?: Date }> = [];
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
      // Answers as Gmail does for the queries a scan sends.
      async getMessagesWithPagination(options: {
        query?: string;
        after?: Date;
        before?: Date;
      }) {
        listed.push(options);
        const keptOrAfter = options.query?.match(
          /^\{(in:inbox )?is:starred in:drafts after:(\d+)\}( -in:inbox)?$/,
        );
        const has = (message: ParsedMessage, label: string) =>
          message.labelIds?.includes(label) ?? false;
        return {
          messages: [...mailbox.values()].filter((message) => {
            const at = Number(message.internalDate);
            if (options.before && at >= options.before.getTime()) return false;
            if (options.after && at < options.after.getTime()) return false;
            if (options.query === "in:inbox") return has(message, "INBOX");
            if (keptOrAfter) {
              const [, inbox, after, notInbox] = keptOrAfter;
              if (notInbox && has(message, "INBOX")) return false;
              return (
                (inbox !== undefined && has(message, "INBOX")) ||
                has(message, "STARRED") ||
                has(message, "DRAFT") ||
                at >= Number(after) * 1000
              );
            }
            return !options.query;
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
      async getMessage(id: string) {
        const message = mailbox.get(id);
        if (!message)
          throw Object.assign(new Error("Not found"), { status: 404 });
        return message;
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
    const localIds = async (
      mailboxName: "all" | "inbox" | "starred" | "drafts",
    ) => {
      const { view } = await store.readMailboxView({
        accountIds: ["acc-1"],
        predicate: { kind: "mailbox", mailbox: mailboxName },
        order: "newest_first",
        pageSize: 25,
        after: null,
      });
      return view.conversations
        .map((conversation) => conversation.key.conversationId)
        .sort();
    };
    const historyCoverage = async () =>
      (await engine.getDiagnostics("acc-1")).coverage.find(
        (item) => item.scopeId === "history",
      );
    const runFor = async (rounds: number) => {
      for (let round = 0; round < rounds; round++) {
        await engine.runUntil(now + 20);
      }
    };

    const startedAt = Date.now();
    await engine.requestSync(["acc-1"]);
    await runFor(5);

    // Mail older than 30 days is skipped unless it is in the inbox, starred
    // or a draft: those lists have no older-mail fallback to Gmail.
    expect(await localIds("inbox")).toEqual(["t-old-inbox", "t-recent"]);
    expect(await localIds("starred")).toEqual(["t-old-starred"]);
    expect(await localIds("drafts")).toEqual(["t-old-draft"]);
    expect(await localIds("all")).not.toContain("t-old-archived");
    expect(listed.every((options) => options.query || options.after)).toBe(
      true,
    );
    // The store knows the history it holds starts 30 days back, so nothing
    // treats it as the whole mailbox.
    const windowStartMs = (await historyCoverage())?.windowStartMs ?? 0;
    expect(windowStartMs).toBeGreaterThanOrEqual(startedAt - 30 * day);
    expect(windowStartMs).toBeLessThanOrEqual(Date.now() - 30 * day);
    // Catching up keeps that window rather than calling the scope complete.
    now += 60_000;
    await runFor(3);
    expect((await historyCoverage())?.windowStartMs).toBe(windowStartMs);

    // Offline past Gmail's history retention, an old inbox message is
    // archived; a resync walks the whole mailbox, so it and the old mail the
    // first sync skipped are both brought up to date.
    historyExpired = true;
    mailbox.set("old-inbox", archived("old-inbox", Date.now() - 400 * day));
    now += 11 * 60_000;
    await runFor(5);
    historyExpired = false;
    now += 11 * 60_000;
    await runFor(10);

    expect(await localIds("inbox")).toEqual(["t-recent"]);
    expect(await localIds("all")).toEqual(
      expect.arrayContaining([
        "t-month",
        "t-old-archived",
        "t-old-inbox",
        "t-recent",
      ]),
    );
    expect((await historyCoverage())?.windowStartMs).toBeUndefined();
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

// How `enumerate` read a backfill token before inbox-first phases (2d841e2):
// one combined query over the window, resumed by `pageToken`.
function readAsBeforePhases(page: string) {
  const token = JSON.parse(page) as {
    windowStartMs?: number;
    pageToken?: string;
  };
  return {
    query:
      token.windowStartMs == null
        ? undefined
        : `{in:inbox is:starred in:drafts after:${Math.floor(token.windowStartMs / 1000) - 1}}`,
    pageToken: token.pageToken,
  };
}
