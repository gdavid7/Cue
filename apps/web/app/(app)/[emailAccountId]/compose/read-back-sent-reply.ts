import type { MailClient } from "@inboxzero/mail-core/engine";

/**
 * A reply sent now with only a reminder goes out from the server, outside the
 * mail engine, so the open conversation would show it only after the next
 * mailbox sync, which can wait on the provider's quota. Reading the
 * conversation back shows the reply as soon as it is sent.
 */
export async function readBackSentReply({
  client,
  accountId,
  threadId,
  sendAt,
}: {
  client: Pick<MailClient, "ensureConversationMessages">;
  accountId: string;
  threadId: string;
  sendAt: string | null;
}) {
  if (sendAt) return;
  await client
    .ensureConversationMessages({ accountId, conversationId: threadId })
    .catch(() => undefined);
}
