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
import {
  ACCOUNT_SEARCH_FAILED,
  getOwnedEmailAccount,
} from "@/utils/ai/assistant/chat-other-accounts";
import {
  type AccountSearch,
  translateAccountSearch,
} from "@/utils/ai/assistant/cross-provider-search";

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

// Founder rule R-1: the token holds ids, an enum, a count and keyed hashes
// of each account's search; the search itself stays in the chat's Postgres
// history.
const storedAccountSchema = z.object({
  emailAccountId: z.string().min(1),
  labelId: z.string().optional(),
  queryHash: z.string().min(1),
});
const storedConfirmationSchema = z.object({
  chatId: z.string().min(1),
  toolCallId: z.string().min(1),
  action: z.enum(MATCHING_BULK_ACTIONS),
  // Only for the usage log at Confirm or Cancel.
  conversations: z.number().int().optional(),
  accounts: z.array(storedAccountSchema).min(1),
});
type StoredConfirmation = z.infer<typeof storedConfirmationSchema>;

type MatchingCount = { conversations: number; total: number; capped: boolean };

/** What one other account would change, or why it can't be acted on. */
export type OtherAccountMatchingPreview =
  | { account: { id: string; email: string }; error: string }
  | {
      account: { id: string; email: string };
      /** The search, in that account's provider's syntax. */
      search: AccountSearch;
      labelId?: string;
      count: MatchingCount;
    };

/**
 * Counts what a bulk action over every email a search matches would change
 * in one account, as the job will list it. An error when the search can't be
 * acted on over every match there.
 */
export async function countMatchingInAccount({
  search,
  provider,
  bulkAction,
  emailProvider,
  abortSignal,
}: {
  search: AccountSearch;
  provider: string;
  bulkAction: MatchingBulkAction;
  emailProvider: EmailProvider;
  abortSignal?: AbortSignal;
}): Promise<MatchingCount | { error: string }> {
  const matching = toChatMatchingScope(search, provider);
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
  return {
    conversations: counted.conversations,
    total: counted.total,
    capped: counted.capped,
  };
}

/**
 * Counts what a manageInbox action over every email a search matches would
 * change, in the chat's own account and, when given, the user's other
 * accounts. Nothing changes here: on the web chat the result carries a
 * single-use token that only the user's Confirm button can spend, so the
 * model can never start a job, however it is asked. Other surfaces get the
 * count alone.
 */
export async function previewMatchingQueryAction({
  originalAction,
  query,
  bulkAction,
  labelId,
  chatAccountError,
  emailProvider,
  emailAccountId,
  provider,
  otherAccounts,
  confirmation,
  abortSignal,
}: {
  /** The action as the model named it, which the preview echoes. */
  originalAction: string;
  query: string;
  bulkAction: MatchingBulkAction;
  labelId?: string;
  /** Why the chat's own account can't be acted on, when it can't. */
  chatAccountError?: string;
  /** The chat's own account, absent when chatAccountError says why. */
  emailProvider?: EmailProvider;
  emailAccountId: string;
  provider: string;
  /** The user's other covered accounts, already counted. */
  otherAccounts?: {
    chatEmail: string;
    previews: OtherAccountMatchingPreview[];
  };
  /** Set on the web chat, where the card can be confirmed. */
  confirmation?: { chatId: string; toolCallId: string };
  abortSignal?: AbortSignal;
}) {
  const chatCount: MatchingCount | { error: string } =
    chatAccountError || !emailProvider
      ? { error: chatAccountError ?? ACCOUNT_SEARCH_FAILED }
      : await countMatchingInAccount({
          search: { query },
          provider,
          bulkAction,
          emailProvider,
          abortSignal,
        });
  if (!otherAccounts && "error" in chatCount) return chatCount;

  const previews: OtherAccountMatchingPreview[] = [
    "error" in chatCount
      ? {
          account: {
            id: emailAccountId,
            email: otherAccounts?.chatEmail ?? "",
          },
          error: chatCount.error,
        }
      : {
          account: {
            id: emailAccountId,
            email: otherAccounts?.chatEmail ?? "",
          },
          search: { query },
          labelId,
          count: chatCount,
        },
    ...(otherAccounts?.previews ?? []),
  ];
  const counted = previews.flatMap((item) =>
    "count" in item && item.count.total > 0 ? [item] : [],
  );
  const accounts = otherAccounts
    ? previews.map((item) =>
        "error" in item
          ? { account: item.account.email, error: item.error }
          : {
              account: item.account.email,
              conversations: item.count.conversations,
              messages: item.count.total,
              ...(item.count.capped ? { atLeast: true } : {}),
            },
      )
    : undefined;
  const conversations = counted.reduce(
    (sum, item) => sum + item.count.conversations,
    0,
  );

  if (counted.length === 0) {
    // Every account failing is an error, as one account's failure was.
    const failure = previews.find((item) => "error" in item);
    if (failure && previews.every((item) => "error" in item))
      return { error: "error" in failure ? failure.error : "" };
    return {
      status: "nothing_to_change" as const,
      action: originalAction,
      query,
      conversations: 0,
      ...(accounts ? { accounts } : {}),
    };
  }

  const preview = {
    status: "needs_confirmation" as const,
    action: originalAction,
    query,
    conversations,
    messages: counted.reduce((sum, item) => sum + item.count.total, 0),
    ...(counted.some((item) => item.count.capped) ? { atLeast: true } : {}),
    ...(accounts ? { accounts } : {}),
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
      conversations,
      accounts: counted.map((item) => ({
        emailAccountId: item.account.id,
        ...(item.labelId ? { labelId: item.labelId } : {}),
        queryHash: hashSearch(item.account.id, item.search),
      })),
    } satisfies StoredConfirmation),
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
 * Spends a preview's token and starts the inbox's select-all job for it in
 * each account it counted, one after another. The token is taken from Redis
 * in one step, so a double press or a second call finds nothing and starts
 * nothing. It must name the same chat, tool call and search the preview
 * counted, and each other account must still be the user's.
 */
export async function confirmMatchingQueryAction({
  emailAccountId,
  provider,
  userId,
  chatId,
  toolCallId,
  confirmToken,
  query,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  userId: string;
  chatId: string;
  toolCallId: string;
  confirmToken: string;
  query: string;
  logger: Logger;
}) {
  const key = confirmationKey(emailAccountId, confirmToken);
  const { stored, raw, ttlMs } = await takeConfirmation(key, {
    chatId,
    toolCallId,
  });
  if (!stored) throw new SafeError(MATCHING_CONFIRM_EXPIRED);

  // Every account's search is checked before anything starts.
  const targets: Array<{
    emailAccountId: string;
    email?: string;
    provider: string;
    labelId?: string;
    scope: NonNullable<ReturnType<typeof toChatMatchingScope>>["scope"];
  }> = [];
  for (const item of stored.accounts) {
    const account =
      item.emailAccountId === emailAccountId
        ? { id: emailAccountId, email: undefined, provider }
        : await getOwnedEmailAccount({
            userId,
            emailAccountId: item.emailAccountId,
          });
    const accountSearch = account
      ? searchForAccount({ query, from: provider, to: account.provider })
      : null;
    if (
      !account ||
      !accountSearch ||
      item.queryHash !== hashSearch(item.emailAccountId, accountSearch)
    )
      throw new SafeError(MATCHING_CONFIRM_EXPIRED);
    const matching = toChatMatchingScope(accountSearch, account.provider);
    if (!matching) throw new SafeError(FOLDER_OR_CATEGORY_SEARCH);
    targets.push({
      emailAccountId: account.id,
      email: account.email,
      provider: account.provider,
      labelId: item.labelId,
      scope: matching.scope,
    });
  }

  const { action, conversations } = stored;
  const jobs: Array<{
    emailAccountId: string;
    jobId: string;
    messageCap: number;
  }> = [];
  const failed: Array<{ account?: string; error: unknown }> = [];
  for (const target of targets) {
    try {
      const jobId = await startMatchingBulkJob({
        emailAccountId: target.emailAccountId,
        scope: target.scope,
        action,
        labelId: target.labelId,
        logger,
      });
      jobs.push({
        emailAccountId: target.emailAccountId,
        jobId,
        messageCap: getMailBulkJobTargetCap(action, target.provider),
      });
    } catch (error) {
      logger.warn("Matching action did not start in an account", {
        jobEmailAccountId: target.emailAccountId,
        error,
      });
      failed.push({ account: target.email, error });
    }
  }

  if (jobs.length === 0) {
    // Nothing started, so the card can be confirmed again while it lasts.
    if (ttlMs > 0)
      await redis.set(key, raw, { px: ttlMs }).catch(() => undefined);
    throw failed[0]?.error ?? new SafeError(MATCHING_CONFIRM_EXPIRED);
  }
  logger.info("Matching action confirmed", {
    outcome: "confirmed",
    action,
    conversations,
    accountCount: targets.length,
    startedCount: jobs.length,
  });
  return {
    jobId: jobs[0].jobId,
    action,
    messageCap: jobs[0].messageCap,
    jobs,
    ...(failed.length
      ? {
          notStarted: failed.map((item) => ({
            account: item.account ?? null,
            error: "Failed to update emails",
          })),
        }
      : {}),
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
  logger,
}: {
  emailAccountId: string;
  chatId: string;
  toolCallId: string;
  confirmToken: string;
  logger: Logger;
}) {
  const { stored } = await takeConfirmation(
    confirmationKey(emailAccountId, confirmToken),
    { chatId, toolCallId },
  );
  if (!stored) throw new SafeError(MATCHING_CONFIRM_EXPIRED);
  logger.info("Matching action cancelled", {
    outcome: "cancelled",
    action: stored.action,
    conversations: stored.conversations,
  });
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
  const stored = parsed.success ? parsed.data : null;
  return {
    stored:
      stored &&
      stored.chatId === card.chatId &&
      stored.toolCallId === card.toolCallId
        ? stored
        : null,
    raw: typeof raw === "string" ? raw : JSON.stringify(raw),
    ttlMs: Number(ttlMs),
  };
}

/**
 * A chat search in another account's provider's syntax, when it carries over
 * exactly; null when only its keywords would, which would change mail the
 * search did not mean.
 */
export function searchForAccount({
  query,
  from,
  to,
}: {
  query: string;
  from: string;
  to: string;
}): AccountSearch | null {
  const translated = translateAccountSearch({ search: { query }, from, to });
  if (!translated || translated.keywordsOnly) return null;
  return translated.search;
}

function confirmationKey(emailAccountId: string, confirmToken: string) {
  return `assistant-matching-confirm:${emailAccountId}:${confirmToken}`;
}

// Keyed by a server secret, so a stored hash can't be checked against
// guessed searches. The key is derived for this use alone, not the secret.
function hashSearch(emailAccountId: string, search: AccountSearch) {
  const key = createHmac("sha256", env.EMAIL_ENCRYPT_SECRET)
    .update("assistant-matching-confirm")
    .digest();
  return createHmac("sha256", key)
    .update(
      [
        emailAccountId,
        search.query.trim(),
        search.fromEmail ?? "",
        search.readState ?? "",
      ].join("\u0000"),
    )
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
