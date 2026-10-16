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
  deferrals = 0,
}: {
  emailAccount: EmailAccountForDrafting;
  provider: string;
  maxEmails: number;
  skipArchive: boolean;
  logger: Logger;
  deferrals?: number;
}) {
  const logger = log.with({ module: "bulk-process-emails", deferrals });

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

    // A resumed run, or a push that got there first, already sorted some of
    // this mail; running the rules on it again would act on it twice.
    const latestMessages = getLatestMessagePerThread(messages);
    const alreadySorted = await prisma.executedRule.findMany({
      where: {
        emailAccountId: emailAccount.id,
        messageId: { in: latestMessages.map((message) => message.id) },
      },
      select: { messageId: true },
    });
    const sortedIds = new Set(alreadySorted.map((rule) => rule.messageId));
    const uniqueMessages = latestMessages.filter(
      (message) => !sortedIds.has(message.id),
    );

    logger.info("Processing emails with rules", {
      ruleCount: rules.length,
      emailCount: uniqueMessages.length,
      alreadySortedCount: latestMessages.length - uniqueMessages.length,
      totalFetched: messages.length,
    });

    let processedCount = 0;
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
      },
      deferrals,
      jobKey: `bulk-process-inbox-${emailAccount.id}`,
      job: "sorting existing inbox mail",
      logger,
    });
    if (!resumed) logger.error("Failed to process emails", { error });
  }
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
