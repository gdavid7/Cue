import { isGoogleProvider } from "@/utils/email/provider-types";
import { GmailLabel } from "@/utils/gmail/label";
import { formatDateGroupLabel } from "@/utils/date";
import { getThreadTimestamp } from "@/utils/threads/sort";

export const THREAD_PREFETCH_REMAINING = 8;
export const THREAD_SCROLL_PADDING_PX = 8;
export const THREAD_LOAD_MORE_ROOT_MARGIN = "400px 0px";

export function getActiveThreadIndex({
  threadIds,
  focusedIndex,
  openThreadId,
}: {
  threadIds: string[];
  focusedIndex: number;
  openThreadId: string | null;
}): number {
  const clampedFocusedIndex = Math.min(
    Math.max(0, focusedIndex),
    Math.max(0, threadIds.length - 1),
  );
  if (!openThreadId) return clampedFocusedIndex;

  const openThreadIndex = threadIds.indexOf(openThreadId);
  return openThreadIndex;
}

export function getSearchFocus({
  previous,
  view,
  focusedIndex,
  orderedIds,
}: {
  previous?: { view: string | null; key?: string; index: number };
  view: string | null;
  focusedIndex: number;
  orderedIds: string[];
}) {
  let nextIndex = focusedIndex;
  if (
    view &&
    previous?.view === view &&
    previous.index === focusedIndex &&
    previous.key
  ) {
    if (!orderedIds.length) return previous;
    const retainedIndex = orderedIds.indexOf(previous.key);
    // A retained row that is gone from a shorter result set would otherwise
    // leave the cursor past the end, where appended rows later land on an
    // unrelated thread.
    nextIndex =
      retainedIndex >= 0
        ? retainedIndex
        : Math.min(nextIndex, orderedIds.length - 1);
  }
  return { view, key: orderedIds[nextIndex], index: nextIndex };
}

export function resolveThreadActionTargets<T extends { key: string }>({
  focusedKey,
  listTargets,
  openTarget,
  selectedKeys,
}: {
  focusedKey: string | undefined;
  listTargets: T[];
  openTarget: T | undefined;
  selectedKeys: string[];
}): T[] {
  const targetsByKey = new Map(
    listTargets.map((target) => [target.key, target]),
  );

  if (openTarget && !targetsByKey.has(openTarget.key)) return [openTarget];
  if (selectedKeys.length) {
    return selectedKeys.flatMap((key) => {
      const target = targetsByKey.get(key);
      return target ? [target] : [];
    });
  }
  if (openTarget) return [targetsByKey.get(openTarget.key) ?? openTarget];
  const focusedTarget = focusedKey ? targetsByKey.get(focusedKey) : undefined;
  return focusedTarget ? [focusedTarget] : [];
}

/** Importance is a Gmail concept; other providers have nothing to set. */
export function canMarkThreadsImportant({
  provider,
  mixedAccounts,
}: {
  provider: string | null | undefined;
  mixedAccounts: boolean;
}) {
  return isGoogleProvider(provider) && !mixedAccounts;
}

export function getNextThreadAfterRemoval({
  threadIds,
  currentThreadId,
  currentThreadIndex,
  removedThreadIds,
  direction = "next",
}: {
  threadIds: string[];
  currentThreadId: string;
  currentThreadIndex: number;
  removedThreadIds: string[];
  /** Which side to prefer; the other side is the fallback. */
  direction?: "next" | "previous";
}): { id: string; index: number } | null {
  const currentIndex = threadIds.indexOf(currentThreadId);

  const removed = new Set(removedThreadIds);
  const findSurvivor = (from: number, step: 1 | -1) => {
    for (
      let index = from;
      index >= 0 && index < threadIds.length;
      index += step
    ) {
      const threadId = threadIds[index];
      if (threadId && !removed.has(threadId)) return threadId;
    }
  };

  let nextThreadId: string | undefined;
  if (direction === "previous") {
    // The topmost removed row bounds the search, so a multi-selection never
    // lands on a row the same action archived.
    const removedIndexes = [currentThreadId, ...removedThreadIds]
      .map((id) => threadIds.indexOf(id))
      .filter((index) => index >= 0);
    const topmost = removedIndexes.length
      ? Math.min(...removedIndexes)
      : currentThreadIndex;
    nextThreadId =
      findSurvivor(topmost - 1, -1) ?? findSurvivor(topmost + 1, 1);
  } else {
    const nextIndex =
      currentIndex >= 0 ? currentIndex + 1 : Math.max(0, currentThreadIndex);
    nextThreadId = findSurvivor(nextIndex, 1);
    if (!nextThreadId) {
      const previousIndex =
        currentIndex >= 0
          ? currentIndex - 1
          : Math.min(currentThreadIndex - 1, threadIds.length - 1);
      nextThreadId = findSurvivor(previousIndex, -1);
    }
  }
  if (!nextThreadId) return null;

  const remainingThreadIds = threadIds.filter(
    (threadId) => !removed.has(threadId),
  );
  return {
    id: nextThreadId,
    index: remainingThreadIds.indexOf(nextThreadId),
  };
}

export function shouldPrefetchMoreThreads({
  hasMore,
  isLoadingMore,
  focusedIndex,
  threadCount,
  remainingThreshold = THREAD_PREFETCH_REMAINING,
}: {
  hasMore: boolean;
  isLoadingMore: boolean;
  focusedIndex: number;
  threadCount: number;
  remainingThreshold?: number;
}): boolean {
  if (!hasMore || isLoadingMore || threadCount === 0) return false;
  return focusedIndex >= threadCount - remainingThreshold;
}

export function scrollElementIntoContainer(
  container: HTMLElement,
  element: HTMLElement,
  padding = THREAD_SCROLL_PADDING_PX,
): void {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();

  const topOverflow = containerRect.top + padding - elementRect.top;
  const bottomOverflow = elementRect.bottom - (containerRect.bottom - padding);

  if (topOverflow > 0) {
    container.scrollTop -= topOverflow;
  } else if (bottomOverflow > 0) {
    container.scrollTop += bottomOverflow;
  }
}

/**
 * Splits a date-ordered list into consecutive runs that share a date heading,
 * keeping each thread's position in the flat list so selection and focus stay
 * index-addressed. Runs are dated with the same timestamp the list is sorted
 * by, so a heading can never disagree with where its rows sit; undated threads
 * get no heading rather than a fabricated one.
 */
export function groupThreadsByDate<
  T extends { messages: Array<{ internalDate?: string | null }> },
>(threads: T[], now?: Date) {
  const groups: {
    label: string | null;
    startIndex: number;
    threads: T[];
  }[] = [];

  threads.forEach((thread, index) => {
    const timestamp = getThreadTimestamp(thread);
    const label = timestamp
      ? formatDateGroupLabel(new Date(timestamp), now)
      : null;

    const openGroup = groups.at(-1);
    if (openGroup?.label === label) openGroup.threads.push(thread);
    else groups.push({ label, startIndex: index, threads: [thread] });
  });

  return groups;
}

export function getComposeTargetMessageId(
  messages: { id: string; labelIds?: string[] }[],
) {
  return (
    messages.findLast(
      (message) => !message.labelIds?.includes(GmailLabel.DRAFT),
    ) ?? messages.at(-1)
  )?.id;
}
