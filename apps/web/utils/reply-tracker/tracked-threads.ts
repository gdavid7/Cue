import type { ThreadTrackerType } from "@/generated/prisma/enums";
import { mapWithConcurrency } from "@/utils/async";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import prisma from "@/utils/prisma";

const THREAD_CONCURRENCY = 5;
// Archiving a conversation doesn't resolve its tracker, so some of the newest
// open trackers point at mail that has left the inbox.
const OVERFETCH_FACTOR = 3;

/**
 * Conversations with an open reply tracker, newest first, read from Cue's
 * database rather than mailbox labels. With `inboxOnly`, conversations that
 * have left the inbox are skipped.
 */
export async function getTrackedThreads({
  emailAccountId,
  emailProvider,
  type,
  limit,
  inboxOnly = false,
}: {
  emailAccountId: string;
  emailProvider: EmailProvider;
  type: ThreadTrackerType;
  limit: number;
  inboxOnly?: boolean;
}): Promise<EmailThread[]> {
  const trackers = await prisma.threadTracker.findMany({
    where: { emailAccountId, type, resolved: false },
    select: { threadId: true },
    orderBy: { sentAt: "desc" },
    distinct: ["threadId"],
    take: inboxOnly ? limit * OVERFETCH_FACTOR : limit,
  });
  const threads = await mapWithConcurrency(
    trackers,
    THREAD_CONCURRENCY,
    ({ threadId }) =>
      emailProvider.getThread(threadId).catch((): EmailThread | null => null),
  );
  return threads
    .filter(
      (thread): thread is EmailThread =>
        !!thread && (!inboxOnly || isInInbox(thread)),
    )
    .slice(0, limit);
}

function isInInbox(thread: EmailThread) {
  return thread.messages.some((message) => message.labelIds?.includes("INBOX"));
}
