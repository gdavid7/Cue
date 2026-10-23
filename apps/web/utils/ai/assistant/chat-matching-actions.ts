import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "@/env";
import {
  type MatchingBulkAction,
  MATCHING_BULK_ACTIONS,
} from "@/utils/actions/mail-bulk-matching.validation";
import {
  countWithProvider,
  toChatMatchingScope,
} from "@/utils/ai/assistant/chat-count-tools";
import type { EmailProvider } from "@/utils/email/types";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import {
  filterForAction,
  getMailBulkJobTargetCap,
} from "@/utils/mail-bulk/run-matching-job";
import { startMatchingBulkJob } from "@/utils/mail-bulk/start-matching-job";
import { redis } from "@/utils/redis";

// The preview counts what the job would change, at one provider listing call
// per 500 messages; past this it says "at least".
const PREVIEW_MAX_MESSAGES = 10_000;
// Long enough to read the card and press Confirm, short enough that a stale
// count isn't acted on.
const CONFIRM_TTL_SECONDS = 15 * 60;

export const MATCHING_CONFIRM_EXPIRED =
  "This confirmation has expired or was already used. Ask the assistant again.";

const FOLDER_OR_CATEGORY_SEARCH =
  "Folder and category searches can't be acted on over every match; use threadIds from searchInbox.";
const READ_STATE_SEARCH =
  "This search's read state can't be applied to every match; leave it out of the query or use threadIds from searchInbox.";

// Founder rule R-1: the token holds ids, an enum and a keyed hash of the
// search; the search itself stays in the chat's Postgres history.
const storedConfirmationSchema = z.object({
  chatId: z.string().min(1),
  toolCallId: z.string().min(1),
  action: z.enum(MATCHING_BULK_ACTIONS),
  labelId: z.string().optional(),
  queryHash: z.string().min(1),
});

/**
 * Counts what a manageInbox action over every email a search matches would
 * change, in the chat's own account. Nothing changes here: on the web chat
 * the result carries a single-use token that only the user's Confirm button
 * can spend, so the model can never start the job, however it is asked.
 * Other surfaces get the count alone.
 */
export async function previewMatchingQueryAction({
  originalAction,
  query,
  bulkAction,
  labelId,
  emailProvider,
  emailAccountId,
  provider,
  confirmation,
  abortSignal,
}: {
  /** The action as the model named it, which the preview echoes. */
  originalAction: string;
  query: string;
  bulkAction: MatchingBulkAction;
  labelId?: string;
  emailProvider: EmailProvider;
  emailAccountId: string;
  provider: string;
  /** Set on the web chat, where the card can be confirmed. */
  confirmation?: { chatId: string; toolCallId: string };
  abortSignal?: AbortSignal;
}) {
  const matching = toChatMatchingScope({ query }, provider);
  if (!matching) return { error: FOLDER_OR_CATEGORY_SEARCH };
  const actionFilter = filterForAction(bulkAction);
  // The job lists by the action's own filter; a read state the search names
  // (Outlook) has no place in the view it lists.
  if (
    matching.only.unread !== undefined &&
    matching.only.unread !== actionFilter.unread
  )
    return { error: READ_STATE_SEARCH };

  const counted = await countWithProvider({
    emailProvider,
    scope: matching.scope,
    only: { ...matching.only, ...actionFilter },
    maxMessages: PREVIEW_MAX_MESSAGES,
    abortSignal,
  });
  if (counted.total === 0) {
    return {
      status: "nothing_to_change" as const,
      action: originalAction,
      query,
      conversations: 0,
    };
  }

  const preview = {
    status: "needs_confirmation" as const,
    action: originalAction,
    query,
    conversations: counted.conversations,
    messages: counted.total,
    ...(counted.capped ? { atLeast: true } : {}),
  };
  if (!confirmation) {
    return {
      ...preview,
      nextStep:
        "Nothing has changed. Tell the user how many conversations this would change. A change over every match can only be started from the Cue web app.",
    };
  }

  const confirmToken = randomUUID();
  await redis.set(
    confirmationKey(emailAccountId, confirmToken),
    JSON.stringify({
      chatId: confirmation.chatId,
      toolCallId: confirmation.toolCallId,
      action: bulkAction,
      ...(labelId ? { labelId } : {}),
      queryHash: hashQuery(emailAccountId, query),
    } satisfies z.infer<typeof storedConfirmationSchema>),
    { ex: CONFIRM_TTL_SECONDS },
  );
  return {
    ...preview,
    confirmToken,
    nextStep:
      "Nothing has changed. Tell the user how many conversations this would change and that it starts only when they press Confirm on this result. Calling manageInbox again does not start it.",
  };
}

/**
 * Spends a preview's token and starts the inbox's select-all job for it. The
 * token is taken from Redis in one step, so a double press or a second call
 * finds nothing and starts nothing. It must name the same chat, tool call
 * and search the preview counted.
 */
export async function confirmMatchingQueryAction({
  emailAccountId,
  provider,
  chatId,
  toolCallId,
  confirmToken,
  query,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  chatId: string;
  toolCallId: string;
  confirmToken: string;
  query: string;
  logger: Logger;
}) {
  const key = confirmationKey(emailAccountId, confirmToken);
  const { stored, ttlMs } = await takeConfirmation(key, { chatId, toolCallId });
  if (!stored || stored.queryHash !== hashQuery(emailAccountId, query))
    throw new SafeError(MATCHING_CONFIRM_EXPIRED);

  const matching = toChatMatchingScope({ query }, provider);
  if (!matching) throw new SafeError(FOLDER_OR_CATEGORY_SEARCH);
  const { action, labelId } = stored;
  let jobId: string;
  try {
    jobId = await startMatchingBulkJob({
      emailAccountId,
      scope: matching.scope,
      action,
      labelId,
      logger,
    });
  } catch (error) {
    // Nothing started, so the card can be confirmed again while it lasts.
    if (ttlMs > 0)
      await redis
        .set(key, JSON.stringify(stored), { px: ttlMs })
        .catch(() => undefined);
    throw error;
  }
  return {
    jobId,
    action,
    messageCap: getMailBulkJobTargetCap(action, provider),
  };
}

/**
 * Spends a preview's token without starting anything. Like Confirm, it takes
 * the token in one step, so when Confirm and Cancel race (two tabs) exactly
 * one of them wins and the other is told the token is gone.
 */
export async function cancelMatchingQueryAction({
  emailAccountId,
  chatId,
  toolCallId,
  confirmToken,
}: {
  emailAccountId: string;
  chatId: string;
  toolCallId: string;
  confirmToken: string;
}) {
  const { stored } = await takeConfirmation(
    confirmationKey(emailAccountId, confirmToken),
    { chatId, toolCallId },
  );
  if (!stored) throw new SafeError(MATCHING_CONFIRM_EXPIRED);
}

/**
 * Takes a token in one step (GETDEL) and keeps it only if it belongs to this
 * card. Also reads how long it had left, so a failed start can put it back.
 */
async function takeConfirmation(
  key: string,
  card: { chatId: string; toolCallId: string },
) {
  const [ttlMs, raw] = await Promise.all([redis.pttl(key), redis.getdel(key)]);
  const parsed = storedConfirmationSchema.safeParse(parseStored(raw));
  const stored =
    parsed.success &&
    parsed.data.chatId === card.chatId &&
    parsed.data.toolCallId === card.toolCallId
      ? parsed.data
      : null;
  return { stored, ttlMs: Number(ttlMs) };
}

function confirmationKey(emailAccountId: string, confirmToken: string) {
  return `assistant-matching-confirm:${emailAccountId}:${confirmToken}`;
}

// Keyed by a server secret, so a stored hash can't be checked against
// guessed searches. The key is derived for this use alone, not the secret.
function hashQuery(emailAccountId: string, query: string) {
  const key = createHmac("sha256", env.EMAIL_ENCRYPT_SECRET)
    .update("assistant-matching-confirm")
    .digest();
  return createHmac("sha256", key)
    .update(`${emailAccountId}\u0000${query.trim()}`)
    .digest("hex");
}

// The client returns JSON as a string, or already parsed.
function parseStored(stored: unknown): unknown {
  if (typeof stored !== "string") return stored;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}
