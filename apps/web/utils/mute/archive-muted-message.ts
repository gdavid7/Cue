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
 *
 * `withoutClaim` is what to do when Redis can't say whether another path
 * already archived it: the webhook archives anyway, since archiving twice is
 * harmless and a muted reply left in the inbox is not; mail sync, which runs
 * on every device, leaves it.
 */
export async function archiveMutedMessage({
  emailAccountId,
  messageId,
  provider,
  withoutClaim,
  logger,
}: {
  emailAccountId: string;
  messageId: string;
  provider: EmailProvider;
  withoutClaim: "archive" | "skip";
  logger: Logger;
}): Promise<"archived" | "already_handled" | "skipped"> {
  const claim = await claimNewMailReaction({
    emailAccountId,
    messageId,
    logger,
  });
  if (claim === "taken") return "already_handled";
  if (claim === "unavailable" && withoutClaim === "skip") return "skipped";
  try {
    await provider.archiveMessage(messageId);
    return "archived";
  } catch (error) {
    if (claim === "claimed")
      await releaseNewMailReaction({ emailAccountId, messageId, logger });
    throw error;
  }
}
