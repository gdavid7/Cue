"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
const ACTION_NAMES: Record<ReadingBulkAction, string> = {
  read: "Mark all read",
  archive: "Archive all",
};

/**
 * "Mark all read" and "Archive all" for the Reading lane, over every
 * newsletter in it rather than the page loaded so far (see
 * `getReadingBulkPlan`). `applyLoaded` acts on the lane's loaded rows through
 * the engine, and `capped` says some were still left past the page limit;
 * `onServerJobFinished` runs once a server job over the lane has changed
 * something.
 * `readingQuery` is null outside the lane, which stops a load in progress.
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
  onServerJobFinished: (action: ReadingBulkAction) => void;
}) {
  // Where the provider can list the whole lane, as Gmail can.
  const accounts = useMemo(() => {
    const scope = readingQuery
      ? getMatchingScope(readingQuery, provider)
      : null;
    // The lane holds conversations, so its job acts on them whole.
    return scope
      ? [{ id: emailAccountId, scope: { ...scope, wholeConversations: true } }]
      : null;
  }, [emailAccountId, readingQuery, provider]);
  const matching = useSelectAllMatching({
    accounts,
    viewIdentity: "reading-lane",
    selection: NO_SELECTION,
    allPageSelected: false,
    hasMore: false,
    onFinished: () => undefined,
  });
  const [jobRunning, setJobRunning] = useState(false);
  // Set at once on a press, so a second press before the busy state renders
  // starts nothing.
  const runningRef = useRef(false);
  const [drain, setDrain] = useState<{
    action: ReadingBulkAction;
    pages: number;
  } | null>(null);

  // One page at a time, each once the last (or a scroll's own load) has
  // rendered, so a page in flight is waited for rather than counted.
  useEffect(() => {
    if (!drain) return;
    if (!readingQuery) {
      runningRef.current = false;
      setDrain(null);
      toast.message(
        `${ACTION_NAMES[drain.action]} stopped when you left Reading.`,
      );
      return;
    }
    if (isLoadingMore) return;
    if (hasMore && drain.pages < MAX_READING_DRAIN_PAGES) {
      setDrain({ ...drain, pages: drain.pages + 1 });
      loadMore().catch(() => undefined);
      return;
    }
    runningRef.current = false;
    setDrain(null);
    applyLoaded(drain.action, hasMore);
  }, [drain, readingQuery, isLoadingMore, hasMore, loadMore, applyLoaded]);

  const run = useStableCallback(async (action: ReadingBulkAction) => {
    if (runningRef.current) return;
    const plan = getReadingBulkPlan({ hasMore, canMatch: Boolean(accounts) });
    if (plan === "loaded") return applyLoaded(action, false);
    runningRef.current = true;
    if (plan === "drain") return setDrain({ action, pages: 0 });
    setJobRunning(true);
    try {
      const applied = await matching.run(
        action === "read" ? "mark_read" : "archive",
      );
      if (applied > 0) onServerJobFinished(action);
    } catch {
      toast.error("Couldn't start that. Please try again.");
    } finally {
      runningRef.current = false;
      setJobRunning(false);
    }
  });

  return { run, busy: Boolean(drain) || jobRunning };
}
