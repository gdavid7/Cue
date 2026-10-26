import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { SnoozedThreadStatus } from "@/generated/prisma/enums";
import type { EmailProvider } from "@/utils/email/types";
import { isIgnoredSender } from "@/utils/filter-ignored-senders";
import type { Logger } from "@/utils/logger";
import { isRecentInboxArrival } from "@/utils/mail-api/recent-inbox-arrival";
import { notifyMailboxChanged } from "@/utils/mailbox-push";
import { archiveMutedMessage } from "@/utils/mute/archive-muted-message";
import { premiumEntitlementSelect } from "@/utils/premium";
import prisma from "@/utils/prisma";
import {
  isInboxArrival,
  wakeSnoozedThreadOnReply,
} from "@/utils/snooze/wake-on-reply";
import { getWebhookProcessing } from "@/utils/webhook/validate-webhook-account";

// Bounds the provider reads one sync can cost. Only mail in muted or snoozed
// conversations counts toward it.
const MAX_MESSAGES_PER_SYNC = 20;

/**
 * Mute (FT-19) and snooze wake-on-reply (FT-23) for the accounts provider
 * pushes don't process: no premium, no AI access, or nothing to run. Their
 * mail reaches Cue only through the client's mail sync, which every engine
 * (tab, worker, desktop) reads through mail/v1 (a new device's first pages,
 * then changes), so this runs after those reads. Accounts the pushes do
 * process are left to them, where mute and the wake run around the message's
 * rules.
 *
 * Best effort: the client's cursor has already moved past these changes, so
 * nothing here is retried (only the webhook path retries). A message it
 * misses stays in the inbox, and a snoozed conversation still comes back when
 * its snooze ends.
 */
export async function reactToSyncedNewMail({
  emailAccountId,
  provider,
  changes,
  logger,
}: {
  emailAccountId: string;
  provider: EmailProvider;
  changes: ReadonlyArray<ProviderChange>;
  logger: Logger;
}) {
  try {
    const arrivals = recentArrivals(changes);
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
        select: { threadId: true, updatedAt: true },
      }),
    ]);
    const mutedAt = latestByThread(
      mutes.map((mute) => [mute.threadId, mute.createdAt]),
    );
    const snoozedAt = latestByThread(
      snoozes.map((snooze) => [snooze.threadId, snooze.updatedAt]),
    );

    // Mail already in the conversation when it was muted or snoozed is what
    // the user muted or snoozed, not an arrival. Mute wins over snooze.
    const candidates = arrivals.filter((arrival) => {
      const since =
        mutedAt.get(arrival.threadId) ?? snoozedAt.get(arrival.threadId);
      return since !== undefined && arrival.receivedAtMs > since;
    });
    if (candidates.length === 0) return;

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

    const woken = new Set<string>();
    let changed = false;

    for (const arrival of candidates.slice(0, MAX_MESSAGES_PER_SYNC)) {
      const muted = mutedAt.has(arrival.threadId);
      if (!muted && woken.has(arrival.threadId)) continue;
      try {
        const message = await provider.getMessage(arrival.messageId);
        if (provider.isSentMessage(message)) continue;

        if (muted) {
          if (!isInboxArrival(message) || isIgnoredSender(message.headers.from))
            continue;
          const outcome = await archiveMutedMessage({
            emailAccountId,
            messageId: message.id,
            provider,
            withoutClaim: "skip",
            logger,
          });
          if (outcome === "archived") {
            changed = true;
            logger.info("Archived a muted conversation's new message on sync");
          }
          continue;
        }

        const woke = await wakeSnoozedThreadOnReply({
          emailAccount,
          message,
          messageIsCurrent: true,
          provider,
          withoutClaim: "skip",
          logger,
        });
        // Otherwise an older reply on the page may still answer it.
        if (woke) {
          woken.add(arrival.threadId);
          changed = true;
        }
      } catch (error) {
        logger.warn("Failed to apply mute or snooze to a synced message", {
          error,
          muted,
        });
      }
    }

    // Open engines read the move now rather than at their next catch-up.
    if (changed) await notifyMailboxChanged({ emailAccountId, logger });
  } catch (error) {
    logger.warn("Failed to apply mute and snooze to synced mail", { error });
  }
}

/** Newest first, one entry per message. */
function recentArrivals(changes: ReadonlyArray<ProviderChange>) {
  const now = Date.now();
  const arrivals = new Map<
    string,
    { messageId: string; threadId: string; receivedAtMs: number }
  >();
  for (const change of changes) {
    if (!isRecentInboxArrival(change, now)) continue;
    const threadId = change.reference.conversationId;
    if (!threadId) continue;
    const roles = change.fields.roles ?? [];
    if (roles.includes("sent") || roles.includes("draft")) continue;
    arrivals.set(change.key.messageId, {
      messageId: change.key.messageId,
      threadId,
      receivedAtMs: change.fields.receivedAtMs ?? 0,
    });
  }
  return [...arrivals.values()].sort((a, b) => b.receivedAtMs - a.receivedAtMs);
}

function latestByThread(rows: [threadId: string, at: Date][]) {
  const latest = new Map<string, number>();
  for (const [threadId, at] of rows) {
    latest.set(threadId, Math.max(latest.get(threadId) ?? 0, at.getTime()));
  }
  return latest;
}
