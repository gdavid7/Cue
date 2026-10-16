import { after } from "next/server";
import prisma from "@/utils/prisma";
import type { EmailProvider } from "@/utils/email/types";
import { resumeAfterGmailDeferral } from "@/utils/gmail/deferred-resume";
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
  logger,
  deferrals,
}: {
  emailAccountId: string;
  emailProvider: EmailProvider;
  senderEmail: string;
  ownerEmail: string;
  logger: Logger;
  deferrals: number;
}) {
  try {
    await emailProvider.bulkArchiveSenderOrThrow(
      senderEmail,
      ownerEmail,
      emailAccountId,
    );
  } catch (error) {
    const resumed = await resumeAfterGmailDeferral({
      error,
      path: ARCHIVE_EXISTING_RESUME_PATH,
      body: {
        emailAccountId,
        provider: emailProvider.name,
        senderEmail,
        ownerEmail,
      },
      deferrals,
      jobKey: `archive-existing-${emailAccountId}-${senderEmail}`,
      job: "archiving existing sender mail",
      logger,
    });
    if (!resumed) {
      logger.error("Failed to archive existing sender mail", { error });
    }
  }
}
