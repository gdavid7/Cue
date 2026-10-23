import type { MutedThreadIdsResponse } from "@/app/api/user/muted-threads/ids/route";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";

const MUTED_IDS_TTL_MS = 60_000;

const cache = new Map<string, { ids: Set<string>; loadedAtMs: number }>();

/**
 * The thread ids an account muted, for the open tab's notifier to leave out.
 * Kept for a minute, since a burst of new mail would otherwise ask once per
 * batch; muting or unmuting here clears it. Ids only, never content (R-1).
 */
export async function loadMutedThreadIds(
  accountId: string,
  nowMs = Date.now(),
): Promise<Set<string> | null> {
  const cached = cache.get(accountId);
  if (cached && nowMs - cached.loadedAtMs < MUTED_IDS_TTL_MS) return cached.ids;
  try {
    const response = await fetch("/api/user/muted-threads/ids", {
      headers: { [EMAIL_ACCOUNT_HEADER]: accountId },
    });
    if (!response.ok) return null;
    const muted: MutedThreadIdsResponse = await response.json();
    const ids = new Set(muted.threadIds);
    cache.set(accountId, { ids, loadedAtMs: nowMs });
    return ids;
  } catch {
    return null;
  }
}

export function forgetMutedThreadIds(accountId: string) {
  cache.delete(accountId);
}
