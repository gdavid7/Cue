"use client";

import { SparklesIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type {
  CueSearchIntent,
  CueSearchStage,
} from "@/app/(app)/[emailAccountId]/mail/cue-search";
import { PlaceholderRow } from "@/app/(app)/[emailAccountId]/mail/MailListPlaceholder";
import { ThreadRow } from "@/app/(app)/[emailAccountId]/mail/ThreadRow";
import {
  getListThreadKey,
  type ListThread,
  type MailLayoutMode,
} from "@/app/(app)/[emailAccountId]/mail/types";
import { useStableCallback } from "@/app/(app)/[emailAccountId]/mail/use-stable-callback";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import type { EmailLabels } from "@/providers/email-label-types";
import { describeSearch } from "@/utils/mail-search/describe-search";
import { readableSearch } from "@/utils/mail-search/generated-search";

const VISIBLE_ROWS = 3;
const PLACEHOLDER_WIDTHS = ["w-3/4", "w-2/3", "w-5/6"];
const NOOP = () => undefined;

/**
 * What Cue found for a search typed as a sentence, above the plain results.
 * It holds its rows' space while it reads the search, and when it ends up
 * smaller, or with nothing to show, it eases to its new height rather than
 * jumping. The line saying how Cue read the search opens the searches it
 * ran, each of which can be edited in the search box.
 */
export function CueFoundSection({
  stage,
  intent,
  widerSearches,
  threads,
  foundNothing,
  allInPlainResults,
  layout,
  expandedPreview,
  userEmail,
  userLabels,
  onOpenThread,
  onEditSearch,
}: {
  /** "off" closes the section: Cue gave nothing to search. */
  stage: CueSearchStage;
  intent: CueSearchIntent | null;
  widerSearches: string[];
  threads: ListThread[];
  /** Cue's searches have all answered with no mail. */
  foundNothing: boolean;
  /** Cue found mail, all of it already among the first plain results. */
  allInPlainResults: boolean;
  layout: MailLayoutMode;
  expandedPreview: boolean;
  userEmail: string;
  userLabels: EmailLabels;
  onOpenThread: (thread: ListThread) => void;
  onEditSearch: (search: string) => void;
}) {
  const isMobile = useIsMobile();
  const [showAll, setShowAll] = useState(false);
  const [showSearches, setShowSearches] = useState(false);
  const pending = stage !== "done";
  const visible = showAll ? threads : threads.slice(0, VISIBLE_ROWS);
  const placeholders = pending
    ? PLACEHOLDER_WIDTHS.slice(0, Math.max(0, VISIBLE_ROWS - visible.length))
    : [];
  const openAt = useStableCallback((index: number) => {
    const thread = visible[index];
    if (thread) onOpenThread(thread);
  });
  const searches = intent
    ? [...intent.searches, ...widerSearches].map((search, index) => ({
        // What the search box takes back, with days it can read.
        edit:
          intent.editableSearches[index] ??
          readableSearch(search, intent.timeZone),
        label: describeSearch(search, { timeZone: intent.timeZone }),
      }))
    : [];

  return (
    <EaseHeight>
      {stage === "off" ? null : (
        <section aria-label="Cue found" className="border-border border-b">
          <div className="flex min-h-9 items-center gap-2 px-4 pt-2 text-sm">
            <SparklesIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="shrink-0 font-medium text-foreground">
              Cue found
            </span>
            {intent ? (
              <button
                aria-expanded={showSearches}
                className="min-w-0 truncate text-left text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => setShowSearches((open) => !open)}
                title="Show the searches Cue ran"
                type="button"
              >
                {intent.explanation || "Show the searches Cue ran"}
                {widerSearches.length ? " · searched more widely" : ""}
              </button>
            ) : (
              <span className="text-muted-foreground" role="status">
                Reading your search…
              </span>
            )}
          </div>
          {showSearches && searches.length ? (
            <div className="px-4 pt-1 pb-2">
              <p className="text-muted-foreground text-xs">
                Cue ran these searches. Pick one to edit it.
              </p>
              <ul className="mt-1 flex flex-col items-start gap-0.5">
                {searches.map(({ edit, label }) => (
                  <li className="max-w-full" key={edit}>
                    <button
                      className="max-w-full truncate rounded px-1 py-0.5 text-left font-mono text-foreground text-xs hover:bg-muted"
                      onClick={() => onEditSearch(edit)}
                      type="button"
                    >
                      {label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {/* Rows are options, which need a listbox around them. */}
          <div
            aria-label="Mail Cue found"
            className="flex flex-col"
            role="listbox"
          >
            {visible.map((thread, index) => (
              <ThreadRow
                compact={isMobile}
                expandedPreview={expandedPreview}
                hasAnySelection={false}
                index={index}
                isFocused={false}
                isSelected={false}
                key={getListThreadKey(thread)}
                layout={layout}
                onOpen={openAt}
                onSelectRangeTo={NOOP}
                onToggleSelect={NOOP}
                selectionEnabled={false}
                thread={thread}
                userEmail={userEmail}
                userLabels={userLabels}
              />
            ))}
            {placeholders.length ? (
              <div aria-hidden>
                {placeholders.map((width) => (
                  <PlaceholderRow key={width} layout={layout} width={width} />
                ))}
              </div>
            ) : null}
          </div>
          {foundNothing ? (
            <p className="px-4 pb-3 text-muted-foreground text-sm">
              No mail matched Cue&apos;s searches.
            </p>
          ) : null}
          {allInPlainResults && !pending ? (
            <p className="px-4 pb-3 text-muted-foreground text-sm">
              Cue&apos;s matches are in the results below.
            </p>
          ) : null}
          {threads.length > VISIBLE_ROWS ? (
            <Button
              className="mx-2 my-1"
              onClick={() => setShowAll((all) => !all)}
              size="xs-2"
              type="button"
              variant="ghostMuted"
            >
              {showAll ? "Show fewer" : `Show all ${threads.length}`}
            </Button>
          ) : null}
        </section>
      )}
    </EaseHeight>
  );
}

/**
 * Follows its content's height with a short transition, so what's below
 * slides instead of jumping. Instant with reduced motion.
 */
function EaseHeight({ children }: { children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const measure = () => setHeight(inner.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      className="overflow-hidden transition-[height] duration-150 ease-out motion-reduce:transition-none"
      style={{ height }}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
}
