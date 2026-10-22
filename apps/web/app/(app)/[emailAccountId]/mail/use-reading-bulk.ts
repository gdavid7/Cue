"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getReadingBulkPlan,
  MAX_READING_DRAIN_PAGES,
} from "@/app/(app)/[emailAccountId]/mail/reading-lane";
import { getMatchingScope } from "@/app/(app)/[emailAccountId]/mail/select-all-matching";
import { useSelectAllMatching } from "@/app/(app)/[emailAccountId]/mail/use-select-all-matching";
import { useStableCallback } from "@/app/(app)/[emailAccountId]/mail/use-stable-callback";
import type { ThreadsQuery } from "@/utils/threads/validation";

type ReadingBulkAction = "read" | "archive";

const NO_SELECTION: ReadonlySet<string> = new Set();

/**
 * "Mark all read" and "Archive all" for the Reading lane, over every
 * newsletter in it rather than the page loaded so far (see
 * `getReadingBulkPlan`). `applyLoaded` acts on the lane's loaded rows through
 * the engine; `capped` says some were still left past the page limit.
 */
export function useReadingBulk({
  emailAccountId,
  provider,
  readingQuery,
  hasMore,
  isLoadingMore,
  loadMore,
  applyLoaded,
  onServerJobFinished,
}: {
  emailAccountId: string;
  provider: string | null | undefined;
  readingQuery: ThreadsQuery | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => Promise<void>;
  applyLoaded: (action: ReadingBulkAction, capped: boolean) => void;
  onServerJobFinished: () => void;
}) {
  // Where the provider can list the whole lane, as Gmail can.
  const accounts = useMemo(() => {
    const scope = readingQuery
      ? getMatchingScope(readingQuery, provider)
      : null;
    return scope ? [{ id: emailAccountId, scope }] : null;
  }, [emailAccountId, readingQuery, provider]);
  const matching = useSelectAllMatching({
    accounts,
    viewIdentity: "reading-lane",
    selection: NO_SELECTION,
    allPageSelected: false,
    hasMore: false,
    onFinished: onServerJobFinished,
  });
  const [drain, setDrain] = useState<{
    action: ReadingBulkAction;
    loaded: boolean;
  } | null>(null);

  // The pages are in once the last load has rendered; only then are the rows
  // to act on all there.
  useEffect(() => {
    if (!drain?.loaded || isLoadingMore) return;
    setDrain(null);
    applyLoaded(drain.action, hasMore);
  }, [drain, isLoadingMore, hasMore, applyLoaded]);

  const run = useStableCallback(async (action: ReadingBulkAction) => {
    if (drain) return;
    const plan = getReadingBulkPlan({ hasMore, canMatch: Boolean(accounts) });
    if (plan === "loaded") return applyLoaded(action, false);
    if (plan === "matching")
      return matching.run(action === "read" ? "mark_read" : "archive");
    setDrain({ action, loaded: false });
    // A load with nothing left returns at once, so this stops early.
    for (let page = 0; page < MAX_READING_DRAIN_PAGES; page++) await loadMore();
    setDrain({ action, loaded: true });
  });

  return { run, busy: Boolean(drain) };
}
