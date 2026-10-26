import type { SyncReadResult } from "@inboxzero/mail-core/ports/mailbox-source";
import type { Logger } from "@/utils/logger";
import { isRecentInboxArrival } from "@/utils/mail-api/recent-inbox-arrival";
import { nudgeGmailHistoryCatchUp } from "@/utils/webhook/google/history-catch-up";

/**
 * When the client's Gmail sync brings in new inbox mail, makes sure
 * server-side automation (triage, Needs reply) also gets to it, even if
 * Gmail's push is late.
 */
export async function nudgeCatchUpForNewGmail({
  emailAccountId,
  results,
  logger,
}: {
  emailAccountId: string;
  results: ReadonlyArray<SyncReadResult>;
  logger: Logger;
}) {
  let newestHistoryId: bigint | null = null;
  for (const change of results.flatMap((result) =>
    result.status === "page" ? result.page.changes : [],
  )) {
    if (!isRecentInboxArrival(change)) continue;
    const version = change.reference.version;
    if (!version || !/^\d+$/.test(version)) continue;
    const historyId = BigInt(version);
    if (newestHistoryId === null || historyId > newestHistoryId)
      newestHistoryId = historyId;
  }
  if (newestHistoryId === null) return;

  await nudgeGmailHistoryCatchUp({
    emailAccountId,
    mailboxHistoryId: newestHistoryId.toString(),
    logger,
  });
}
