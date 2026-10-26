import type { SyncReadResult } from "@inboxzero/mail-core/ports/mailbox-source";
import { SnoozedThreadStatus } from "@/generated/prisma/enums";
import type { EmailProvider } from "@/utils/email/types";
import { isIgnoredSender } from "@/utils/filter-ignored-senders";
import type { Logger } from "@/utils/logger";
import { notifyMailboxChanged } from "@/utils/mailbox-push";
import { archiveMutedMessage } from "@/utils/mute/archive-muted-message";
import { premiumEntitlementSelect } from "@/utils/premium";
import prisma from "@/utils/prisma";
import {
  isInboxArrival,
  wakeSnoozedThreadOnReply,
} from "@/utils/snooze/wake-on-reply";
import { getWebhookProcessing } from "@/utils/webhook/validate-webhook-account";

// Older changes are reads, archives and moves, not mail arriving.
const NEW_MAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
// Bounds the provider reads one sync can cost; the rest wait for the next.
const MAX_MESSAGES_PER_SYNC = 20;

/**
 * Mute (FT-19) and snooze wake-on-reply (FT-23) for the accounts provider
 * pushes don't process: no premium, no AI access, or nothing to run. Their
 * mail reaches Cue only through the client's mail sync, which every engine
 * (tab, worker, desktop) reads through mail/v1 changes, so this runs after
 * those reads. Accounts the pushes do process are left to them, where mute
 * and the wake run around the message's rules.
 */
export async function reactToSyncedNewMail({
  emailAccountId,
  provider,
  results,
  logger,
}: {
  emailAccountId: string;
  provider: EmailProvider;
  results: ReadonlyArray<SyncReadResult>;
  logger: Logger;
}) {
  try {
    const arrivals = recentArrivals(results);
    if (arrivals.length === 0) return;
    const threadIds = [...new Set(arrivals.map((arrival) => arrival.threadId))];

    const [mutes, snoozes] = await Promise.all([
      prisma.mutedThread.findMany({
        where: { emailAccountId, threadId: { in: threadIds } },
        select: { threadId: true, createdAt: true },
      }),
      prisma.snoozedThread.findMany({
        where: {
          emailAccountId,
          threadId: { in: threadIds },
          status: SnoozedThreadStatus.PENDING,
        },
        select: { threadId: true },
      }),
    ]);
    if (mutes.length === 0 && snoozes.length === 0) return;

    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: {
        id: true,
        email: true,
        userId: true,
        filingEnabled: true,
        filingPrompt: true,
        rules: { where: { enabled: true }, select: { id: true }, take: 1 },
        user: {
          select: {
            aiApiKey: true,
            premium: { select: premiumEntitlementSelect },
          },
        },
      },
    });
    if (!emailAccount || !getWebhookProcessing(emailAccount).skip) return;

    const mutedAt = new Map(
      mutes.map((mute) => [mute.threadId, mute.createdAt.getTime()]),
    );
    const snoozed = new Set(snoozes.map((snooze) => snooze.threadId));
    let changed = false;

    for (const arrival of arrivals.slice(0, MAX_MESSAGES_PER_SYNC)) {
      const muteTime = mutedAt.get(arrival.threadId);
      try {
        // Mute wins: a muted conversation's mail never wakes it.
        if (muteTime !== undefined) {
          // Mail already in the conversation when it was muted is what the
          // user muted, not an arrival.
          if (arrival.receivedAtMs <= muteTime) continue;
          const message = await provider.getMessage(arrival.messageId);
          if (
            !isInboxArrival(message) ||
            provider.isSentMessage(message) ||
            isIgnoredSender(message.headers.from)
          )
            continue;
          const outcome = await archiveMutedMessage({
            emailAccountId,
            messageId: message.id,
            provider,
            logger,
          });
          if (outcome === "archived") {
            changed = true;
            logger.info("Archived a muted conversation's new message on sync");
          }
          continue;
        }

        if (!snoozed.has(arrival.threadId)) continue;
        // Newest first, so one reply wakes the conversation for the page.
        snoozed.delete(arrival.threadId);
        const message = await provider.getMessage(arrival.messageId);
        if (provider.isSentMessage(message)) continue;
        const woke = await wakeSnoozedThreadOnReply({
          emailAccount,
          message,
          provider,
          logger,
        });
        if (woke) changed = true;
      } catch (error) {
        // A muted message stays in the inbox and a snoozed conversation comes
        // back when its snooze ends.
        logger.warn("Failed to apply mute or snooze to a synced message", {
          error,
          muted: muteTime !== undefined,
        });
      }
    }

    // Open engines read the move now rather than at their next catch-up.
    if (changed) await notifyMailboxChanged({ emailAccountId, logger });
  } catch (error) {
    logger.warn("Failed to apply mute and snooze to synced mail", { error });
  }
}

function recentArrivals(results: ReadonlyArray<SyncReadResult>) {
  const newMailAfter = Date.now() - NEW_MAIL_WINDOW_MS;
  const arrivals = new Map<
    string,
    { messageId: string; threadId: string; receivedAtMs: number }
  >();
  for (const change of results.flatMap((result) =>
    result.status === "page" ? result.page.changes : [],
  )) {
    if (change.kind !== "message_patch") continue;
    const threadId = change.reference.conversationId;
    const receivedAtMs = change.fields.receivedAtMs ?? 0;
    if (!threadId || receivedAtMs < newMailAfter) continue;
    const roles = change.fields.roles ?? [];
    if (roles.includes("sent") || roles.includes("draft")) continue;
    arrivals.set(change.key.messageId, {
      messageId: change.key.messageId,
      threadId,
      receivedAtMs,
    });
  }
  return [...arrivals.values()].sort((a, b) => b.receivedAtMs - a.receivedAtMs);
}
