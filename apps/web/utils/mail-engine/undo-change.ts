import type { MetadataChange } from "@inboxzero/mail-core/commands";
import type { MailClient } from "@inboxzero/mail-core/engine";
import { randomUuid } from "@/utils/uuid";

/**
 * Takes back a conversation change the engine admitted. One still waiting in
 * the engine is cancelled there and never reaches the server; one already
 * sent is followed by each compensation, which the engine runs after it. A
 * command whose conversations were in different places before it needs a
 * different compensation for each, so they come as groups. A change made to
 * the whole conversation, as from Sent or Drafts, is undone the same way.
 */
export async function undoConversationChange({
  client,
  accountId,
  operationId,
  compensations,
  wholeConversation = false,
}: {
  client: MailClient;
  accountId: string;
  operationId: string;
  compensations: Array<{ conversationIds: string[]; change: MetadataChange }>;
  wholeConversation?: boolean;
}) {
  const cancelled = await client.cancelOperation({ accountId, operationId });
  if (cancelled.status === "cancelled") return;
  const diagnostics = await client.getDiagnostics(accountId);
  for (const { conversationIds, change } of compensations) {
    const admission = await client.submitConversations({
      accountId,
      commandId: randomUuid(),
      conversations: conversationIds.map((conversationId) => ({
        accountId,
        conversationId,
      })),
      change,
      ...(wholeConversation ? { wholeConversation: true } : {}),
      observedRevision: diagnostics.revision,
    });
    if (admission.status === "rejected") throw new Error(admission.code);
  }
}
