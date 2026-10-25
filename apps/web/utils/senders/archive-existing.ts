import { after } from "next/server";
import prisma from "@/utils/prisma";
import type { EmailProvider } from "@/utils/email/types";
import { resumeAfterGmailDeferral } from "@/utils/gmail/deferred-resume";
import { getGmailCallDeferredError } from "@/utils/gmail/quota";
import type { Logger } from "@/utils/logger";

/** Inbox messages at or under this count are archived in the request. */
export const INLINE_ARCHIVE_EXISTING_MESSAGE_LIMIT = 100;

export const ARCHIVE_EXISTING_RESUME_PATH =
  "/api/user/senders/archive-existing";

export async function archiveExistingSenderMail({
  emailAccountId,
  emailProvider,
  senderEmail,
  ownerEmail,
  logger,
}: {
  emailAccountId: string;
  emailProvider: EmailProvider;
  senderEmail: string;
  ownerEmail: string;
  logger: Logger;
}): Promise<"completed" | "queued"> {
  const inboxCount = await prisma.emailMessage.count({
    where: {
      emailAccountId,
      inbox: true,
      from: { equals: senderEmail, mode: "insensitive" },
    },
  });

  // Local rows are only a size hint. The provider inbox is the archive source.
  // Zero local rows is not a small inbox: the sender may not be ingested yet,
  // so that case is queued instead of scanned inside the request.
  if (inboxCount > 0 && inboxCount <= INLINE_ARCHIVE_EXISTING_MESSAGE_LIMIT) {
    await emailProvider.bulkArchiveSenderOrThrow(
      senderEmail,
      ownerEmail,
      emailAccountId,
    );
    return "completed";
  }

  after(() =>
    runQueuedSenderArchive({
      emailAccountId,
      emailProvider,
      senderEmail,
      ownerEmail,
      logger,
      startedAt: Date.now(),
      deferrals: 0,
    }),
  );

  return "queued";
}

/**
 * Archives the sender's inbox mail in the background. The archive searches
 * the sender's mail still in the inbox, so a resumed run starts over on what
 * is left and never touches mail an earlier run already archived.
 */
export async function runQueuedSenderArchive({
  emailAccountId,
  emailProvider,
  senderEmail,
  ownerEmail,
  newsletterId,
  logger,
  startedAt,
  deferrals,
}: {
  emailAccountId: string;
  emailProvider: EmailProvider;
  senderEmail: string;
  ownerEmail: string;
  /** The sender's row, when the caller already has it. */
  newsletterId?: string;
  logger: Logger;
  /** When the first run of this archive started. */
  startedAt: number;
  deferrals: number;
}) {
  try {
    await emailProvider.bulkArchiveSenderOrThrow(
      senderEmail,
      ownerEmail,
      emailAccountId,
    );
  } catch (error) {
    if (!getGmailCallDeferredError(error)) {
      logger.error("Failed to archive existing sender mail", { error });
      return;
    }

    // The resume names the sender by its row so the queue never holds the
    // sender's or the owner's address (founder rule R-1).
    let senderId = newsletterId;
    if (!senderId) {
      try {
        const sender = await prisma.newsletter.findFirst({
          where: {
            emailAccountId,
            email: { equals: senderEmail, mode: "insensitive" },
          },
          select: { id: true },
        });
        senderId = sender?.id;
      } catch (lookupError) {
        logger.error(
          "Failed to look up the sender to resume archiving existing mail",
          { error: lookupError },
        );
        return;
      }
    }
    if (!senderId) {
      logger.warn(
        "Deferred archiving existing sender mail and found no sender row to resume it by",
      );
      return;
    }

    await resumeAfterGmailDeferral({
      error,
      path: ARCHIVE_EXISTING_RESUME_PATH,
      body: {
        emailAccountId,
        provider: emailProvider.name,
        newsletterId: senderId,
        startedAt,
      },
      deferrals,
      jobKey: `archive-existing-${emailAccountId}-${senderId}-${startedAt}`,
      job: "archiving existing sender mail",
      logger,
    });
  }
}
