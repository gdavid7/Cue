import type { MailClient } from "@inboxzero/mail-core/engine";

/**
 * Once the mailbox confirms a draft deleted, drops its copies from the local
 * store so a reload doesn't show it again before sync does. Best effort: an
 * older desktop engine without this call rejects or lacks it, and its next
 * sync removes the copies instead. It never rejects, so a discard need not
 * wait on a busy worker.
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
