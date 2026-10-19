import type { MailClient } from "@inboxzero/mail-core/engine";

/**
 * Once the mailbox confirms a draft deleted, drops its copies from the local
 * store so a reload doesn't show it again before sync does. Best effort: sync
 * still removes them, and an older desktop engine has no way to.
 */
export async function forgetDeletedDrafts(
  client: MailClient | null | undefined,
  accountId: string,
  messageIds: Array<string | null | undefined>,
) {
  const ids = [
    ...new Set(messageIds.filter((id): id is string => Boolean(id))),
  ];
  if (!ids.length || !client?.forgetDeletedDrafts) return;
  try {
    await client.forgetDeletedDrafts({ accountId, messageIds: ids });
  } catch {
    // Sync removes them on its next pass.
  }
}
