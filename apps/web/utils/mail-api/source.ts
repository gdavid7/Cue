import { messageMatchesPredicate } from "@inboxzero/mail-core/query-semantics";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import type {
  MailboxSource,
  ScopeDescriptor,
} from "@inboxzero/mail-core/ports/mailbox-source";
import type { BodyObservation, SyncPosition } from "@inboxzero/mail-core/sync";
import type { MessageKey } from "@inboxzero/mail-core/identities";
import {
  decodeMailboxSyncCursor,
  encodeMailboxSyncCursor,
  InvalidMailboxSyncCursorError,
  MAILBOX_SYNC_PAGE_MAX_MESSAGES,
} from "@/utils/email/mailbox-sync";
import type { EmailProvider, ProviderMailboxSearch } from "@/utils/email/types";
import {
  parsedMessageMetadata,
  parsedMessageBodyObservation,
  parsedMessagePatch,
} from "@/utils/mail-api/observations";
import { isProviderRateLimitModeError } from "@/utils/email/rate-limit-mode-error";
import { GmailLabel } from "@/utils/gmail/label";
import {
  getProviderRateLimitDelayMs,
  recordProviderRateLimitFromError,
} from "@/utils/email/rate-limit";
import {
  debitLocalMailSyncBudget,
  gmailMailSyncCosts,
  LocalMailSyncPausedError,
  normalizeThrottleHeaders,
  withLocalMailSyncBudget,
} from "@/utils/email/local-mail-sync-budget";
import { isEmailProviderRateLimitRedisConfigured } from "@/utils/redis/email-provider-rate-limit";
import type { Logger } from "@/utils/logger";
import { isInvalidGrantError } from "@/utils/error";
import { extractErrorInfo as extractGmailErrorInfo } from "@/utils/gmail/retry";
import { extractErrorInfo as extractOutlookErrorInfo } from "@/utils/outlook/retry";
import type { ParsedMessage } from "@/utils/types";
import { mapWithConcurrency } from "@/utils/async";
import { convertEmailHtmlToText } from "@/utils/mail";
import {
  createGmailQuotaStats,
  currentGmailQuotaContext,
  getGmailCallDeferredError,
  type GmailQuotaPriority,
  isGmailCallDeferredError,
  runWithGmailQuota,
  setGmailInitialSync,
} from "@/utils/gmail/quota";

// Outlook allows four concurrent Graph requests per mailbox, shared with
// webhook processing, so batched folder reads stay below that.
const CHANGES_BATCH_CONCURRENCY = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
// Gmail's first scan covers only recent mail so the inbox fills and live
// catch-up starts within seconds; older mail backfills in its own scope.
const GMAIL_RECENT_WINDOW_MS = 3 * DAY_MS;
const GMAIL_HISTORY_SCOPE_ID = "history";
// The two scans start at different times, so the backfill reaches into the
// recent window to leave no gap at the boundary between them.
const GMAIL_HISTORY_OVERLAP_MS = DAY_MS;
const GMAIL_THREAD_COST = 40;
// The first page of a scan is what the inbox shows first; a smaller one fills
// it sooner and spends less of the minute's Gmail quota before it does. The
// quota gate prices a metadata read like a whole one for now; once it prices
// by format, a first sync's metadata page can grow to 50.
const GMAIL_FIRST_PAGE_SIZE = 25;

const SUPPORTED_CHANGES = [
  "archive",
  "unarchive",
  "set_read",
  "set_starred",
  "trash",
  "restore_from_trash",
  "set_spam",
  "move",
  "set_membership",
  "snooze",
] as const;

type FolderScopeNode = {
  id: string;
  systemType?: string;
  childFolders?: FolderScopeNode[];
};

type BootstrapToken = {
  afterMs?: number;
  catchUpFrom?: SyncPosition | null;
  folderId?: string | null;
  /** The recent scan of a mailbox that has never synced, as after a sign-in. */
  initial?: boolean;
  pageToken?: string;
  receivedAfterMs?: number;
  receivedBeforeMs?: number;
  scopeId?: string;
};

export function createEmailProviderMailboxSource(input: {
  provider: EmailProvider;
  accountId: string;
  logger: Logger;
}): MailboxSource & Required<Pick<MailboxSource, "readChangesBatch">> {
  const { provider, accountId, logger } = input;
  const maxPageSize = provider.name === "microsoft" ? 20 : 50;
  const isGmail = provider.name === "google";
  const source: MailboxSource = {
    async describe() {
      return {
        status: "ok",
        value: {
          strategy:
            provider.localMailSyncStrategy === "folder-delta"
              ? "folder_delta"
              : "account_history",
          supportedChanges: [...SUPPORTED_CHANGES],
          maxPageSize,
          maxHydrationBatch: 20,
        },
      };
    },
    async discoverScopes() {
      if (provider.name === "microsoft") {
        try {
          const folders = await provider.getFolders();
          return {
            status: "ok",
            value: {
              scopes: flattenFolderScopes(folders),
              nextPage: null,
            },
          };
        } catch (error) {
          return mapProviderError(error);
        }
      }
      return {
        status: "ok",
        value: {
          scopes: [
            { id: "primary", kind: "account", folderId: null },
            {
              id: GMAIL_HISTORY_SCOPE_ID,
              kind: "account",
              folderId: null,
              priority: "low",
            },
          ],
          nextPage: null,
        },
      };
    },
    async beginBootstrap({ afterMs, initial, scope, session }) {
      try {
        const isHistory = isGmail && scope.id === GMAIL_HISTORY_SCOPE_ID;
        const token: BootstrapToken = {
          afterMs: afterMs ?? 0,
          ...(initial && isGmail && !isHistory && { initial: true }),
          scopeId: scope.id,
          folderId: scopedFolderId(provider, scope),
          receivedAfterMs:
            isGmail && !isHistory
              ? Date.now() - GMAIL_RECENT_WINDOW_MS
              : undefined,
          receivedBeforeMs: isHistory
            ? Date.now() - GMAIL_RECENT_WINDOW_MS + GMAIL_HISTORY_OVERLAP_MS
            : undefined,
        };
        const catchUpFrom: SyncPosition = {
          streamId: token.scopeId ?? "primary",
          generation: session.generation,
          checkpoint: await catchUpCheckpoint(
            provider,
            [],
            token.folderId ?? undefined,
            token.afterMs ?? 0,
          ),
        };
        token.catchUpFrom = catchUpFrom;
        return {
          status: "ok" as const,
          value: {
            bootstrapId: "mailbox",
            enumerationToken: JSON.stringify(token),
            catchUpFrom,
          },
        };
      } catch (error) {
        return mapProviderError(error);
      }
    },
    async enumerate({ page, session, pageSize }) {
      let isBackfill = false;
      try {
        const token = JSON.parse(page) as BootstrapToken;
        isBackfill = isGmail && token.scopeId === GMAIL_HISTORY_SCOPE_ID;
        const isPrimaryGmailScan = isGmail && !isBackfill;
        if (isPrimaryGmailScan) await setGmailInitialSync(accountId, true);
        const isFirstSyncFirstPage =
          isPrimaryGmailScan && token.initial === true && !token.pageToken;
        const maxResults = Math.min(
          pageSize,
          maxPageSize,
          isGmail && !token.pageToken ? GMAIL_FIRST_PAGE_SIZE : maxPageSize,
        );
        const listPage = () =>
          provider.getMessagesWithPagination({
            maxResults,
            folderId: token.folderId ?? undefined,
            pageToken: token.pageToken,
            includeDrafts: true,
            // After a sign-in the first page is read as metadata: senders,
            // subjects and previews without bodies, a tenth of the bytes, so
            // the list shows and works sooner. Its bodies follow as required
            // hydration, in the background.
            ...(isFirstSyncFirstPage && { format: "metadata" as const }),
            ...(token.receivedAfterMs != null && {
              after: new Date(token.receivedAfterMs),
            }),
            ...(token.receivedBeforeMs != null && {
              before: new Date(token.receivedBeforeMs),
            }),
          });
        // The backfill only fills in older mail, so it yields to everything
        // else. The primary scan fills the inbox the user is waiting on, and
        // after a sign-in the screen waits on its very first page.
        let priority: GmailQuotaPriority = "sync";
        if (isBackfill) priority = "background";
        else if (isFirstSyncFirstPage) priority = "interactive";
        const syncPage = isGmail
          ? await runWithGmailQuota({ priority }, () =>
              withGmailSyncBudget(
                {
                  emailAccountId: accountId,
                  priority: isBackfill ? "backfill" : "current",
                  cost: gmailPageCost(maxResults),
                },
                listPage,
              ),
            )
          : await listPage();
        if (isPrimaryGmailScan && !syncPage.nextPageToken)
          await setGmailInitialSync(accountId, false);
        const changes = syncPage.messages.map((message) =>
          parsedMessagePatch(accountId, provider.name, message, {
            format: isFirstSyncFirstPage ? "metadata" : undefined,
          }),
        );
        const { requiredHydration, bodies } = parsedMessageBodies(
          accountId,
          syncPage.messages,
        );
        if (syncPage.nextPageToken) {
          return {
            status: "ok" as const,
            value: {
              bootstrapId: "mailbox",
              scopeId: token.scopeId ?? "primary",
              changes,
              requiredHydration,
              bodies,
              nextPage: JSON.stringify({
                afterMs: token.afterMs ?? 0,
                catchUpFrom: token.catchUpFrom ?? null,
                folderId: token.folderId ?? null,
                pageToken: syncPage.nextPageToken,
                receivedAfterMs: token.receivedAfterMs,
                receivedBeforeMs: token.receivedBeforeMs,
                scopeId: token.scopeId ?? "primary",
              }),
              catchUpFrom: null,
            },
          };
        }
        return {
          status: "ok" as const,
          value: {
            bootstrapId: "mailbox",
            scopeId: token.scopeId ?? "primary",
            changes,
            requiredHydration,
            bodies,
            nextPage: null,
            catchUpFrom: await finalCatchUpFrom({
              provider,
              token,
              session,
              messages: syncPage.messages,
            }),
          },
        };
      } catch (error) {
        if (error instanceof InvalidMailboxSyncCursorError) {
          return { status: "reset_required", scopeId: "primary" };
        }
        // The budget's own cooldown paces a throttled backfill; account-wide
        // rate-limit mode would also stop webhooks and automation.
        return mapProviderError(error, { recordRateLimit: !isBackfill });
      }
    },
    async readChanges({ position, session, requestId, pageSize }) {
      if (
        isGmail &&
        position.streamId === GMAIL_HISTORY_SCOPE_ID &&
        provider.advanceMailboxSyncCursor
      ) {
        // Live changes reach every message through the primary stream, so the
        // backfill's cursor only tracks whether Gmail still holds the history
        // since it finished. Once that expires, changes to older mail are lost
        // and the backfill must run again alongside the primary resync.
        try {
          const checkpoint = position.checkpoint
            ? await provider.advanceMailboxSyncCursor(position.checkpoint)
            : null;
          if (!checkpoint) {
            return { status: "reset_required", scopeId: position.streamId };
          }
          return {
            status: "page" as const,
            page: {
              session,
              requestId,
              from: position,
              to: { ...position, checkpoint },
              changes: [],
              requiredHydration: [],
              roundComplete: true,
            },
          };
        } catch (error) {
          if (error instanceof InvalidMailboxSyncCursorError) {
            return { status: "reset_required", scopeId: position.streamId };
          }
          return mapProviderError(error);
        }
      }
      try {
        const page = await provider.getMailboxSyncPage({
          cursor: position.checkpoint || undefined,
          folderId:
            provider.name === "microsoft" && position.streamId !== "primary"
              ? position.streamId
              : undefined,
          includeBodies: true,
          limit: pageSize,
        });
        if (page.reset) {
          return { status: "reset_required", scopeId: position.streamId };
        }
        // A page without bodies carries metadata only, so a body-derived flag
        // such as a meeting invitation must not stand in for the body.
        // Bodies can be megabytes each, so one page carries a bounded number
        // and the rest are hydrated in batches.
        const withBodies = page.includesBodies
          ? page.upsertedMessages.slice(0, MAILBOX_SYNC_PAGE_MAX_MESSAGES)
          : [];
        const { requiredHydration, bodies } = parsedMessageBodies(
          accountId,
          withBodies,
        );
        for (const message of page.upsertedMessages.slice(withBodies.length)) {
          requiredHydration.push({ accountId, messageId: message.id });
        }
        return {
          status: "page" as const,
          page: {
            session,
            requestId,
            from: position,
            to: {
              streamId: position.streamId,
              generation: session.generation,
              checkpoint: page.cursor,
            },
            changes: [
              ...page.upsertedMessages.map((message) =>
                parsedMessagePatch(accountId, provider.name, message),
              ),
              ...page.deletedMessageIds.map((messageId) => ({
                kind: "message_deleted" as const,
                key: { accountId, messageId },
                // Delta cursors can outgrow the evidence limit; the page
                // already carries the cursor as its checkpoint.
                evidence: requestId,
              })),
              ...(page.removedMessageIds ?? []).map((messageId) => ({
                kind: "removed_from_scope" as const,
                key: { accountId, messageId },
                scopeId: position.streamId,
              })),
            ],
            requiredHydration,
            bodies,
            roundComplete: !page.hasMore,
          },
        };
      } catch (error) {
        if (error instanceof InvalidMailboxSyncCursorError) {
          return { status: "reset_required", scopeId: position.streamId };
        }
        return mapProviderError(error);
      }
    },
    async hydrate({ keys, purpose }) {
      const debited = debitForegroundUsage(
        keys.length * gmailMailSyncCosts.message,
      );
      try {
        // Opening a message asks for its body alone; sync pages ask for the
        // bodies they lacked in batches, which can wait their turn.
        const isMessageOpen = purpose === "body" && keys.length === 1;
        const { messages, unresolved } = isGmail
          ? await runWithGmailQuota(
              { priority: isMessageOpen ? "interactive" : "sync" },
              () => batchedMessages(provider, keys),
            )
          : await batchedMessages(provider, keys);
        return {
          status: "ok" as const,
          value: {
            changes: messages.map((message) =>
              parsedMessagePatch(accountId, provider.name, message),
            ),
            bodies:
              purpose === "body" ? hydratedBodies(accountId, messages) : [],
            unresolved,
          },
        };
      } catch (error) {
        return mapProviderError(error);
      } finally {
        await debited;
      }
    },
    async readConversationMembership({
      conversation,
      resolutionId,
      page,
      pageSize,
    }) {
      const debited = debitForegroundUsage(GMAIL_THREAD_COST);
      try {
        const thread = await provider.getThread(conversation.conversationId, {
          complete: true,
          includeDrafts: true,
        });
        // Triage commands act on these messages, so a conversation's drafts
        // stay out unless they are all it has: then they are what opening it
        // must show.
        let messages = thread.messages.filter(
          (message) => !message.labelIds?.includes(GmailLabel.DRAFT),
        );
        if (!messages.length) messages = thread.messages;
        if (!messages.length) {
          messages = await provider.getThreadMessages(
            conversation.conversationId,
          );
        }
        const start = page ? Number(page) || 0 : 0;
        const slice = messages.slice(start, start + pageSize);
        return {
          status: "ok",
          value: {
            status: "page" as const,
            page: {
              conversation,
              resolutionId,
              keys: slice.map((message) => ({
                accountId,
                messageId: message.id,
              })),
              changes: slice.map((message) =>
                parsedMessagePatch(accountId, provider.name, message),
              ),
              nextPage:
                start + pageSize < messages.length
                  ? String(start + pageSize)
                  : null,
              evidence: thread.historyId ?? null,
            },
          },
        };
      } catch (error) {
        if (!isMissingProviderResource(error)) return mapProviderError(error);
        return { status: "ok", value: { status: "not_found" } };
      } finally {
        await debited;
      }
    },
    async search({ predicate, page, pageSize }) {
      const compiled = compileMailboxSearch(predicate);
      if (!compiled) return { status: "unsupported" };
      let result: Awaited<ReturnType<EmailProvider["searchMessages"]>>;
      const debited = debitForegroundUsage(
        gmailPageCost(Math.min(pageSize, maxPageSize)),
      );
      try {
        result = await provider.searchMessages({
          query: "",
          mailboxSearch: compiled.search,
          maxResults: Math.min(pageSize, maxPageSize),
          pageToken: page ?? undefined,
        });
      } catch (error) {
        // A rejected query fails the same way every time, so the client
        // must drop it rather than retry it.
        if (isRejectedProviderRequest(error)) return { status: "unsupported" };
        return mapProviderError(error);
      } finally {
        await debited;
      }
      const candidates = await mapWithConcurrency(
        result.messages,
        5,
        async (message) => {
          const fields = searchMessageFields(accountId, message);
          if (!messageMatchesPredicate(fields, compiled.filter)) return null;
          const text = compiled.search.text;
          if (!text || messageMatchesPredicate(fields, text)) return message;
          if (
            text.field !== "any" ||
            message.textPlain != null ||
            message.textHtml != null
          )
            return null;
          // List projections can omit the body that made the provider return this candidate.
          const fullMessage = await provider.getMessage(message.id);
          const fullFields = searchMessageFields(accountId, fullMessage);
          return messageMatchesPredicate(fullFields, compiled.filter) &&
            messageMatchesPredicate(fullFields, text)
            ? fullMessage
            : null;
        },
      );
      const matches = candidates.filter((message) => message !== null);
      return {
        status: "ok",
        value: {
          matches: matches.map((message) => ({
            accountId,
            messageId: message.id,
          })),
          // The search already fetched each match in full, so the client
          // stores these instead of fetching every message again.
          changes: matches.map((message) =>
            parsedMessagePatch(accountId, provider.name, message),
          ),
          bodies: parsedMessageBodies(accountId, matches).bodies,
          nextPage: result.nextPageToken ?? null,
          semantics: "candidates_require_local_filter" as const,
        },
      };
    },
    async readAttachment({ key, attachmentId, signal }) {
      try {
        const stream = await provider.getAttachmentStream(
          key.messageId,
          attachmentId,
          signal,
        );
        return {
          status: "ok" as const,
          value: {
            bytes: streamToIterable(stream),
            sizeBytes: null,
          },
        };
      } catch (error) {
        if (isMissingProviderResource(error)) {
          return { status: "not_found" as const };
        }
        return mapProviderError(error);
      }
    },
  };
  // Foreground reads are never held back by the sync budget, but they draw
  // from it so background scans slow down while someone uses the mailbox.
  function debitForegroundUsage(cost: number) {
    if (!isGmail || !isEmailProviderRateLimitRedisConfigured()) {
      return Promise.resolve();
    }
    return debitLocalMailSyncBudget({
      emailAccountId: accountId,
      provider: "google",
      cost: Math.max(1, Math.min(cost, gmailPageCost(maxPageSize))),
    }).catch(() => undefined);
  }

  async function mapProviderError(
    error: unknown,
    { recordRateLimit = true }: { recordRateLimit?: boolean } = {},
  ) {
    if (error instanceof LocalMailSyncPausedError) {
      return throttled(error.retryAfterMs);
    }
    const deferred = getGmailCallDeferredError(error);
    if (deferred) return throttled(deferred.retryAfterMs);
    if (isProviderRateLimitModeError(error)) {
      const retryAtMs = error.retryAt ? Date.parse(error.retryAt) : Number.NaN;
      return throttled(
        Number.isNaN(retryAtMs) ? 15_000 : retryAtMs - Date.now(),
      );
    }
    const rateLimitProvider = isGmail ? "google" : "microsoft";
    const providerError = normalizeThrottleHeaders(error);
    const rateLimitDelayMs = getProviderRateLimitDelayMs({
      error: providerError,
      provider: rateLimitProvider,
      attemptNumber: 1,
    });
    if (rateLimitDelayMs !== null && recordRateLimit) {
      // Recording the mode makes every route for this account wait out the
      // window instead of spending quota the provider has not restored yet.
      try {
        await recordProviderRateLimitFromError({
          error: providerError,
          emailAccountId: accountId,
          provider: rateLimitProvider,
          logger,
          source: "mail-api",
        });
      } catch (recordError) {
        logger.warn("Failed to record provider rate-limit state", {
          error: recordError,
        });
      }
    }
    if (rateLimitDelayMs !== null) return throttled(rateLimitDelayMs);
    const message = error instanceof Error ? error.message : "";
    const lowered = message.toLowerCase();
    if (
      extractGmailErrorInfo(error).status === 401 ||
      extractOutlookErrorInfo(error).status === 401 ||
      isInvalidGrantError(error) ||
      message === "No refresh token" ||
      message.includes("401") ||
      lowered.includes("unauthorized") ||
      lowered.includes("invalid access token")
    ) {
      return { status: "blocked_auth" as const };
    }
    return {
      status: "paused" as const,
      retryAfterMs: 1000,
      reason: "unavailable" as const,
    };
  }

  return {
    ...source,
    async readChangesBatch({ session, reads, pageSize, signal }) {
      const read = (item: (typeof reads)[number]) =>
        source.readChanges({
          session,
          requestId: item.requestId,
          position: item.position,
          pageSize,
          signal,
        });
      // The first read fills the provider's folder and category lookups so the
      // rest reuse them instead of each fetching their own.
      const [first, ...rest] = reads;
      if (!first) return [];
      const firstResult = await read(first);
      return [
        firstResult,
        ...(await mapWithConcurrency(rest, CHANGES_BATCH_CONCURRENCY, read)),
      ];
    },
  };
}

function parsedMessageBodies(accountId: string, messages: ParsedMessage[]) {
  const requiredHydration: Array<{ accountId: string; messageId: string }> = [];
  const bodies: BodyObservation[] = [];
  for (const message of messages) {
    const body = parsedMessageBodyObservation(accountId, message);
    if (body) bodies.push(body);
    else requiredHydration.push({ accountId, messageId: message.id });
  }
  return { requiredHydration, bodies };
}

function hydratedBodies(
  accountId: string,
  messages: ParsedMessage[],
): BodyObservation[] {
  return messages.map(
    (message) =>
      parsedMessageBodyObservation(accountId, message) ?? {
        key: { accountId, messageId: message.id },
        version: message.historyId || null,
        html: null,
        text: null,
        attachments: [],
        isMeetingInvitation: false,
      },
  );
}

async function catchUpCheckpoint(
  provider: EmailProvider,
  messages: ParsedMessage[],
  folderId?: string,
  afterMs = 0,
): Promise<string | null> {
  try {
    const page = await provider.getMailboxSyncPage({
      after: new Date(afterMs),
      folderId,
      // The cursor this starts is the one catch-up follows.
      includeBodies: true,
      limit: 1,
    });
    if (page.cursor) {
      return provider.name === "google"
        ? gmailHistoryCursor(page.cursor)
        : page.cursor;
    }
  } catch (error) {
    if (provider.name === "microsoft") throw error;
    // Fall back to the newest numeric Gmail history id we already fetched.
  }
  return encodedGmailCursorFromMessages(messages);
}

async function finalCatchUpFrom({
  provider,
  token,
  session,
  messages,
}: {
  provider: EmailProvider;
  token: BootstrapToken;
  session: { generation: string };
  messages: ParsedMessage[];
}): Promise<SyncPosition> {
  if (token.catchUpFrom) {
    const checkpoint =
      token.catchUpFrom.checkpoint ??
      (provider.name === "google"
        ? encodedGmailCursorFromMessages(messages)
        : null);
    return { ...token.catchUpFrom, checkpoint };
  }
  return {
    streamId: token.scopeId ?? "primary",
    generation: session.generation,
    checkpoint: await catchUpCheckpoint(
      provider,
      messages,
      token.folderId ?? undefined,
      token.afterMs ?? 0,
    ),
  };
}

function scopedFolderId(provider: EmailProvider, scope: ScopeDescriptor) {
  if (provider.name === "microsoft") return scope.folderId ?? scope.id;
  return scope.folderId ?? undefined;
}

function flattenFolderScopes(folders: FolderScopeNode[]) {
  const scopes: ScopeDescriptor[] = [];
  for (const folder of folders) {
    // New mail the user is waiting on lands in system folders; custom folders
    // can catch up on a slower clock.
    scopes.push({
      id: folder.id,
      kind: "folder",
      folderId: folder.id,
      priority: folder.systemType ? "high" : "low",
    });
    scopes.push(...flattenFolderScopes(folder.childFolders ?? []));
  }
  return scopes;
}

// A fresh Gmail cursor resumes a whole-mailbox snapshot listing. Bootstrap
// enumerates the mailbox itself, so catch-up only needs the history from when
// the scan began; resuming the snapshot would fetch every message again.
function gmailHistoryCursor(cursor: string) {
  const decoded = decodeMailboxSyncCursor(cursor, "google");
  if (decoded.phase !== "snapshot") return cursor;
  return encodeMailboxSyncCursor({
    version: 1,
    provider: "google",
    phase: "delta",
    historyId: decoded.historyId,
    after: decoded.after,
  });
}

function encodedGmailCursorFromMessages(
  messages: ParsedMessage[],
): string | null {
  const historyId = messages
    .map((message) => message.historyId)
    .filter((id): id is string => Boolean(id && /^\d+$/.test(id)))
    .reduce((latest, id) => (BigInt(id) > BigInt(latest) ? id : latest), "0");
  if (historyId === "0") return null;
  return encodeMailboxSyncCursor({
    version: 1,
    provider: "google",
    phase: "delta",
    historyId,
    after: "1970-01-01T00:00:00.000Z",
  });
}

function isMissingProviderResource(error: unknown) {
  return (
    extractGmailErrorInfo(error).status === 404 ||
    extractOutlookErrorInfo(error).status === 404
  );
}

function isRejectedProviderRequest(error: unknown) {
  return (
    extractGmailErrorInfo(error).status === 400 ||
    extractOutlookErrorInfo(error).status === 400
  );
}

function throttled(retryAfterMs: number) {
  return {
    status: "paused" as const,
    retryAfterMs: Math.max(1000, Math.ceil(retryAfterMs)),
    reason: "throttled" as const,
  };
}

function gmailPageCost(pageSize: number) {
  return gmailMailSyncCosts.list + pageSize * gmailMailSyncCosts.message;
}

// Without Redis there is no shared budget to draw from, so scans fall back to
// the provider's own throttling instead of stalling forever.
function withGmailSyncBudget<T>(
  input: {
    emailAccountId: string;
    priority: "backfill" | "current";
    cost: number;
  },
  operation: () => Promise<T>,
) {
  if (!isEmailProviderRateLimitRedisConfigured()) return operation();
  // A page reaches Gmail one admission at a time (the list, each batch and
  // their retries). When the gate turns one away, what it had already let
  // through stays spent and the rest of the reservation is returned.
  const page = createGmailQuotaStats();
  return runWithGmailQuota(
    { priority: currentGmailQuotaContext().priority, stats: page },
    () =>
      withLocalMailSyncBudget(
        {
          ...input,
          provider: "google",
          unspentCost: (error) =>
            isGmailCallDeferredError(error)
              ? input.cost - page.admittedCost
              : 0,
        },
        operation,
      ),
  );
}

async function batchedMessages(provider: EmailProvider, keys: MessageKey[]) {
  const fetched = await provider.getMessagesBatch(
    keys.map((key) => key.messageId),
  );
  const byId = new Map(fetched.map((message) => [message.id, message]));
  const messages: ParsedMessage[] = [];
  const unresolved: HydrationUnresolved[] = [];
  for (const key of keys) {
    const message = byId.get(key.messageId);
    // The batch path drops parts that failed for good, such as deleted mail.
    if (message) messages.push(message);
    else unresolved.push({ key, reason: "not_found" });
  }
  return { messages, unresolved };
}

type HydrationUnresolved = { key: MessageKey; reason: "not_found" };

function compileMailboxSearch(
  predicate: MailPredicate,
): { search: ProviderMailboxSearch; filter: MailPredicate } | null {
  const compiled: ProviderMailboxSearch = { mailbox: "all" };
  const children: MailPredicate[] = [];
  function flatten(part: MailPredicate) {
    if (part.kind === "all") part.predicates.forEach(flatten);
    else children.push(part);
  }
  flatten(predicate);
  let scoped = false;
  for (const child of children) {
    switch (child.kind) {
      case "text":
        if (compiled.text || child.field === "body") return null;
        compiled.text = child;
        break;
      case "mailbox":
      case "role": {
        const mailbox =
          child.kind === "mailbox"
            ? child.mailbox
            : child.role === "draft"
              ? "drafts"
              : child.role;
        if (mailbox === "snoozed" || scoped) return null;
        compiled.mailbox = mailbox;
        scoped = true;
        break;
      }
      case "read":
        if (compiled.read !== undefined && compiled.read !== child.value)
          return null;
        compiled.read = child.value;
        break;
      case "starred":
        if (compiled.starred !== undefined && compiled.starred !== child.value)
          return null;
        compiled.starred = child.value;
        break;
      case "has_attachment":
        if (
          compiled.hasAttachment !== undefined &&
          compiled.hasAttachment !== child.value
        )
          return null;
        compiled.hasAttachment = child.value;
        break;
      case "not":
        // Providers can't search by message id, so it only filters results.
        if (child.predicate.kind === "message") break;
        if (child.predicate.kind !== "role") return null;
        compiled.excludedRoles ??= [];
        compiled.excludedRoles.push(child.predicate.role);
        break;
      default:
        return null;
    }
  }
  const filters = children.filter((child) => child.kind !== "text");
  if (compiled.mailbox !== "spam" && compiled.mailbox !== "trash")
    filters.push({ kind: "mailbox", mailbox: "all" });
  return { search: compiled, filter: { kind: "all", predicates: filters } };
}

async function* streamToIterable(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function searchMessageFields(accountId: string, message: ParsedMessage) {
  return {
    ...parsedMessageMetadata(message),
    accountId,
    messageId: message.id,
    conversationId: message.threadId,
    pendingOperationIds: [],
    bodyText:
      message.textPlain ||
      (message.textHtml
        ? convertEmailHtmlToText({ htmlText: message.textHtml })
        : message.textPlain),
  };
}
