import { selectOtherAccounts } from "@/utils/ai/assistant/chat-other-accounts";
import { mapWithConcurrency } from "@/utils/async";
import { createEmailProvider } from "@/utils/email/provider";
import type { Logger } from "@/utils/logger";

// The snapshot only frames the first reply, so it never holds the turn up.
const INBOX_STATS_BUDGET_MS = 2000;
// Each account draws on its own provider budget; a few are asked at once.
const INBOX_STATS_CONCURRENCY = 3;

/**
 * The inbox totals across the accounts the chat covers: the chat's own and
 * the user's other covered accounts. An account that does not answer within
 * the budget is left out of the sum; null when none answers.
 */
export async function getInboxStatsForChatContext({
  userId,
  emailAccountId,
  provider,
  logger,
}: {
  userId: string;
  emailAccountId: string;
  provider: string;
  logger: Logger;
}) {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(null);
    }, INBOX_STATS_BUDGET_MS);
  });

  try {
    const others = selectOtherAccounts({ userId, emailAccountId }).then(
      (selection) => selection.accounts,
      (error) => {
        logger.warn("Could not list the user's accounts for inbox stats", {
          error,
        });
        return [];
      },
    );
    const accounts = [
      { id: emailAccountId, provider },
      ...((await Promise.race([others, deadline])) ?? []),
    ];

    const answered: Array<{ total: number; unread: number }> = [];
    await Promise.race([
      mapWithConcurrency(accounts, INBOX_STATS_CONCURRENCY, async (account) => {
        if (expired) return;
        const stats = await getAccountInboxStats({ ...account, logger });
        if (stats && !expired) answered.push(stats);
      }),
      deadline,
    ]);
    if (!answered.length) return null;
    return answered.reduce(
      (sum, item) => ({
        total: sum.total + item.total,
        unread: sum.unread + item.unread,
      }),
      { total: 0, unread: 0 },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function getAccountInboxStats({
  id,
  provider,
  logger,
}: {
  id: string;
  provider: string;
  logger: Logger;
}) {
  try {
    const emailProvider = await createEmailProvider({
      emailAccountId: id,
      provider,
      logger,
    });
    return await emailProvider.getInboxStats();
  } catch (error) {
    logger.warn("Failed to fetch inbox stats for chat context", {
      statsEmailAccountId: id,
      error,
    });
    return null;
  }
}
