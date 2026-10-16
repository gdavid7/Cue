import { captureException } from "@/utils/error";
import { flushAuditEvents } from "@/utils/audit/delivery";
import { getAuditContext, runWithAuditContext } from "@/utils/audit/context";
import { logGmailQuotaUsage } from "@/utils/gmail/quota";
import { getRedisUsageMeter } from "@/utils/redis/usage-meter";
import type { Logger } from "@/utils/logger";

type LoggerFlushExtra = Record<string, unknown>;

export async function flushLoggerSafely(
  logger: Logger,
  extra?: LoggerFlushExtra,
) {
  // Logged before the flush so the summaries ship with this request's logs.
  await logGmailQuotaUsage();
  getRedisUsageMeter().logSummary(logger);
  await Promise.all([
    logger.flush().catch((error) => {
      captureException(error, {
        extra: { ...extra, flushContext: "logger-flush" },
      });
    }),
    flushAuditEvents().catch((error) => {
      captureException(error, {
        extra: { ...extra, flushContext: "audit-flush" },
      });
    }),
  ]);
}

export async function runWithBackgroundLoggerFlush({
  logger,
  task,
  extra,
}: {
  logger: Logger;
  task: () => Promise<void>;
  extra?: LoggerFlushExtra;
}) {
  const auditContext = getAuditContext();
  try {
    await runWithAuditContext(auditContext, task);
  } finally {
    await flushLoggerSafely(logger, {
      ...extra,
      taskContext: "background-task",
    });
  }
}
