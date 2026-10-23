import { messageMatchesPredicate } from "@inboxzero/mail-core/query-semantics";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import {
  MAX_ENUMERATION_RETRY_AFTER_MS,
  type MailboxSource,
  type ScopeDescriptor,
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
import { randomUUID } from "node:crypto";
import { getAuditContext } from "@/utils/audit/context";
import { noteEnumerationPage, noteRequestPause } from "@/utils/request-metrics";
import {
  OLD_ENGINE_RETRY_AFTER_MS,
  type OldEngineReason,
} from "@/utils/mail-api/engine-revision";
import {
  getFastRequestSampleRate,
  isFastRequestSampled,
} from "@/utils/request-sampling";
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
  gmailBurstUnitsFor,
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
export const GMAIL_RECENT_WINDOW_MS = 3 * DAY_MS;
const GMAIL_HISTORY_SCOPE_ID = "history";
// A first sync's backfill lists the whole inbox, starred mail and drafts
// (lists with no older-mail fallback) but only the last 30 days of
// everything else: walking all of a mailbox's history spent nearly all of the
// Gmail quota on a first connect. Its coverage records the window, so search
// leaves older mail to Gmail and opening a conversation reads it whole. A
// resync after expired history still walks everything, since mail it skipped
// may have changed meanwhile, and so does a client that can't record the
// window.
const GMAIL_FIRST_BACKFILL_WINDOW_MS = 30 * DAY_MS;
// The two scans start at different times, so the backfill reaches into the
// recent window to leave no gap at the boundary between them.
const GMAIL_HISTORY_OVERLAP_MS = DAY_MS;
// A conversation read whole, in the sync envelope's units.
const GMAIL_THREAD_COST = 120;
// The first page of a scan is what the inbox shows first. It reads whole
// messages, so it creates no hydration that would hold the engine's command
// loop, and a first screen of them comes back on its own so the inbox fills
// sooner; later pages read what `gmailScanPageSize` allows.
const GMAIL_FIRST_PAGE_SIZE = 12;
// A first sync's backfill lists the inbox before the rest of its window, so
// older inbox rows arrive before archived mail of the same weeks. Its first
// couple of hundred inbox messages read at sync, once the primary scan is
// done, and the long tail stays background. Both still draw on the
// backfill's share of the account's sync envelope, 5,000 units a minute, so
// this moves units earlier rather than adding any: 200 messages are about
// 12,000 units, about 2.4 minutes at that share (less from a full bucket).
const GMAIL_FIRST_INBOX_SYNC_MESSAGES = 200;

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
  /** A first sync's backfill: inbox, starred and drafts, and other mail from this time on. */
  windowStartMs?: number;
  /**
   * Which part of a windowed backfill this page lists: the inbox, then the
   * window's other mail. A backfill begun without one lists both in one query.
   */
  phase?: "inbox" | "rest";
  /**
   * A phased backfill's Gmail cursor, valid only for its phase's query. It
   * never goes in `pageToken`: a server from before phases reads only that,
   * so it restarts its one combined query from the window start rather than
   * resume it with a cursor minted for another query, which could skip mail.
   */
  phasePageToken?: string;
  /** Inbox messages the backfill has listed at sync priority so far. */
  synced?: number;
};

export function createEmailProviderMailboxSource(input: {
  provider: EmailProvider;
  accountId: string;
  logger: Logger;
  /** Set when the requesting engine is older than the server's minimum. */
  oldEngine?: OldEngineReason | null;
}): MailboxSource & Required<Pick<MailboxSource, "readChangesBatch">> {
  const { provider, accountId, logger, oldEngine } = input;
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
    async beginBootstrap({
      afterMs,
      initial,
      scope,
      session,
      windowedBackfill,
    }) {
      try {
        const isHistory = isGmail && scope.id === GMAIL_HISTORY_SCOPE_ID;
        const token: BootstrapToken = {
          afterMs: afterMs ?? 0,
          ...(initial && isGmail && !isHistory && { initial: true }),
          ...(initial &&
            isHistory &&
            windowedBackfill && {
              windowStartMs: Date.now() - GMAIL_FIRST_BACKFILL_WINDOW_MS,
              phase: "inbox" as const,
            }),
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
        const pageToken = token.phase ? token.phasePageToken : token.pageToken;
        const isPrimaryGmailScan = isGmail && !isBackfill;
        if (isPrimaryGmailScan) await setGmailInitialSync(accountId, true);
        // The backfill only fills in older mail, so it yields to everything
        // else. The primary scan fills the inbox the user is waiting on, its
        // first page after a sign-in included: that page is sync too, so it
        // never takes the in-flight slots or the share of the second kept
        // for what a person opens meanwhile. It goes first all the same, as
        // the first sync's first call, with background held off until the
        // scan ends and a full bucket that covers it above sync's floor.
        // A first sync's older inbox is sync too, behind the primary scan.
        const inboxFirst =
          isBackfill &&
          token.phase === "inbox" &&
          (token.synced ?? 0) < GMAIL_FIRST_INBOX_SYNC_MESSAGES;
        const priority: GmailQuotaPriority =
          isBackfill && !inboxFirst ? "background" : "sync";
        noteEnumerationPage({
          scope:
            token.scopeId === GMAIL_HISTORY_SCOPE_ID ? "history" : "primary",
          phase: token.phase ?? "none",
          gatePriority: priority,
          promoted: inboxFirst,
        });
        // An old engine ignores the 200 page's pacing hint but waits out a
        // throttled refusal, so its backfill gets one long refusal per page
        // before it spends any quota. The inbox it is waiting on is sync.
        if (oldEngine && priority === "background") {
          noteRequestPause({
            source: "old_engine",
            reason: oldEngine,
            retryAfterMs: OLD_ENGINE_RETRY_AFTER_MS,
          });
          return throttled(OLD_ENGINE_RETRY_AFTER_MS);
        }
        const maxResults = Math.min(
          pageSize,
          maxPageSize,
          isGmail && !pageToken ? GMAIL_FIRST_PAGE_SIZE : maxPageSize,
          isGmail ? gmailScanPageSize(priority) : maxPageSize,
        );
        const listPage = () =>
          provider.getMessagesWithPagination({
            ...(token.windowStartMs != null && {
              query: backfillWindowQuery(token.windowStartMs, token.phase),
            }),
            maxResults,
            folderId: token.folderId ?? undefined,
            pageToken,
            includeDrafts: true,
            ...(token.receivedAfterMs != null && {
              after: new Date(token.receivedAfterMs),
            }),
            ...(token.receivedBeforeMs != null && {
              before: new Date(token.receivedBeforeMs),
            }),
          });
        // Pages after the first are all one size, so the next one costs this.
        const nextPageSize = Math.min(
          pageSize,
          maxPageSize,
          isGmail ? gmailScanPageSize(priority) : maxPageSize,
        );
        let nextPageAtMs: number | null = null;
        const syncPage = isGmail
          ? await runWithGmailQuota(
              { priority, afterInitialSync: inboxFirst },
              () =>
                withGmailSyncBudget(
                  {
                    emailAccountId: accountId,
                    priority: isBackfill ? "backfill" : "current",
                    cost: gmailPageCost(maxResults),
                    nextCost: gmailPageCost(nextPageSize),
                  },
                  ({ nextAdmitAfterMs }) => {
                    if (nextAdmitAfterMs !== null)
                      nextPageAtMs = Date.now() + nextAdmitAfterMs;
                    return listPage();
                  },
                ),
            )
          : await listPage();
        if (isPrimaryGmailScan && !syncPage.nextPageToken)
          await setGmailInitialSync(accountId, false);
        const changes = syncPage.messages.map((message) =>
          parsedMessagePatch(accountId, provider.name, message),
        );
        const { requiredHydration, bodies } = parsedMessageBodies(
          accountId,
          syncPage.messages,
        );
        const synced = inboxFirst
          ? (token.synced ?? 0) + syncPage.messages.length
          : token.synced;
        // The rest phase is another query, so it starts without a cursor.
        let next: {
          pageToken?: string;
          phase: BootstrapToken["phase"];
        } | null = null;
        if (syncPage.nextPageToken)
          next = { pageToken: syncPage.nextPageToken, phase: token.phase };
        else if (token.phase === "inbox") next = { phase: "rest" };
        if (next) {
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
                ...(next.phase
                  ? { phasePageToken: next.pageToken }
                  : { pageToken: next.pageToken }),
                receivedAfterMs: token.receivedAfterMs,
                receivedBeforeMs: token.receivedBeforeMs,
                scopeId: token.scopeId ?? "primary",
                windowStartMs: token.windowStartMs,
                phase: next.phase,
                synced,
              } satisfies BootstrapToken),
              catchUpFrom: null,
              ...waitForNextPage(nextPageAtMs),
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
            ...(token.windowStartMs != null && {
              windowStartMs: token.windowStartMs,
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
      async function searchProvider(
        options: Pick<
          Parameters<EmailProvider["searchMessages"]>[0],
          "query" | "mailboxSearch"
        >,
      ) {
        const debited = debitForegroundUsage(
          gmailPageCost(Math.min(pageSize, maxPageSize)),
        );
        try {
          return await provider.searchMessages({
            ...options,
            maxResults: Math.min(pageSize, maxPageSize),
            pageToken: page ?? undefined,
          });
        } catch (error) {
          // A rejected query fails the same way every time, so the client
          // must drop it rather than retry it.
          if (isRejectedProviderRequest(error))
            return { status: "unsupported" as const };
          return mapProviderError(error);
        } finally {
          await debited;
        }
      }

      // Gmail understands its own syntax, so a typed search reaches it as
      // typed, and what it matches is the answer: operators the store can't
      // evaluate, and mail older than what it holds, come from here.
      if (isGmail && predicate.kind === "search") {
        // Someone is waiting on it, so it goes through the gate as
        // interactive and waits out an interactive pause like the rest.
        const query = predicate.query;
        const result = await runWithGmailQuota(
          { priority: "interactive" },
          () => searchProvider({ query }),
        );
        if ("status" in result) return result;
        return {
          status: "ok",
          value: {
            matches: result.messages.map((message) => ({
              accountId,
              messageId: message.id,
            })),
            changes: result.messages.map((message) =>
              parsedMessagePatch(accountId, provider.name, message),
            ),
            bodies: parsedMessageBodies(accountId, result.messages).bodies,
            nextPage: result.nextPageToken ?? null,
            semantics: "exact" as const,
          },
        };
      }

      const compiled = compileMailboxSearch(predicate);
      if (!compiled) return { status: "unsupported" };
      const result = await searchProvider({
        query: "",
        mailboxSearch: compiled.search,
      });
      if ("status" in result) return result;
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

  // The request's own line always carries the reason. Local-budget pauses are
  // the common ones and get one unsampled line per mailbox per minute; the
  // rest log a sample, and sampleRate lets counts be re-weighted.
  function logPaused(fields: {
    source: string;
    reason: string;
    retryAfterMs: number;
    [key: string]: unknown;
  }) {
    noteRequestPause(fields);
    if (fields.source === "local_budget") {
      if (shouldLogLocalBudgetPause(accountId))
        logger.info("Mail sync paused", fields);
      return;
    }
    const { requestId, source: scope } = getAuditContext();
    const sampleRate = getFastRequestSampleRate(scope);
    if (isFastRequestSampled(requestId ?? randomUUID(), sampleRate))
      logger.info("Mail sync paused", { ...fields, sampled: true, sampleRate });
    else logger.trace("Mail sync paused", fields);
  }

  async function mapProviderError(
    error: unknown,
    { recordRateLimit = true }: { recordRateLimit?: boolean } = {},
  ) {
    if (error instanceof LocalMailSyncPausedError) {
      logPaused({
        source: "local_budget",
        reason: error.reason,
        retryAfterMs: error.retryAfterMs,
      });
      return throttled(error.retryAfterMs);
    }
    // The quota gate logs only a sample of its deferrals, so the request's own
    // line carries the reason for every one.
    const deferred = getGmailCallDeferredError(error);
    if (deferred) {
      noteRequestPause({
        source: "quota_gate",
        reason: deferred.reason,
        retryAfterMs: deferred.retryAfterMs,
      });
      return throttled(deferred.retryAfterMs);
    }
    if (isProviderRateLimitModeError(error)) {
      const retryAtMs = error.retryAt ? Date.parse(error.retryAt) : Number.NaN;
      const retryAfterMs = Number.isNaN(retryAtMs)
        ? 15_000
        : retryAtMs - Date.now();
      logPaused({
        source: "provider_rate_limit_mode",
        reason: "rate_limit_mode",
        retryAfterMs: Math.max(1000, Math.ceil(retryAfterMs)),
      });
      return throttled(retryAfterMs);
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
    if (rateLimitDelayMs !== null) {
      const providerStatus =
        extractGmailErrorInfo(error).status ??
        extractOutlookErrorInfo(error).status;
      logPaused({
        source: "provider_rate_limit",
        reason: "provider_throttled",
        retryAfterMs: Math.max(1000, Math.ceil(rateLimitDelayMs)),
        providerStatus,
      });
      return throttled(rateLimitDelayMs);
    }
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
    logPaused({
      source: "provider_error",
      reason: "unavailable",
      retryAfterMs: 1000,
      errorName: error instanceof Error ? error.name : typeof error,
      providerStatus:
        extractGmailErrorInfo(error).status ??
        extractOutlookErrorInfo(error).status,
    });
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

// Gmail lists newest first, so the inbox phase brings older inbox rows in the
// order the inbox shows them. The two phases are disjoint and together cover
// exactly what the one combined query does.
function backfillWindowQuery(
  windowStartMs: number,
  phase: BootstrapToken["phase"],
) {
  const after = Math.floor(windowStartMs / 1000) - 1;
  if (phase === "inbox") return "in:inbox";
  if (phase === "rest")
    return `{is:starred in:drafts after:${after}} -in:inbox`;
  return `{in:inbox is:starred in:drafts after:${after}}`;
}

function gmailPageCost(pageSize: number) {
  return gmailMailSyncCosts.list + pageSize * gmailMailSyncCosts.message;
}

// A scan page larger than what its priority may take from a full quota bucket
// holds its request in the gate while the bucket refills: a 50-message
// backfill page slept about 12 seconds of every request. Pages that fit
// answer in a few seconds and fill the mailbox just as fast, since the
// budget, not the page, sets how much mail a minute brings.
function gmailScanPageSize(priority: GmailQuotaPriority) {
  return Math.max(
    1,
    Math.floor(
      (gmailBurstUnitsFor(priority) - gmailMailSyncCosts.list) /
        gmailMailSyncCosts.message,
    ),
  );
}

// Without Redis there is no shared budget to draw from, so scans fall back to
// the provider's own throttling instead of stalling forever.
function withGmailSyncBudget<T>(
  input: {
    emailAccountId: string;
    priority: "backfill" | "current";
    cost: number;
    nextCost?: number;
  },
  operation: (admission: { nextAdmitAfterMs: number | null }) => Promise<T>,
) {
  if (!isEmailProviderRateLimitRedisConfigured())
    return operation({ nextAdmitAfterMs: null });
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
              ? Math.max(0, input.cost - page.admittedCost)
              : 0,
        },
        (_signal, admission) => operation(admission),
      ),
  );
}

// The page's own provider time already counts against the budget's wait.
// A wait past the protocol's bound is cut to it; the 503 covers the rest.
function waitForNextPage(nextPageAtMs: number | null) {
  if (nextPageAtMs === null) return {};
  const retryAfterMs = Math.min(
    MAX_ENUMERATION_RETRY_AFTER_MS,
    Math.ceil(nextPageAtMs - Date.now()),
  );
  return retryAfterMs > 0 ? { retryAfterMs } : {};
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

// A typed search reaches the provider as what it can search for of the
// store's part of the query, every condition it can't is checked here
// instead; nothing else it can't search for may be left out.
function compileMailboxSearch(
  predicate: MailPredicate,
): { search: ProviderMailboxSearch; filter: MailPredicate } | null {
  const typed = predicate.kind === "search";
  const compiled: ProviderMailboxSearch = { mailbox: "all" };
  const children: MailPredicate[] = [];
  function flatten(part: MailPredicate) {
    if (part.kind === "all") part.predicates.forEach(flatten);
    else if (part.kind === "search") flatten(part.local);
    else children.push(part);
  }
  flatten(predicate);
  const unsearched: MailPredicate[] = [];
  let scoped = false;
  for (const child of children) {
    if (typed && !addToMailboxSearch(compiled, child, scoped)) {
      unsearched.push(child);
      continue;
    }
    if (typed) {
      if (child.kind === "mailbox" || child.kind === "role") scoped = true;
      continue;
    }
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
        // Providers can't search by message or conversation id, so these
        // only filter results.
        if (
          child.predicate.kind === "message" ||
          child.predicate.kind === "conversation"
        )
          break;
        if (child.predicate.kind !== "role") return null;
        compiled.excludedRoles ??= [];
        compiled.excludedRoles.push(child.predicate.role);
        break;
      default:
        return null;
    }
  }
  // Without words or a sender to look for, the search would list the
  // whole mailbox.
  if (typed && !compiled.text && !compiled.addresses?.length) return null;
  const filters = children.filter(
    (child) => child.kind !== "text" || unsearched.includes(child),
  );
  if (compiled.mailbox !== "spam" && compiled.mailbox !== "trash")
    filters.push({ kind: "mailbox", mailbox: "all" });
  return { search: compiled, filter: { kind: "all", predicates: filters } };
}

// Adds one condition of a typed search to what the provider searches for,
// or says it can't.
function addToMailboxSearch(
  compiled: ProviderMailboxSearch,
  child: MailPredicate,
  scoped: boolean,
): boolean {
  switch (child.kind) {
    case "text":
      if (compiled.text) return false;
      compiled.text = child;
      return true;
    case "address":
      compiled.addresses ??= [];
      compiled.addresses.push({ field: child.field, value: child.value });
      return true;
    case "any": {
      // Gmail-style to:, which also matches Cc and Bcc: the provider is
      // asked for To, and Cc and Bcc matches come from the store.
      const [first] = child.predicates;
      if (
        first?.kind !== "address" ||
        first.field !== "to" ||
        !child.predicates.every(
          (part) => part.kind === "address" && part.value === first.value,
        )
      )
        return false;
      compiled.addresses ??= [];
      compiled.addresses.push({ field: "to", value: first.value });
      return true;
    }
    case "mailbox":
    case "role": {
      const mailbox =
        child.kind === "mailbox"
          ? child.mailbox
          : child.role === "draft"
            ? "drafts"
            : child.role;
      if (mailbox === "snoozed" || scoped) return false;
      compiled.mailbox = mailbox;
      return true;
    }
    case "read":
      if (compiled.read !== undefined) return false;
      compiled.read = child.value;
      return true;
    case "starred":
      if (compiled.starred !== undefined) return false;
      compiled.starred = child.value;
      return true;
    case "has_attachment":
      if (compiled.hasAttachment !== undefined) return false;
      compiled.hasAttachment = child.value;
      return true;
    default:
      return false;
  }
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

const LOCAL_BUDGET_PAUSE_LOG_INTERVAL_MS = 60_000;
const MAX_TRACKED_PAUSE_MAILBOXES = 1000;
const lastLocalBudgetPauseLogAt = new Map<string, number>();

export function shouldLogLocalBudgetPause(accountId: string, now = Date.now()) {
  const last = lastLocalBudgetPauseLogAt.get(accountId);
  if (last !== undefined && now - last < LOCAL_BUDGET_PAUSE_LOG_INTERVAL_MS)
    return false;
  lastLocalBudgetPauseLogAt.delete(accountId);
  lastLocalBudgetPauseLogAt.set(accountId, now);
  if (lastLocalBudgetPauseLogAt.size > MAX_TRACKED_PAUSE_MAILBOXES) {
    const oldest = lastLocalBudgetPauseLogAt.keys().next().value;
    if (oldest !== undefined) lastLocalBudgetPauseLogAt.delete(oldest);
  }
  return true;
}
