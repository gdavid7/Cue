import type { MetadataChange } from "@inboxzero/mail-core/commands";
import type { MailClient } from "@inboxzero/mail-core/engine";
import { randomUuid } from "@/utils/uuid";

/**
 * Takes back a conversation change the engine admitted. One still waiting in
 * the engine is cancelled there and never reaches the server; one already
 * sent is followed by `compensation`, which the engine runs after it.
 */
export async function undoConversationChange({
  client,
  accountId,
  operationId,
  conversationIds,
  compensation,
}: {
  client: MailClient;
  accountId: string;
  operationId: string;
  conversationIds: string[];
  compensation: MetadataChange;
}) {
  const cancelled = await client.cancelOperation({ accountId, operationId });
  if (cancelled.status === "cancelled") return;
  const diagnostics = await client.getDiagnostics(accountId);
  const admission = await client.submitConversations({
    accountId,
    commandId: randomUuid(),
    conversations: conversationIds.map((conversationId) => ({
      accountId,
      conversationId,
    })),
    change: compensation,
    observedRevision: diagnostics.revision,
  });
  if (admission.status === "rejected") throw new Error(admission.code);
}
