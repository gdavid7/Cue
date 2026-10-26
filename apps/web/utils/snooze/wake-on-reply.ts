import { SnoozedThreadStatus } from "@/generated/prisma/enums";
import { canonicalizeEmailAddress } from "@/utils/email";
import { getMessageTimestamp } from "@/utils/email/message-timestamp";
import { createEmailProvider } from "@/utils/email/provider";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import { parsedMessageMetadata } from "@/utils/mail-api/observations";
import { normalizeInternetMessageId } from "@inboxzero/mail-core/messages";
import prisma from "@/utils/prisma";
import { unsnoozeThreads } from "@/utils/snooze/unsnooze";
import type { ParsedMessage } from "@/utils/types";
import { getUserOwnAddresses, isOwnAddress } from "@/utils/user/own-addresses";

// Earlier messages of the conversation looked up in each other account, to
// find that account's copy of it.
const MAX_COPY_LOOKUPS = 3;

/**
 * Brings a snoozed conversation back early when someone else answers it,
 * through the same path as unsnoozing it by hand. Runs after the message's
 * rules, so mail they filed away, and mail now in spam or trash, isn't an
 * answer to wake for. Mute is handled before this and wins: a muted
 * conversation's mail never gets here. Snoozing reaches every copy of a
 * conversation in the user's other accounts, so waking does too.
 */
export async function wakeSnoozedThreadOnReply({
  emailAccount,
  message,
  provider,
  logger,
}: {
  emailAccount: { id: string; email: string; userId: string };
  message: ParsedMessage;
  provider: EmailProvider;
  logger: Logger;
}) {
  if (!message.threadId) return;
  const snooze = await prisma.snoozedThread.findFirst({
    where: {
      emailAccountId: emailAccount.id,
      threadId: message.threadId,
      status: SnoozedThreadStatus.PENDING,
    },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  if (!snooze || !arrivedAfter(message, snooze.updatedAt)) return;

  const current = await provider.getMessage(message.id);
  if (!isInboxArrival(current)) return;
  if (await isFromUser({ emailAccount, message: current, provider, logger }))
    return;

  const { unsnoozedThreadIds } = await unsnoozeThreads({
    emailAccountId: emailAccount.id,
    logger,
    provider,
    threadIds: [message.threadId],
  });
  if (unsnoozedThreadIds.length === 0) return;
  logger.info("Woke a snoozed conversation on a reply");

  await wakeCopiesInOtherAccounts({ emailAccount, message: current, logger });
}

async function wakeCopiesInOtherAccounts({
  emailAccount,
  message,
  logger,
}: {
  emailAccount: { id: string; userId: string };
  message: ParsedMessage;
  logger: Logger;
}) {
  const earlierMessageIds = conversationMessageIds(message);
  if (earlierMessageIds.length === 0) return;

  const snoozes = await prisma.snoozedThread.findMany({
    where: {
      status: SnoozedThreadStatus.PENDING,
      emailAccountId: { not: emailAccount.id },
      emailAccount: { userId: emailAccount.userId },
    },
    select: {
      threadId: true,
      updatedAt: true,
      emailAccountId: true,
      emailAccount: { select: { account: { select: { provider: true } } } },
    },
  });

  const byAccount = new Map<string, typeof snoozes>();
  for (const snooze of snoozes) {
    byAccount.set(snooze.emailAccountId, [
      ...(byAccount.get(snooze.emailAccountId) ?? []),
      snooze,
    ]);
  }

  for (const [emailAccountId, accountSnoozes] of byAccount) {
    try {
      const provider = await createEmailProvider({
        emailAccountId,
        provider: accountSnoozes[0].emailAccount.account?.provider ?? "",
        logger,
      });
      const threadId = await findSnoozedCopy({
        provider,
        earlierMessageIds,
        snoozes: accountSnoozes.filter((snooze) =>
          arrivedAfter(message, snooze.updatedAt),
        ),
      });
      if (!threadId) continue;
      const muted = await prisma.mutedThread.findUnique({
        where: { emailAccountId_threadId: { emailAccountId, threadId } },
        select: { id: true },
      });
      if (muted) continue;
      await unsnoozeThreads({
        emailAccountId,
        logger,
        provider,
        threadIds: [threadId],
      });
    } catch (error) {
      // That copy still comes back when its snooze ends.
      logger.warn("Failed to wake a snoozed copy in another account", {
        error,
        copyEmailAccountId: emailAccountId,
      });
    }
  }
}

async function findSnoozedCopy({
  provider,
  earlierMessageIds,
  snoozes,
}: {
  provider: EmailProvider;
  earlierMessageIds: string[];
  snoozes: { threadId: string }[];
}) {
  const snoozed = new Set(snoozes.map((snooze) => snooze.threadId));
  if (snoozed.size === 0) return null;
  for (const messageId of earlierMessageIds) {
    const copy = await provider.getMessageByRfc822MessageId(messageId);
    if (copy?.threadId && snoozed.has(copy.threadId)) return copy.threadId;
  }
  return null;
}

/**
 * The user's own mail never wakes a conversation: mail from any of their
 * connected accounts, and on Gmail, from a send-as alias. An unreadable alias
 * list counts as theirs, so the snooze just runs to its time.
 */
async function isFromUser({
  emailAccount,
  message,
  provider,
  logger,
}: {
  emailAccount: { email: string; userId: string };
  message: ParsedMessage;
  provider: EmailProvider;
  logger: Logger;
}) {
  const ownAddresses = [
    canonicalizeEmailAddress(emailAccount.email),
    ...(await getUserOwnAddresses(emailAccount.userId)),
  ];
  if (isOwnAddress(message.headers.from, ownAddresses)) return true;
  // Only Gmail lists send-as aliases; Outlook's signatures come from reading
  // its sent mail, which holds no address the accounts above don't.
  if (provider.name !== "google") return false;
  try {
    const aliases = (await provider.getSignatures()).map((signature) =>
      canonicalizeEmailAddress(signature.email),
    );
    return isOwnAddress(message.headers.from, aliases);
  } catch (error) {
    logger.warn("Failed to read send-as aliases; not waking", { error });
    return true;
  }
}

function isInboxArrival(message: ParsedMessage) {
  const { roles } = parsedMessageMetadata(message);
  return (
    roles.includes("inbox") &&
    !roles.some(
      (role) =>
        role === "sent" ||
        role === "draft" ||
        role === "trash" ||
        role === "spam",
    )
  );
}

// Mail that was already in the conversation when it was snoozed, and only
// processed since, is what the user snoozed, not an answer.
function arrivedAfter(message: ParsedMessage, snoozedAt: Date) {
  return getMessageTimestamp(message) > snoozedAt.getTime();
}

/** The conversation's earlier Message-IDs this message answers, newest first. */
function conversationMessageIds(message: ParsedMessage) {
  const referenced = [
    message.headers["in-reply-to"],
    ...(message.headers.references ?? "").split(/\s+/).reverse(),
  ];
  return [
    ...new Set(
      referenced.flatMap((value) => {
        const id = normalizeInternetMessageId(value);
        return id ? [id] : [];
      }),
    ),
  ].slice(0, MAX_COPY_LOOKUPS);
}
