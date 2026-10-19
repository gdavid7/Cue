"use client";

import { getMatchingBannerCopy } from "@/app/(app)/[emailAccountId]/mail/select-all-matching";

/**
 * Sits under the toolbar once every row on the page is selected, the way
 * Gmail offers the rest of the view, and says when all of it is selected.
 */
export function SelectAllMatchingBanner({
  pageCount,
  total,
  viewTitle,
  isSearch,
  active,
  onSelectAll,
  onClear,
}: {
  pageCount: number;
  total: number | null;
  viewTitle: string;
  isSearch: boolean;
  active: boolean;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const copy = getMatchingBannerCopy({
    pageCount,
    total,
    viewTitle,
    isSearch,
    active,
  });

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-border border-b bg-muted/60 px-4 py-2 text-center text-sm"
    >
      <span>{copy.message}</span>
      <button
        type="button"
        onClick={active ? onClear : onSelectAll}
        // 44px tall on touchscreens without growing the row.
        className="relative rounded font-medium text-blue-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-blue-400 pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']"
      >
        {copy.action}
      </button>
    </div>
  );
}
