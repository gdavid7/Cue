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
  ruleIds,
  logger: log,
  startedAt: resumedStartedAt,
  processedTotal = 0,
  deferrals = 0,
}: {
  emailAccount: EmailAccountForDrafting;
  provider: string;
  maxEmails: number;
  skipArchive: boolean;
  /** Sort with only these rules, such as ones just added. Defaults to every enabled rule. */
  ruleIds?: string[];
  logger: Logger;
  /** When the first run of this job started; set on resumes. */
  startedAt?: number;
  /** Messages earlier runs of this job touched; set on resumes. */
  processedTotal?: number;
  /** Deferrals in a row without progress; set on resumes. */
  deferrals?: number;
}) {
  const isResume = resumedStartedAt !== undefined;
  const startedAt = resumedStartedAt ?? Date.now();
  const logger = log.with({ module: "bulk-process-emails", deferrals });
  let messageIds: string[] = [];
  let touchedBefore = new Set<string>();

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
          ...(ruleIds ? { id: { in: ruleIds } } : {}),
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
    messageIds = latestMessages.map((message) => message.id);
    // Whatever an earlier run of this job touched is left alone, even when it
    // ended in an error: running the rules again could repeat an action that
    // went through, such as a reply sent before a later action failed.
    if (isResume) {
      touchedBefore = await getTouchedSince({
        emailAccountId: emailAccount.id,
        messageIds,
        startedAt,
      });
    }
    const uniqueMessages = latestMessages.filter(
      (message) => !touchedBefore.has(message.id),
    );

    logger.info("Processing emails with rules", {
      ruleCount: rules.length,
      emailCount: uniqueMessages.length,
      alreadyTouchedCount: touchedBefore.size,
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
    if (!getGmailCallDeferredError(error)) {
      logger.error("Failed to process emails", { error });
      return;
    }

    // Progress is what this run left a row on; a message that failed
    // without one is tried again and is not progress.
    const touchedNow = messageIds.length
      ? await getTouchedSince({
          emailAccountId: emailAccount.id,
          messageIds,
          startedAt,
        }).catch(() => touchedBefore)
      : touchedBefore;
    const nextProcessedTotal =
      processedTotal + Math.max(0, touchedNow.size - touchedBefore.size);

    await resumeAfterGmailDeferral({
      error,
      path: BULK_PROCESS_INBOX_PATH,
      body: {
        emailAccountId: emailAccount.id,
        provider,
        maxEmails,
        skipArchive,
        ruleIds,
        startedAt,
        processedTotal: nextProcessedTotal,
      },
      // The cap is for deferrals in a row that get nowhere.
      deferrals: nextProcessedTotal > processedTotal ? 0 : deferrals,
      jobKey: `bulk-process-inbox-${emailAccount.id}-${startedAt}-${nextProcessedTotal}`,
      job: "sorting existing inbox mail",
      logger,
    });
  }
}

/**
 * Messages with an executed rule from this job's runs, whatever its status.
 * Rows from before the job started, such as a push that skipped the mail
 * before these rules existed, do not count.
 */
async function getTouchedSince({
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
    select: { messageId: true, createdAt: true },
  });
  return new Set(
    rows
      .filter((row) => row.createdAt.getTime() >= startedAt)
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
