import type { Coverage } from "@inboxzero/mail-core/queries";
import type { MailClient } from "@inboxzero/mail-core/engine";

export function isMetadataCoverageComplete(coverage: Coverage[]) {
  return (
    coverage.length > 0 &&
    coverage.every((item) => item.metadata === "complete")
  );
}

/** Accounts with no finished sync in this local store, so their mail may not be here yet. */
export function getFirstSyncAccountIds(
  accountIds: string[],
  coverage: Coverage[],
) {
  const syncedAccountIds = new Set(
    coverage
      .filter((item) => item.lastCompletedSyncAtMs != null)
      .map((item) => item.accountId),
  );
  return accountIds.filter((accountId) => !syncedAccountIds.has(accountId));
}

export async function waitForMetadataCoverage(
  client: MailClient,
  accountId: string,
  abort: AbortSignal,
) {
  // Follower getDiagnostics can hang after a closed BroadcastChannel.
  // Abort must win that race so Strict Mode remounts can first-paint.
  const aborted = waitForAbort(abort);
  while (!abort.aborted) {
    try {
      const diagnostics = await Promise.race([
        client.getDiagnostics(accountId),
        aborted,
      ]);
      if (!diagnostics) return false;
      if (isMetadataCoverageComplete(diagnostics.coverage)) return true;
    } catch {
      if (abort.aborted) return false;
    }
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
      aborted,
    ]);
  }
  return false;
}

function waitForAbort(signal: AbortSignal) {
  return new Promise<null>((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}
