import { normalizeInternetMessageId } from "@inboxzero/mail-core/messages";

/**
 * All inboxes shows a message delivered to several of the user's accounts
 * once: the newest-first list keeps the first copy, and each later copy from
 * another account becomes one of that row's `alsoIn` accounts. Copies match
 * only by the Message-ID of each conversation's newest message, and two rows
 * of one account never merge, as they are separate conversations there.
 *
 * Copies that arrived at the same moment are listed in no meaningful order,
 * so `preferAccountId`'s copy (the account the user is in) stands for them.
 */
export function showCopiesOnce<T>(
  rows: T[],
  copyOf: (row: T) => {
    accountId: string;
    messageId: string | undefined;
    at: number;
  },
  preferAccountId?: string,
): { row: T; alsoIn: string[] }[] {
  const shown: { row: T; alsoIn: string[] }[] = [];
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
    const entry = { row, alsoIn: [] as string[] };
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
      group.entry.alsoIn.push(group.accountId);
      group.entry.row = row;
      group.accountId = accountId;
    } else {
      group.entry.alsoIn.push(accountId);
    }
  }
  return shown;
}
