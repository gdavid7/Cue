import type { ThreadTrackerType } from "@/generated/prisma/enums";
import { mapWithConcurrency } from "@/utils/async";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import prisma from "@/utils/prisma";
import { isGmailCallDeferredError } from "@/utils/gmail/quota";

const THREAD_CONCURRENCY = 5;
// Archiving a conversation doesn't resolve its tracker, so some of the newest
// open trackers point at mail that has left the inbox.
const OVERFETCH_FACTOR = 3;

/**
 * Conversations with an open reply tracker, newest first, read from Cue's
 * database rather than mailbox labels. With `inboxOnly`, conversations that
 * have left the inbox are skipped. Messages carry headers, labels and
 * snippets but no bodies: callers render them as list rows.
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
  // Each read is a 40-unit Gmail threads.get, so the overfetch is only read
  // when the newest trackers' conversations have left the inbox.
  const found: EmailThread[] = [];
  let next = 0;
  while (next < trackers.length && found.length < limit) {
    const page = trackers.slice(next, next + limit - found.length);
    next += page.length;
    const threads = await mapWithConcurrency(
      page,
      THREAD_CONCURRENCY,
      ({ threadId }) =>
        emailProvider
          .getThread(threadId, { messageFormat: "metadata" })
          .catch((error): EmailThread | null => {
            // Waiting for the account's Gmail budget is not a missing thread.
            if (isGmailCallDeferredError(error)) throw error;
            return null;
          }),
    );
    found.push(
      ...threads.filter(
        (thread): thread is EmailThread =>
          !!thread && (!inboxOnly || isInInbox(thread)),
      ),
    );
  }
  return found;
}

function isInInbox(thread: EmailThread) {
  return thread.messages.some((message) => message.labelIds?.includes("INBOX"));
}
