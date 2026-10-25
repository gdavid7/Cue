import { SnoozedThreadStatus } from "@/generated/prisma/enums";
import type { SnoozedThread } from "@/generated/prisma/client";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import { parsedMessageMetadata } from "@/utils/mail-api/observations";
import prisma from "@/utils/prisma";
import { isMissingConversation } from "@/utils/email/thread-not-found";
import {
  endSnoozedThreadWithoutRestore,
  releaseSnoozedThreadForRetry,
} from "@/utils/snooze/scheduler";

export async function executeSnoozedThread(
  snoozedThread: SnoozedThread,
  provider: EmailProvider,
  logger: Logger,
  leaseStartedAt: Date,
) {
  const claim = {
    id: snoozedThread.id,
    status: SnoozedThreadStatus.EXECUTING,
    updatedAt: leaseStartedAt,
  };

  // Trash and spam end a snooze. One whose cancellation hasn't reached this
  // record yet must not pull the conversation back out of either.
  if (await isTrashedOrSpam(provider, snoozedThread.threadId)) {
    await prisma.snoozedThread.updateMany({
      where: claim,
      data: { status: SnoozedThreadStatus.CANCELLED },
    });
    logger.info("Skipped restoring a snoozed thread now in trash or spam", {
      snoozedThreadId: snoozedThread.id,
    });
    return { success: true as const };
  }

  try {
    await provider.unarchiveThread(snoozedThread.threadId);
  } catch (error) {
    if (isMissingConversation(error)) {
      await endSnoozedThreadWithoutRestore(snoozedThread.id, leaseStartedAt);
      logger.warn("Snoozed thread is gone; ended its wake-up", {
        error,
        snoozedThreadId: snoozedThread.id,
      });
      return { success: true as const };
    }
    await releaseSnoozedThreadForRetry(snoozedThread, leaseStartedAt);
    logger.error("Failed to restore snoozed thread", {
      error,
      snoozedThreadId: snoozedThread.id,
    });
    return { success: false as const, error };
  }

  try {
    const completed = await prisma.snoozedThread.updateMany({
      where: claim,
      data: { status: SnoozedThreadStatus.COMPLETED },
    });
    if (completed.count !== 1) {
      const current = await prisma.snoozedThread.findUnique({
        where: { id: snoozedThread.id },
        select: { status: true },
      });
      // Undone, archived or moved while it was being restored: the snooze
      // is over either way, and nothing is left to retry.
      if (current?.status === SnoozedThreadStatus.CANCELLED) {
        logger.warn("Snoozed thread was cancelled while being restored", {
          snoozedThreadId: snoozedThread.id,
        });
        return { success: true as const };
      }
      throw new Error("Snoozed thread execution claim was lost");
    }
    return { success: true as const };
  } catch (error) {
    // Keep EXECUTING so a quick duplicate cannot repeat the provider call.
    // Stale execution recovery will retry and reconcile this record later.
    logger.error("Restored snoozed thread but failed to record completion", {
      error,
      snoozedThreadId: snoozedThread.id,
    });
    return { success: false as const, error };
  }
}

/**
 * Whether every message the user received in the thread is in the trash or
 * spam. Their own sent copies stay where they are, so they don't count. An
 * unreadable thread counts as not, and is restored as before.
 */
async function isTrashedOrSpam(provider: EmailProvider, threadId: string) {
  try {
    const received = (await provider.getThreadMessages(threadId))
      .map((message) => parsedMessageMetadata(message).roles)
      .filter((roles) => !roles.includes("sent") && !roles.includes("draft"));
    return (
      received.length > 0 &&
      received.every(
        (roles) => roles.includes("trash") || roles.includes("spam"),
      )
    );
  } catch {
    return false;
  }
}
