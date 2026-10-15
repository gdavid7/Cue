import type { MailClient } from "@inboxzero/mail-core/engine";
import { beginOptimisticTriage } from "@/utils/mail-engine/optimistic-triage";
import { submitConversationChanges } from "@/utils/mail-engine/submit-conversations";

/**
 * Labels the conversations and, for a move, takes them out of the inbox. The
 * label goes first so nothing leaves the inbox without it. Both show on the
 * list at once, before the engine answers.
 */
export async function applyEngineLabels({
  client,
  emailAccountId,
  threadIds,
  labelId,
  removeFromInbox,
}: {
  client: MailClient;
  emailAccountId: string;
  threadIds: string[];
  labelId: string;
  removeFromInbox: boolean;
}) {
  // The archive is submitted only after the label is in, so it is shown from
  // here until its own submit takes over.
  const retireArchive = removeFromInbox
    ? beginOptimisticTriage(client, {
        accountId: emailAccountId,
        conversationIds: threadIds,
        change: { kind: "archive" },
      })
    : undefined;
  try {
    const labelled = await submitConversationChanges({
      client,
      accountId: emailAccountId,
      conversationIds: threadIds,
      change: {
        kind: "set_membership",
        membership: "label",
        id: labelId,
        present: true,
      },
    });
    let succeeded = labelled.accepted.map((item) => item.conversationId);
    if (removeFromInbox && succeeded.length) {
      const archived = await submitConversationChanges({
        client,
        accountId: emailAccountId,
        conversationIds: succeeded,
        change: { kind: "archive" },
      });
      succeeded = archived.accepted.map((item) => item.conversationId);
    }
    const done = new Set(succeeded);
    return {
      succeededThreadIds: threadIds.filter((id) => done.has(id)),
      failedThreadIds: threadIds.filter((id) => !done.has(id)),
      error: undefined as unknown,
    };
  } catch (error) {
    return {
      succeededThreadIds: [] as string[],
      failedThreadIds: threadIds,
      error,
    };
  } finally {
    retireArchive?.();
  }
}
