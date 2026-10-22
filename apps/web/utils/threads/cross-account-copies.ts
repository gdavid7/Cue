import { normalizeInternetMessageId } from "@inboxzero/mail-core/messages";

/**
 * All inboxes shows a message delivered to several of the user's accounts
 * once: the newest-first list keeps the first copy, and each later copy from
 * another account is hidden behind it, in `copies`. Copies match only by the
 * Message-ID of each conversation's newest message, and two rows of one
 * account never merge, as they are separate conversations there.
 *
 * Copies that arrived at the same moment are listed in no meaningful order,
 * so `preferAccountId`'s copy (the account the user is in) stands for them.
 *
 * The local store keys each conversation once (mail-sqlite's
 * conversation_message_keys, read here as latestInternetMessageId) and its
 * counts pair copies by rank within each account as this does
 * (countConversationRows), so the two must change together.
 */
export function showCopiesOnce<T>(
  rows: T[],
  copyOf: (row: T) => {
    accountId: string;
    messageId: string | undefined;
    at: number;
  },
  preferAccountId?: string,
): { row: T; copies: T[] }[] {
  const shown: { row: T; copies: T[] }[] = [];
  const groupsByMessageId = new Map<
    string,
    {
      entry: (typeof shown)[number];
      accountId: string;
      at: number;
      accountIds: Set<string>;
    }[]
  >();
  for (const row of rows) {
    const { accountId, messageId, at } = copyOf(row);
    const entry = { row, copies: [] as T[] };
    const key = normalizeInternetMessageId(messageId);
    if (!key) {
      shown.push(entry);
      continue;
    }
    const groups = groupsByMessageId.get(key) ?? [];
    const group = groups.find(({ accountIds }) => !accountIds.has(accountId));
    if (!group) {
      shown.push(entry);
      groups.push({ entry, accountId, at, accountIds: new Set([accountId]) });
      groupsByMessageId.set(key, groups);
      continue;
    }
    group.accountIds.add(accountId);
    if (accountId === preferAccountId && at === group.at) {
      group.entry.copies.push(group.entry.row);
      group.entry.row = row;
      group.accountId = accountId;
    } else {
      group.entry.copies.push(row);
    }
  }
  return shown;
}
