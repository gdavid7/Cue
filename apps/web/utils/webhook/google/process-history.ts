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

export async function processHistoryForUser(
  decodedData: {
    emailAddress: string;
    historyId: number | string;
  },
  options: {
    startHistoryId?: string;
    preloadedEmailAccount?: ValidatedWebhookAccountData | null;
  },
  logger: Logger,
) {
  const deadline = Date.now() + HISTORY_RUN_BUDGET_MS;
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
        const gmail = await getGmailClientWithRefresh({
          accessToken: accountAccessToken,
          refreshToken: accountRefreshToken,
          expiresAt:
            validatedEmailAccount.account.expires_at?.getTime() || null,
          emailAccountId: validatedEmailAccount.id,
          logger,
        });

        const catchUpToken = await getGmailHistoryCatchUp(
          validatedEmailAccount.id,
          logger,
        );

        const historyResult = await fetchGmailHistoryResilient({
          gmail,
          emailAccount: validatedEmailAccount,
          webhookHistoryId: historyId,
          options,
          logger,
        });

        if (historyResult.status === "expired") {
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

          const processed = await processHistory(
            {
              deadline,
              history: historyEntries,
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
        } else {
          // Every page this run could read held no records, and Gmail offers
          // more. The cursor stays: Gmail's current history id could skip
          // records on pages not read yet, so a catch-up reads on. Only after
          // several such runs in a row does it move past them.
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
}

async function processHistory(
  options: ProcessHistoryOptions & { deadline: number },
  logger: Logger,
): Promise<{ complete: boolean }> {
  const { history, emailAccount, deadline } = options;
  const { email: userEmail, id: emailAccountId } = emailAccount;

  const entries = history.map((h) => ({
    id: h.id,
    ...getHistoryEvents(h, logger),
  }));
  const done = new Set<HistoryEvent>();
  let stopError: unknown;

  const run = async (event: HistoryEvent) => {
    if (stopError !== undefined || Date.now() >= deadline) return;
    const log = logger.with({
      messageId: event.item.message?.id,
      threadId: event.item.message?.threadId,
    });
    try {
      const outcome = await processHistoryItem(event, options, log);
      if (outcome === MESSAGE_HELD_ELSEWHERE) return;
    } catch (error) {
      // Stop before the cursor passes mail Gmail refused (or the quota gate
      // held back), so the catch-up picks it up again.
      if (
        isEmailProviderRateLimitError({ error, provider: "google" }) ||
        isGmailCallDeferredError(error)
      ) {
        stopError ??= error;
        return;
      }
      captureException(error, {
        userEmail,
        extra: { messageId: event.item.message?.id },
      });
      log.error("Error processing history item", { error });
    }
    done.add(event);
    await saveProgress();
  };

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
  if (labelError !== undefined) throw labelError;

  await saveProgress({ final: true });

  if (stopError !== undefined) throw stopError;
  return { complete: processedCount() === entries.length };
}

type HistoryEvent = Parameters<typeof processHistoryItem>[0];

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
 * Handles expired history IDs (404s) by resetting the sync point.
 */
async function fetchGmailHistoryResilient({
  gmail,
  emailAccount,
  webhookHistoryId,
  options,
  logger,
}: {
  gmail: gmail_v1.Gmail;
  emailAccount: ValidatedWebhookAccountData;
  webhookHistoryId: string;
  options: { startHistoryId?: string };
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
    } while (
      pageToken &&
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
    };
  } catch (error) {
    // Gmail history IDs are typically valid for ~1 week. If older, Gmail returns a 404.
    // In this case, we reset the sync point to the current history ID.
    if (isHistoryIdExpiredError(error)) {
      logger.error(
        "Gmail history expired; mail in the gap is not processed by automation",
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
