import { normalizeInternetMessageId } from "@inboxzero/mail-core/messages";

/**
 * All inboxes shows a message delivered to several of the user's accounts
 * once: the newest-first list keeps the first copy, and each later copy from
 * another account becomes one of that row's `alsoIn` accounts. Copies match
 * only by the Message-ID of each conversation's newest message, and two rows
 * of one account never merge, as they are separate conversations there.
 */
export function showCopiesOnce<T>(
  rows: T[],
  copyOf: (row: T) => { accountId: string; messageId: string | undefined },
): { row: T; alsoIn: string[] }[] {
  const shown: { row: T; alsoIn: string[] }[] = [];
  const groupsByMessageId = new Map<
    string,
    { entry: (typeof shown)[number]; accountIds: Set<string> }[]
  >();
  for (const row of rows) {
    const { accountId, messageId } = copyOf(row);
    const entry = { row, alsoIn: [] as string[] };
    const key = normalizeInternetMessageId(messageId);
    if (!key) {
      shown.push(entry);
      continue;
    }
    const groups = groupsByMessageId.get(key) ?? [];
    const group = groups.find(({ accountIds }) => !accountIds.has(accountId));
    if (group) {
      group.accountIds.add(accountId);
      group.entry.alsoIn.push(accountId);
      continue;
    }
    shown.push(entry);
    groups.push({ entry, accountIds: new Set([accountId]) });
    groupsByMessageId.set(key, groups);
  }
  return shown;
}
