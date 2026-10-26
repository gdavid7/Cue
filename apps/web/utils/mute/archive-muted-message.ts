import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import {
  claimNewMailReaction,
  releaseNewMailReaction,
} from "@/utils/redis/new-mail-reaction";

/**
 * Keeps a muted conversation's new message out of the inbox. The mute lives in
 * Cue's database, never as a mailbox label or filter (D-008). Only the message
 * that arrived is archived: the rest of the thread (the user's Sent replies,
 * drafts, mail they moved back) stays where it is. The webhook and mail sync
 * can both see the message; whichever comes second does nothing, and a failed
 * archive throws for its caller to handle, leaving the message to try again.
 */
export async function archiveMutedMessage({
  emailAccountId,
  messageId,
  provider,
  logger,
}: {
  emailAccountId: string;
  messageId: string;
  provider: EmailProvider;
  logger: Logger;
}): Promise<"archived" | "already_handled"> {
  const claimed = await claimNewMailReaction({
    emailAccountId,
    messageId,
    logger,
  });
  if (!claimed) return "already_handled";
  try {
    await provider.archiveMessage(messageId);
    return "archived";
  } catch (error) {
    await releaseNewMailReaction({ emailAccountId, messageId, logger });
    throw error;
  }
}
