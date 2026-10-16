import type { SyncReadResult } from "@inboxzero/mail-core/ports/mailbox-source";
import type { Logger } from "@/utils/logger";
import { nudgeGmailHistoryCatchUp } from "@/utils/webhook/google/history-catch-up";

// Changes to older mail (reads, archives) are not mail anyone is waiting on.
const NEW_MAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  const newMailAfter = Date.now() - NEW_MAIL_WINDOW_MS;
  let newestHistoryId: bigint | null = null;
  for (const change of results.flatMap((result) =>
    result.status === "page" ? result.page.changes : [],
  )) {
    if (change.kind !== "message_patch") continue;
    const version = change.reference.version;
    if (!version || !/^\d+$/.test(version)) continue;
    if (!change.fields.roles?.includes("inbox")) continue;
    if ((change.fields.receivedAtMs ?? 0) < newMailAfter) continue;
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
