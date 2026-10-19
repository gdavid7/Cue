import uniqBy from "lodash/uniqBy";
import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { cleanupInvalidTokens } from "@/utils/auth/cleanup-invalid-tokens";
import { GmailLabel } from "@/utils/gmail/label";
import { captureException, isInvalidGrantError } from "@/utils/error";
import { isEmailProviderRateLimitError } from "@/utils/email/is-provider-rate-limit-error";
import {
  HistoryEventType,
  type ProcessHistoryOptions,
} from "@/utils/webhook/google/types";
import {
  MESSAGE_HELD_ELSEWHERE,
  processHistoryItem,
} from "@/utils/webhook/google/process-history-item";
import { getHistory } from "@/utils/gmail/history";
import { getMessages } from "@/utils/gmail/message";
import {
  validateWebhookAccount,
  getWebhookEmailAccount,
  type ValidatedWebhookAccountData,
} from "@/utils/webhook/validate-webhook-account";
import {
  getEmailProviderRateLimitState,
  withRateLimitRecording,
} from "@/utils/email/rate-limit";
import prisma from "@/utils/prisma";
import {
  clearEmptyGmailHistoryRuns,
  clearGmailHistoryCatchUp,
  countEmptyGmailHistoryRun,
  getGmailHistoryCatchUp,
  markGmailHistoryCatchUp,
} from "@/utils/redis/gmail-history-catch-up";
import type { Logger } from "@/utils/logger";
import type { gmail_v1 } from "@googleapis/gmail";
import { isGmailCallDeferredError } from "@/utils/gmail/quota";
import { scheduleGmailHistoryCatchUp } from "@/utils/webhook/google/history-catch-up";
import {
  countMessageProcessingFailure,
  deferMessageProcessing,
  isMessageLockUnavailableError,
} from "@/utils/redis/message-processing";
import { hashAddressForKey } from "@/utils/redis/address-key";
import { recordMessageProcessingFailure } from "@/utils/webhook/message-processing-failure";
import {
  isGmailRunStopError,
  isMessageRetryPending,
  isRetryableGmailMessageFailure,
} from "@/utils/webhook/google/message-failure";
import { AUTOMATED_RUN_AI_DEADLINE_MS } from "@/utils/llms/automated-call-bound";
import { mapWithConcurrency } from "@/utils/async";
import {
  acquireGmailHistoryLease,
  releaseGmailHistoryLease,
} from "@/utils/redis/gmail-history-lease";

const GMAIL_HISTORY_PAGE_SIZE = 500;
// History after a silent period is mail the user is still waiting on, so it is
// never skipped. A run reads and processes what fits in its share of the
// route's 300s and leaves the rest to a scheduled catch-up from its cursor.
const MAX_GMAIL_HISTORY_PAGES_PER_RUN = 20;
// Pages without records cost 2 quota units and no processing, so a run reads
// on through them to the records after.
const MAX_EMPTY_GMAIL_HISTORY_PAGES_PER_RUN = 100;
const MAX_EMPTY_HISTORY_RUNS = 5;
const HISTORY_RUN_BUDGET_MS = 180_000;
// Each new message is seconds of AI work. A few at a time clears a backlog
// several times faster while the account's Gmail quota gate paces the calls.
const NEW_MESSAGE_CONCURRENCY = 3;
const PROGRESS_SAVE_INTERVAL_MS = 10_000;
// One search page of the newest inbox and sent mail from an expired history
// gap.
const MAX_EXPIRED_GAP_MESSAGES = 50;
// A recovery cut short resumes on the next push or catch-up, well within a
// day; the triage it already did must not count as the gap's start then.
const EXPIRED_GAP_TRIAGE_SETTLE_MS = 24 * 60 * 60 * 1000;
// Mail delivered shortly before its triage was recorded still falls in the
// gap's search.
const EXPIRED_GAP_START_MARGIN_MS = 60 * 60 * 1000;
// As far back as messages keep their processed marker, so older mail that was
// triaged before is never handled twice.
const MAX_EXPIRED_GAP_AGE_MS = 8 * 24 * 60 * 60 * 1000;
// A message that keeps failing for reasons that should pass, such as an AI
// outage, is retried for at least this long and this many runs, then given up
// on, so it can't hold the account's history back for good.
const MIN_MESSAGE_RETRY_MS = 6 * 60 * 60 * 1000;
const MIN_MESSAGE_FAILURES = 3;
// Each further failure waits longer for its catch-up, up to the last delay.
const MESSAGE_RETRY_DELAYS_MS = [90_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
// When Redis can't count a message's failures, this many in a row on one
// instance give up on it rather than defer it forever.
const MAX_UNCOUNTED_MESSAGE_FAILURES = 3;
const MAX_TRACKED_UNCOUNTED_MESSAGES = 1000;
// During an outage every message fails, so a run gives up after a few rather
// than spend AI calls on each.
const MAX_RETRYABLE_FAILURES_PER_RUN = 3;
const uncountedMessageFailures = new Map<string, number>();

export async function processHistoryForUser(
  decodedData: {
    emailAddress: string;
    historyId: number | string;
  },
  options: {
    startHistoryId?: string;
    preloadedEmailAccount?: ValidatedWebhookAccountData | null;
    /** Delivered by the scheduled history catch-up, not by a push. */
    fromCatchUp?: boolean;
  },
  logger: Logger,
) {
  const startedAt = Date.now();
  const deadline = startedAt + HISTORY_RUN_BUDGET_MS;
  // How far this run read Gmail history, for a catch-up to aim past.
  let readThrough = BigInt(0);
  const { emailAddress } = decodedData;
  const historyId = normalizeHistoryId(decodedData.historyId);
  // All emails in the database are stored in lowercase
  // But it's possible that the email address in the webhook is not
  // So we need to convert it to lowercase
  const email = emailAddress.toLowerCase();

  const emailAccount =
    options.preloadedEmailAccount !== undefined
      ? options.preloadedEmailAccount
      : await getWebhookEmailAccount({ email }, logger);

  // biome-ignore lint/style/noParameterAssign: allowed for logging
  logger = logger.with({ email, emailAccountId: emailAccount?.id });

  const validation = await validateWebhookAccount(emailAccount, logger);

  if (!validation.success) {
    return validation.response;
  }

  const {
    emailAccount: validatedEmailAccount,
    hasAutomationRules,
    hasAiAccess: userHasAiAccess,
  } = validation.data;

  // biome-ignore lint/style/noParameterAssign: allowed for logging
  logger = logger.with({ userId: validatedEmailAccount.userId });

  Sentry.setTag("emailAccountId", validatedEmailAccount.id);
  Sentry.setUser({
    id: validatedEmailAccount.userId,
    email: validatedEmailAccount.email,
  });

  if (
    !validatedEmailAccount.account?.access_token ||
    !validatedEmailAccount.account?.refresh_token
  ) {
    logger.error("Missing tokens after validation");
    return NextResponse.json({ error: true });
  }

  const accountAccessToken = validatedEmailAccount.account.access_token;
  const accountRefreshToken = validatedEmailAccount.account.refresh_token;
  const accountProvider = validatedEmailAccount.account.provider || "google";

  try {
    let activeRateLimit: Awaited<
      ReturnType<typeof getEmailProviderRateLimitState>
    > = null;
    try {
      activeRateLimit = await getEmailProviderRateLimitState({
        emailAccountId: validatedEmailAccount.id,
        logger,
      });
    } catch (error) {
      logger.warn("Failed to read provider rate-limit state for webhook", {
        error: error instanceof Error ? error.message : error,
      });
    }

    if (activeRateLimit?.provider === "google") {
      await markGmailHistoryCatchUp(validatedEmailAccount.id, logger);
      await scheduleGmailHistoryCatchUp({
        emailAccountId: validatedEmailAccount.id,
        historyId,
        retryAt: activeRateLimit.retryAt,
        logger,
      });
      logger.warn(
        "Skipping webhook processing due to active Gmail rate limit",
        {
          retryAt: activeRateLimit.retryAt.toISOString(),
          rateLimitSource: activeRateLimit.source,
        },
      );
      return NextResponse.json({ ok: true });
    }

    const lease = await acquireGmailHistoryLease(
      validatedEmailAccount.id,
      logger,
    );
    if (!lease.acquired) {
      // That run may stop before this push's history, so it isn't lost.
      logger.info("Another run holds the account's history; catching up");
      await markGmailHistoryCatchUp(validatedEmailAccount.id, logger);
      await scheduleGmailHistoryCatchUp({
        emailAccountId: validatedEmailAccount.id,
        historyId,
        logger,
      });
      return NextResponse.json({ ok: true });
    }

    try {
      return await processWithRateLimitRecording();
    } finally {
      await releaseGmailHistoryLease(validatedEmailAccount.id, lease, logger);
    }
  } catch (error) {
    return await handleHistoryError(error);
  }

  function processWithRateLimitRecording() {
    return withRateLimitRecording(
      {
        emailAccountId: validatedEmailAccount.id,
        provider: "google",
        logger,
        source: "google/webhook",
        onRateLimitRecorded: async (state, error) => {
          // A deferral by the account's own quota gate is not Gmail limiting
          // the account, so it only marks the skipped history for catch-up.
          if (
            state ||
            isEmailProviderRateLimitError({ error, provider: "google" }) ||
            isGmailCallDeferredError(error)
          ) {
            await markGmailHistoryCatchUp(validatedEmailAccount.id, logger);
          }
        },
      },
      async () => {
        const catchUpToken = await getGmailHistoryCatchUp(
          validatedEmailAccount.id,
          logger,
        );

        if (
          !validatedEmailAccount.lastSyncedHistoryId &&
          !options.startHistoryId
        ) {
          return await startWithoutCursor(catchUpToken);
        }

        const gmail = await getGmailClientWithRefresh({
          accessToken: accountAccessToken,
          refreshToken: accountRefreshToken,
          expiresAt:
            validatedEmailAccount.account.expires_at?.getTime() || null,
          emailAccountId: validatedEmailAccount.id,
          logger,
        });

        const historyResult = await fetchGmailHistoryResilient({
          gmail,
          emailAccount: validatedEmailAccount,
          webhookHistoryId: historyId,
          options,
          deadline,
          logger,
        });

        if (historyResult.status === "expired") {
          // Mail that arrived while the cursor was too old for Gmail's history
          // is found by search instead: the newest 50 messages of the gap, and
          // an error is logged when there are more, which are not triaged.
          // The cursor stays expired until those are triaged, so the next run
          // searches again and skips what this one processed. A search that
          // fails for any other reason than rate limiting or a revoked grant
          // moves the cursor to the push, so it is never stuck.
          const gapHistory = await listExpiredGapMail(gmail);
          if (gapHistory.length > 0) {
            const processed = await processEntries(gapHistory, gmail);
            if (!processed.complete) {
              await markGmailHistoryCatchUp(validatedEmailAccount.id, logger);
              await scheduleGmailHistoryCatchUp({
                emailAccountId: validatedEmailAccount.id,
                historyId,
                retryAt: toDate(processed.retryAt),
                logger,
              });
              return NextResponse.json({ ok: true });
            }
          }
          await updateLastSyncedHistoryId({
            emailAccountId: validatedEmailAccount.id,
            lastSyncedHistoryId: historyId,
          });
          if (catchUpToken) {
            await clearGmailHistoryCatchUp({
              emailAccountId: validatedEmailAccount.id,
              token: catchUpToken,
              logger,
            });
          }
          return NextResponse.json({ ok: true });
        }

        const historyEntries = historyResult.history;
        let complete = !historyResult.hasMore;
        // Only mail waiting on its retry is left, so nothing is due before it.
        let retryAt: number | undefined;
        const lastReadId = historyEntries.at(-1)?.id;
        if (lastReadId)
          readThrough =
            BigInt(lastReadId) + BigInt(historyResult.hasMore ? 1 : 0);

        if (historyEntries.length > 0) {
          // Empty runs only count in a row.
          await clearEmptyGmailHistoryRuns(validatedEmailAccount.id, logger);
          logger.info("Processing history", {
            startHistoryId: historyResult.startHistoryId,
            historyIdGap: historyResult.historyIdGap,
            pageCount: historyResult.pageCount,
            historyItemCount: historyResult.historyItemCount,
            hasMoreHistory: historyResult.hasMore,
          });

          const processed = await processEntries(historyEntries, gmail);
          if (complete) retryAt = processed.retryAt;
          complete &&= processed.complete;
        } else if (complete) {
          logger.info("No history", {
            startHistoryId: historyResult.startHistoryId,
            historyIdGap: historyResult.historyIdGap,
            pageCount: historyResult.pageCount,
          });

          // important to save this or we can get into a loop with never receiving history
          await updateLastSyncedHistoryId({
            emailAccountId: validatedEmailAccount.id,
            lastSyncedHistoryId: historyId,
          });
        } else if (!historyResult.outOfTime) {
          // Every page this run could read held no records, and Gmail offers
          // more. The cursor stays: Gmail's current history id could skip
          // records on pages not read yet, so a catch-up reads on. Only after
          // several such runs in a row does it move past them. A run that ran
          // out of time before its page limit doesn't count.
          const emptyRuns = await countEmptyGmailHistoryRun(
            validatedEmailAccount.id,
            logger,
          );
          if (
            emptyRuns >= MAX_EMPTY_HISTORY_RUNS &&
            historyResult.lastPageHistoryId
          ) {
            logger.error("Gmail history held no records; moving past it", {
              startHistoryId: historyResult.startHistoryId,
              pageCount: historyResult.pageCount,
              emptyRuns,
              lastPageHistoryId: historyResult.lastPageHistoryId,
            });
            await updateLastSyncedHistoryId({
              emailAccountId: validatedEmailAccount.id,
              lastSyncedHistoryId: historyResult.lastPageHistoryId,
            });
            await clearEmptyGmailHistoryRuns(validatedEmailAccount.id, logger);
            complete = true;
          }
        }

        if (!complete) {
          // The cursor stops before the first history left unprocessed, so the
          // catch-up (or, without a scheduler, the next push) resumes there.
          logger.warn("Gmail history backlog continues in a catch-up", {
            startHistoryId: historyResult.startHistoryId,
            historyIdGap: historyResult.historyIdGap,
            pageCount: historyResult.pageCount,
            historyItemCount: historyResult.historyItemCount,
            hasMoreHistory: historyResult.hasMore,
          });
          await markGmailHistoryCatchUp(validatedEmailAccount.id, logger);
          await scheduleGmailHistoryCatchUp({
            emailAccountId: validatedEmailAccount.id,
            historyId: catchUpHistoryId(),
            retryAt: toDate(retryAt),
            logger,
          });
        } else if (catchUpToken) {
          await clearGmailHistoryCatchUp({
            emailAccountId: validatedEmailAccount.id,
            token: catchUpToken,
            logger,
          });
        }

        return NextResponse.json({ ok: true });
      },
    );
  }

  function processEntries(
    history: gmail_v1.Schema$History[],
    gmail: gmail_v1.Gmail,
  ) {
    return processHistory(
      {
        deadline,
        aiDeadlineAt: startedAt + AUTOMATED_RUN_AI_DEADLINE_MS,
        history,
        spamLearnedThreadIds: new Set<string>(),
        gmail,
        accessToken: accountAccessToken,
        hasAutomationRules,
        hasAiAccess: userHasAiAccess,
        rules: validatedEmailAccount.rules,
        emailAccount: {
          ...validatedEmailAccount,
          account: {
            provider: accountProvider,
          },
        },
      },
      logger,
    );
  }

  // The gap starts no later than the account's last triage. Without one there
  // is nothing to measure from, and older mail is left alone.
  async function listExpiredGapMail(
    gmail: gmail_v1.Gmail,
  ): Promise<gmail_v1.Schema$History[]> {
    if (!hasAutomationRules && !userHasAiAccess) return [];

    try {
      return await searchExpiredGapMail(gmail);
    } catch (error) {
      if (
        isEmailProviderRateLimitError({ error, provider: "google" }) ||
        isGmailCallDeferredError(error) ||
        isInvalidGrantError(error)
      )
        throw error;
      logger.error(
        "Failed to search an expired Gmail history gap; mail in it is not triaged",
        { error },
      );
      return [];
    }
  }

  async function searchExpiredGapMail(
    gmail: gmail_v1.Gmail,
  ): Promise<gmail_v1.Schema$History[]> {
    const now = Date.now();
    const lastTriaged = await prisma.executedRule.findFirst({
      where: {
        emailAccountId: validatedEmailAccount.id,
        createdAt: { lt: new Date(now - EXPIRED_GAP_TRIAGE_SETTLE_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (!lastTriaged) return [];

    const gapStart = new Date(
      Math.max(
        lastTriaged.createdAt.getTime() - EXPIRED_GAP_START_MARGIN_MS,
        now - MAX_EXPIRED_GAP_AGE_MS,
      ),
    );
    const { messages, nextPageToken } = await getMessages(gmail, {
      query: `after:${Math.floor(gapStart.getTime() / 1000)} {in:inbox in:sent}`,
      maxResults: MAX_EXPIRED_GAP_MESSAGES,
    });
    const gap = {
      gapStart: gapStart.toISOString(),
      messageCount: messages.length,
    };
    if (nextPageToken) {
      logger.error(
        "Expired Gmail history gap holds more mail than is triaged",
        gap,
      );
    } else {
      logger.info("Triaging mail from an expired Gmail history gap", gap);
    }

    // Gmail lists newest first; history runs oldest first, which keeps each
    // thread in order. These have no history id, so the cursor never moves to
    // one. The label only admits them as history; whether a message is
    // outbound is decided from the message itself when it is processed.
    return messages.reverse().map((message) => ({
      messagesAdded: [
        { message: { ...message, labelIds: [GmailLabel.INBOX] } },
      ],
    }));
  }

  // A mailbox's cursor starts at the history id its watch began at. Without
  // one, history from 0 is always expired, and jumping to this push would
  // skip the mail that sent it. A push therefore leaves the cursor alone and
  // schedules a catch-up about 90s later, which reads from the watch's
  // history id if it was saved by then (a watch still in flight, or a
  // deferred one resumed before the mail). Only that catch-up delivery, or a
  // push when no catch-up can run, starts from the push's history id: later
  // mail is then processed, but mail before it is not.
  async function startWithoutCursor(catchUpToken: string | null) {
    if (!options.fromCatchUp) {
      const marked = await markGmailHistoryCatchUp(
        validatedEmailAccount.id,
        logger,
      );
      const scheduled = await scheduleGmailHistoryCatchUp({
        emailAccountId: validatedEmailAccount.id,
        historyId,
        logger,
      });
      if (marked && scheduled) {
        logger.info("No Gmail history cursor yet; catching up shortly");
        return NextResponse.json({ ok: true });
      }
    }

    logger.warn(
      "No Gmail history cursor; starting from this push, earlier mail is not processed by automation",
    );
    await updateLastSyncedHistoryId({
      emailAccountId: validatedEmailAccount.id,
      lastSyncedHistoryId: historyId,
    });
    if (catchUpToken) {
      await clearGmailHistoryCatchUp({
        emailAccountId: validatedEmailAccount.id,
        token: catchUpToken,
        logger,
      });
    }
    return NextResponse.json({ ok: true });
  }

  // The catch-up skips history the cursor already covers, so it asks for
  // everything this run read (and past it, when pages were left), which can
  // be newer than this push.
  function catchUpHistoryId() {
    return maxBigInt(BigInt(historyId), readThrough).toString();
  }

  async function handleHistoryError(error: unknown) {
    if (isInvalidGrantError(error)) {
      logger.warn("Invalid grant", { email });
      await cleanupInvalidTokens({
        emailAccountId: validatedEmailAccount.id,
        reason: "invalid_grant",
        // Client creation can rotate the access token while retaining this grant.
        failedRefreshToken: accountRefreshToken,
        logger,
      }).catch((cleanupError) =>
        logger.error("Failed to clean up webhook authentication failure", {
          cleanupError,
        }),
      );
      return NextResponse.json({ ok: true });
    }

    if (isMessageLockUnavailableError(error)) {
      logger.warn("Webhook history deferred: message locks unavailable", {
        error,
      });
      return await deferToCatchUp();
    }

    // Logged with its cause where the message failed.
    if (error instanceof MessageRetryDeferredError) {
      logger.info("Webhook history deferred to retry failed messages", {
        retryInSeconds: Math.round((error.retryAt - Date.now()) / 1000),
      });
      return await deferToCatchUp(new Date(error.retryAt));
    }

    if (
      isGmailCallDeferredError(error) ||
      isEmailProviderRateLimitError({ error, provider: "google" })
    ) {
      logger.info("Webhook history deferred by Gmail rate limiting");
      await scheduleGmailHistoryCatchUp({
        emailAccountId: validatedEmailAccount.id,
        historyId: catchUpHistoryId(),
        logger,
      });
      return NextResponse.json({ ok: true });
    }

    captureException(error, { userEmail: email, extra: { decodedData } });
    logger.error("Error processing webhook", {
      error:
        error instanceof Error
          ? {
              message: error.message,
              stack: error.stack,
              name: error.name,
            }
          : error,
    });
    // returning 200 here, as otherwise PubSub will call the webhook over and over
    return NextResponse.json({ error: true });
  }

  async function deferToCatchUp(retryAt?: Date) {
    await markGmailHistoryCatchUp(validatedEmailAccount.id, logger);
    await scheduleGmailHistoryCatchUp({
      emailAccountId: validatedEmailAccount.id,
      historyId: catchUpHistoryId(),
      retryAt,
      logger,
    });
    return NextResponse.json({ ok: true });
  }
}

async function processHistory(
  options: ProcessHistoryOptions & { deadline: number },
  logger: Logger,
): Promise<{ complete: boolean; retryAt?: number }> {
  const { history, emailAccount, deadline } = options;
  const { email: userEmail, id: emailAccountId } = emailAccount;

  const entries = history.map((h) => ({
    id: h.id,
    ...getHistoryEvents(h, logger),
  }));
  const threadEvents = new Set(entries.flatMap((entry) => entry.threadEvents));
  const done = new Set<HistoryEvent>();
  let stopError: unknown;
  // The earliest a message that failed is due to be retried, and whether the
  // run left anything else that is due sooner.
  let retryAt: number | undefined;
  let leftOtherWork = false;
  let retryableFailures = 0;
  const waitForRetry = (at: number) => {
    retryAt = Math.min(retryAt ?? at, at);
  };

  // A message that fails, or waits on its retry, holds only its own thread
  // back: other threads go on, and the cursor stays before it.
  const run = async (event: HistoryEvent) => {
    if (stopError !== undefined) return;
    if (Date.now() >= deadline) {
      leftOtherWork = true;
      return;
    }
    const log = logger.with({
      messageId: event.item.message?.id,
      threadId: event.item.message?.threadId,
    });
    try {
      const outcome = await processHistoryItem(event, options, log);
      if (outcome === MESSAGE_HELD_ELSEWHERE) {
        leftOtherWork = true;
        return;
      }
      if (isMessageRetryPending(outcome)) {
        waitForRetry(outcome.retryPendingUntil);
        return;
      }
    } catch (error) {
      // Stop before the cursor passes mail Gmail refused (or the quota gate
      // held back), so the catch-up picks it up again.
      // A revoked grant fails every message after it too, and the run's
      // error handling disconnects the account.
      if (isGmailRunStopError(error)) {
        stopError ??= error;
        return;
      }
      // A failure that should pass, such as an AI outage, is retried later,
      // until the message has been retried long enough.
      const retryable = isRetryableGmailMessageFailure(error);
      const retry = retryable ? await planRetry(event, log) : undefined;
      if (retry) {
        log.warn("Message failed; retrying it later", {
          error,
          failures: retry.failures,
          retryInSeconds: Math.round((retry.retryAt - Date.now()) / 1000),
        });
        waitForRetry(retry.retryAt);
        retryableFailures += 1;
        if (retryableFailures >= MAX_RETRYABLE_FAILURES_PER_RUN)
          stopError ??= new MessageRetryDeferredError(
            error,
            retryAt ?? retry.retryAt,
          );
        return;
      }
      captureException(error, {
        userEmail,
        extra: { messageId: event.item.message?.id },
      });
      log.error("Error processing history item", { error, retryable });
      await recordFailure(event, log);
    }
    done.add(event);
    await saveProgress();
  };

  // Undefined once the message has been retried long enough. Otherwise the
  // message waits for its retry, which every run before then sees from its
  // claim alone, without processing it, and a catch-up is due for.
  async function planRetry(
    event: HistoryEvent,
    log: Logger,
  ): Promise<{ failures?: number; retryAt: number } | undefined> {
    const messageId = event.item.message?.id;
    if (!messageId) return;
    // In memory, so keyed by a hash rather than the address (RD-3).
    const key = `${hashAddressForKey(userEmail)}:${messageId}`;
    let counted: Awaited<ReturnType<typeof countMessageProcessingFailure>>;
    try {
      counted = await countMessageProcessingFailure({ userEmail, messageId });
    } catch (error) {
      log.warn("Failed to count message failure", { error });
      const uncounted = (uncountedMessageFailures.get(key) ?? 0) + 1;
      if (uncountedMessageFailures.size >= MAX_TRACKED_UNCOUNTED_MESSAGES)
        uncountedMessageFailures.clear();
      if (uncounted >= MAX_UNCOUNTED_MESSAGE_FAILURES) {
        uncountedMessageFailures.delete(key);
        return;
      }
      uncountedMessageFailures.set(key, uncounted);
      return { retryAt: Date.now() + MESSAGE_RETRY_DELAYS_MS[0] };
    }
    uncountedMessageFailures.delete(key);

    const { failures, firstFailedAt } = counted;
    if (
      failures >= MIN_MESSAGE_FAILURES &&
      Date.now() - firstFailedAt >= MIN_MESSAGE_RETRY_MS
    )
      return;
    const delayIndex = Math.min(failures, MESSAGE_RETRY_DELAYS_MS.length) - 1;
    const retryAt = Date.now() + MESSAGE_RETRY_DELAYS_MS[delayIndex];
    // Label changes aren't claimed; they wait for the next run instead.
    if (threadEvents.has(event)) {
      await deferMessageProcessing({ userEmail, messageId, retryAt }).catch(
        (error) => log.warn("Failed to defer message retry", { error }),
      );
    }
    return { failures, retryAt };
  }

  // Only incoming mail would have had rules run on it.
  async function recordFailure(event: HistoryEvent, log: Logger) {
    const { id: messageId, threadId, labelIds } = event.item.message ?? {};
    if (
      event.type !== HistoryEventType.MESSAGE_ADDED ||
      !labelIds?.includes(GmailLabel.INBOX) ||
      !options.hasAutomationRules ||
      !options.hasAiAccess ||
      !messageId ||
      !threadId
    )
      return;
    await recordMessageProcessingFailure({
      emailAccountId,
      messageId,
      threadId,
      logger: log,
    });
  }

  // A run can be cut off by the function timeout, so the cursor follows the
  // processed history as it goes, not only at the end.
  let savedCount = 0;
  let savedAt = Date.now();
  const processedCount = () => {
    const firstUnprocessed = entries.findIndex(
      (entry) =>
        !entry.threadEvents.every((event) => done.has(event)) ||
        !entry.labelEvents.every((event) => done.has(event)),
    );
    return firstUnprocessed === -1 ? entries.length : firstUnprocessed;
  };
  const saveProgress = async ({ final = false } = {}) => {
    const count = processedCount();
    if (count <= savedCount) return;
    if (!final && Date.now() - savedAt < PROGRESS_SAVE_INTERVAL_MS) return;
    savedCount = count;
    savedAt = Date.now();
    await updateLastSyncedHistoryId({
      emailAccountId,
      lastSyncedHistoryId: entries[count - 1]?.id,
    });
  };

  // Threads with the newest mail first, so a backlog surfaces the mail the
  // user is waiting on first. Within a thread, oldest first and one at a
  // time: an older sent reply handled after a newer inbound one would resolve
  // that one's Needs reply. Replies sent from elsewhere (SENT being added)
  // run here too, in their place.
  const threads = new Map<string, HistoryEvent[]>();
  for (const event of entries.flatMap((entry) => entry.threadEvents)) {
    const threadId = event.item.message?.threadId ?? "";
    // Re-inserting moves the thread to the end, so the map ends up ordered by
    // each thread's newest message.
    const thread = threads.get(threadId) ?? [];
    threads.delete(threadId);
    threads.set(threadId, [...thread, event]);
  }
  // Other label changes run one at a time in history order, each as soon as
  // the thread events up to its history are processed, alongside the threads
  // still going. They have no processed marker: a run cut off before saving
  // its cursor leaves them to be applied again by the next run.
  let labelsFrom = 0;
  let labelsBlocked = false;
  let labelError: unknown;
  let labelDrain = Promise.resolve();
  const applyReadyLabels = async () => {
    while (!labelsBlocked && labelsFrom < entries.length) {
      const entry = entries[labelsFrom];
      if (!entry.threadEvents.every((event) => done.has(event))) return;
      for (const event of entry.labelEvents) {
        await run(event);
        if (!done.has(event)) {
          labelsBlocked = true;
          return;
        }
      }
      labelsFrom += 1;
    }
  };
  // One chain, so label changes never overlap or reorder.
  const drainLabels = () => {
    labelDrain = labelDrain.then(applyReadyLabels).catch((error) => {
      labelsBlocked = true;
      labelError ??= error;
    });
  };

  try {
    drainLabels();
    await mapWithConcurrency(
      [...threads.values()].reverse(),
      NEW_MESSAGE_CONCURRENCY,
      async (thread) => {
        for (const event of thread) {
          await run(event);
          if (!done.has(event)) return;
          drainLabels();
        }
      },
    );
    drainLabels();
    await labelDrain;
  } finally {
    // The label chain must not outlive the run or its lease, even when a
    // thread fails and others are still finishing.
    labelsBlocked = true;
    await labelDrain;
  }
  if (labelError !== undefined) throw labelError;

  await saveProgress({ final: true });

  if (stopError !== undefined) throw stopError;
  return {
    complete: processedCount() === entries.length,
    retryAt: leftOtherWork ? undefined : retryAt,
  };
}

type HistoryEvent = Parameters<typeof processHistoryItem>[0];

/** A message failed for a reason that should pass; a catch-up retries it. */
class MessageRetryDeferredError extends Error {
  readonly retryAt: number;

  constructor(cause: unknown, retryAt: number) {
    super("Messages failed and are retried in a catch-up", { cause });
    this.name = "MessageRetryDeferredError";
    this.retryAt = retryAt;
  }
}

function toDate(epochMs: number | undefined) {
  return epochMs === undefined ? undefined : new Date(epochMs);
}

function getHistoryEvents(h: gmail_v1.Schema$History, logger: Logger) {
  const newMessages: HistoryEvent[] = uniqBy(
    (h.messagesAdded || []).filter((m) => {
      const isRelevant = isInboxOrSentMessage(m);
      if (!isRelevant) {
        logger.info("Skipping message not in inbox or sent", {
          messageId: m.message?.id,
          labelIds: m.message?.labelIds,
        });
      }
      return isRelevant;
    }),
    (m) => m.message?.id,
  ).map((item) => ({ type: HistoryEventType.MESSAGE_ADDED, item }));

  // SENT being added is a reply sent from elsewhere, handled as outbound mail,
  // so it keeps its place among the thread's messages.
  const isSentLabelAdd = (item: gmail_v1.Schema$HistoryLabelAdded) =>
    item.labelIds?.includes(GmailLabel.SENT) ?? false;
  const sentReplies: HistoryEvent[] = uniqBy(
    (h.labelsAdded || []).filter(isSentLabelAdd),
    (item) => item.message?.id,
  ).map((item) => ({ type: HistoryEventType.LABEL_ADDED, item }));

  const labelEvents: HistoryEvent[] = uniqBy(
    [
      ...(h.labelsAdded || [])
        .filter((item) => !isSentLabelAdd(item))
        .map((item) => ({
          type: HistoryEventType.LABEL_ADDED,
          item,
        })),
      ...(h.labelsRemoved || []).map((item) => ({
        type: HistoryEventType.LABEL_REMOVED,
        item,
      })),
    ],
    (e) => `${e.type}:${e.item.message?.id}`,
  );

  return { threadEvents: [...newMessages, ...sentReplies], labelEvents };
}

/**
 * Updates lastSyncedHistoryId using a monotonic/conditional update to prevent
 * race conditions where concurrent webhook processors might regress the pointer.
 * Only updates if the new value is greater than the current value.
 */
async function updateLastSyncedHistoryId({
  emailAccountId,
  lastSyncedHistoryId,
}: {
  emailAccountId: string;
  lastSyncedHistoryId?: string | null;
}) {
  if (!lastSyncedHistoryId) return;

  // Use conditional update: only set if new value > current value (or current is null)
  // This prevents race conditions where slower webhook processors with older
  // history IDs could overwrite progress from faster processors with newer IDs
  await prisma.$executeRaw`
    UPDATE "EmailAccount"
    SET "lastSyncedHistoryId" = ${lastSyncedHistoryId}, "updatedAt" = NOW()
    WHERE id = ${emailAccountId}
    AND (
      "lastSyncedHistoryId" IS NULL
      OR CAST("lastSyncedHistoryId" AS NUMERIC) < CAST(${lastSyncedHistoryId} AS NUMERIC)
    )
  `;
}

const isInboxOrSentMessage = (message: {
  message?: { labelIds?: string[] | null };
}) => {
  const labels = message.message?.labelIds;

  if (!labels) return false;

  if (labels.includes(GmailLabel.INBOX) && !labels.includes(GmailLabel.DRAFT))
    return true;

  if (labels.includes(GmailLabel.SENT)) return true;

  return false;
};

function isHistoryIdExpiredError(error: unknown): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: existing loose external shape
  const err = error as any;
  const statusCode =
    err.response?.data?.error?.code ??
    err.response?.status ??
    err.status ??
    err.code;

  return statusCode === 404;
}

/**
 * Reads Gmail history from the account's cursor, never skipping any, up to a
 * bounded number of pages per run; `hasMore` says a catch-up must continue.
 * Reports an expired history id (a 404) as `expired`.
 */
async function fetchGmailHistoryResilient({
  gmail,
  emailAccount,
  webhookHistoryId,
  options,
  deadline,
  logger,
}: {
  gmail: gmail_v1.Gmail;
  emailAccount: ValidatedWebhookAccountData;
  webhookHistoryId: string;
  options: { startHistoryId?: string };
  deadline: number;
  logger: Logger;
}): Promise<
  | {
      status: "success";
      startHistoryId: string;
      history: gmail_v1.Schema$History[];
      historyIdGap: number;
      pageCount: number;
      historyItemCount: number;
      hasMore: boolean;
      /** The mailbox's history id as of the last page read. */
      lastPageHistoryId: string | null;
      /** Reading stopped at the run's deadline rather than a page limit. */
      outOfTime: boolean;
    }
  | { status: "expired" }
> {
  const lastSyncedHistoryId = normalizeHistoryId(
    emailAccount?.lastSyncedHistoryId || "0",
  );
  const startHistoryId = options?.startHistoryId
    ? normalizeHistoryId(options.startHistoryId)
    : lastSyncedHistoryId;
  const historyIdGap = boundedHistoryCount(
    maxBigInt(BigInt(0), BigInt(webhookHistoryId) - BigInt(startHistoryId)),
  );

  logger.info("Listing history", {
    startHistoryId,
    lastSyncedHistoryId: emailAccount?.lastSyncedHistoryId,
    webhookHistoryId,
    historyIdGap,
  });

  try {
    const historyEntries: gmail_v1.Schema$History[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;
    let lastPageHistoryId: string | null = null;
    let outOfTime = false;

    do {
      const data = await getHistory(
        gmail,
        {
          startHistoryId,
          historyTypes: ["messageAdded", "labelAdded", "labelRemoved"],
          maxResults: GMAIL_HISTORY_PAGE_SIZE,
          pageToken,
        },
        logger,
      );

      const pageHistory = data.history ?? [];
      historyEntries.push(...pageHistory);
      pageCount += 1;
      pageToken = data.nextPageToken || undefined;
      if (data.historyId && /^\d+$/.test(data.historyId))
        lastPageHistoryId = data.historyId;

      logger.info("Fetched Gmail history page", {
        startHistoryId,
        pageCount,
        pageHistoryItemCount: pageHistory.length,
        accumulatedHistoryItemCount: historyEntries.length,
        hasNextPage: !!pageToken,
      });
      // Reading leaves the rest of the run's time to processing and saving.
      outOfTime = Date.now() >= deadline;
    } while (
      pageToken &&
      !outOfTime &&
      pageCount <
        (historyEntries.length
          ? MAX_GMAIL_HISTORY_PAGES_PER_RUN
          : MAX_EMPTY_GMAIL_HISTORY_PAGES_PER_RUN)
    );

    return {
      status: "success",
      history: historyEntries,
      startHistoryId,
      historyIdGap,
      pageCount,
      historyItemCount: historyEntries.length,
      hasMore: !!pageToken,
      lastPageHistoryId,
      outOfTime,
    };
  } catch (error) {
    // Gmail history IDs are typically valid for ~1 week. If older, Gmail returns a 404.
    if (isHistoryIdExpiredError(error)) {
      logger.warn(
        "Gmail history expired; triaging the gap's inbox mail by search",
        {
          expiredHistoryId: startHistoryId,
          newHistoryId: webhookHistoryId,
          historyIdGap,
        },
      );
      return { status: "expired" };
    }
    throw error;
  }
}

function normalizeHistoryId(historyId: number | string) {
  const normalized =
    typeof historyId === "number" ? historyId.toString() : historyId.trim();
  if (!/^\d+$/.test(normalized)) throw new Error("Invalid historyId");
  return normalized;
}

function maxBigInt(a: bigint, b: bigint) {
  return a > b ? a : b;
}

function boundedHistoryCount(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(value);
}
