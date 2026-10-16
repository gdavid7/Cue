import { ExecutedRuleStatus } from "@/generated/prisma/enums";
import prisma from "@/utils/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import { runRules } from "@/utils/ai/choose-rule/run-rules";
import { resumeAfterGmailDeferral } from "@/utils/gmail/deferred-resume";
import { getGmailCallDeferredError } from "@/utils/gmail/quota";
import type { Logger } from "@/utils/logger";
import type { EmailAccountForDrafting } from "@/utils/ai/choose-rule/choose-args";
import type { ParsedMessage } from "@/utils/types";

export const BULK_PROCESS_INBOX_PATH = "/api/ai/bulk-process-inbox";

export async function bulkProcessInboxEmails({
  emailAccount,
  provider,
  maxEmails,
  skipArchive,
  logger: log,
  startedAt: resumedStartedAt,
  deferrals = 0,
}: {
  emailAccount: EmailAccountForDrafting;
  provider: string;
  maxEmails: number;
  skipArchive: boolean;
  logger: Logger;
  /** When the first run of this job started; set on resumes. */
  startedAt?: number;
  /** Deferrals in a row without progress; set on resumes. */
  deferrals?: number;
}) {
  const isResume = resumedStartedAt !== undefined;
  const startedAt = resumedStartedAt ?? Date.now();
  const logger = log.with({ module: "bulk-process-emails", deferrals });
  let sortedCount = 0;
  let processedCount = 0;

  logger.info("Starting bulk inbox email processing");

  try {
    const emailProvider = await createEmailProvider({
      emailAccountId: emailAccount.id,
      provider,
      logger,
    });

    const [messages, rules] = await Promise.all([
      emailProvider.getInboxMessages(maxEmails),
      prisma.rule.findMany({
        where: {
          emailAccountId: emailAccount.id,
          enabled: true,
        },
        include: {
          actions: true,
        },
      }),
    ]);

    if (messages.length === 0) {
      logger.info("No inbox emails to process");
      return;
    }

    if (rules.length === 0) {
      logger.info("No rules found");
      return;
    }

    const latestMessages = getLatestMessagePerThread(messages);
    const sortedIds = isResume
      ? await getSortedSince({
          emailAccountId: emailAccount.id,
          messageIds: latestMessages.map((message) => message.id),
          startedAt,
        })
      : new Set<string>();
    const uniqueMessages = latestMessages.filter(
      (message) => !sortedIds.has(message.id),
    );
    sortedCount = latestMessages.length - uniqueMessages.length;

    logger.info("Processing emails with rules", {
      ruleCount: rules.length,
      emailCount: uniqueMessages.length,
      alreadySortedCount: sortedCount,
      totalFetched: messages.length,
    });

    let errorCount = 0;

    for (const message of uniqueMessages) {
      try {
        await runRules({
          provider: emailProvider,
          message,
          rules,
          emailAccount,
          isTest: false,
          modelType: "economy",
          logger,
          skipArchive,
        });
        processedCount++;
      } catch (error) {
        // The rest of the run would be deferred too, so it resumes later.
        if (getGmailCallDeferredError(error)) throw error;
        errorCount++;
        logger.error("Error processing email", {
          messageId: message.id,
          error,
        });
        // Continue processing other emails even if one fails
      }
    }

    logger.info("Completed bulk email processing", {
      processedCount,
      errorCount,
      totalEmails: uniqueMessages.length,
    });
  } catch (error) {
    const resumed = await resumeAfterGmailDeferral({
      error,
      path: BULK_PROCESS_INBOX_PATH,
      body: {
        emailAccountId: emailAccount.id,
        provider,
        maxEmails,
        skipArchive,
        startedAt,
      },
      // The cap is for deferrals in a row that get nowhere.
      deferrals: processedCount > 0 ? 0 : deferrals,
      jobKey: `bulk-process-inbox-${emailAccount.id}-${startedAt}-${sortedCount + processedCount}`,
      job: "sorting existing inbox mail",
      logger,
    });
    if (!resumed) logger.error("Failed to process emails", { error });
  }
}

/**
 * Mail this job already sorted before it was deferred. Rows from before the
 * job started (say, a push that skipped the mail before these rules existed)
 * and rows that ended in an error do not count, so that mail is sorted now.
 */
async function getSortedSince({
  emailAccountId,
  messageIds,
  startedAt,
}: {
  emailAccountId: string;
  messageIds: string[];
  startedAt: number;
}) {
  const rows = await prisma.executedRule.findMany({
    where: { emailAccountId, messageId: { in: messageIds } },
    select: { messageId: true, status: true, createdAt: true },
  });
  return new Set(
    rows
      .filter(
        (row) =>
          row.status !== ExecutedRuleStatus.ERROR &&
          row.createdAt.getTime() >= startedAt,
      )
      .map((row) => row.messageId),
  );
}

function getLatestMessagePerThread(messages: ParsedMessage[]): ParsedMessage[] {
  const latestByThread = new Map<string, ParsedMessage>();

  for (const message of messages) {
    const existing = latestByThread.get(message.threadId);
    if (
      !existing ||
      new Date(message.date || 0) > new Date(existing.date || 0)
    ) {
      latestByThread.set(message.threadId, message);
    }
  }

  return Array.from(latestByThread.values());
}
