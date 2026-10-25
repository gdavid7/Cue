"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { BracesIcon, CalendarClockIcon } from "lucide-react";
import { cn } from "@/utils";
import {
  filterSnippets,
  initialSnippetSelectionIndex,
  normalizeSnippetQuery,
  snippetPreview,
  type SnippetMatchItem,
} from "@/utils/snippets/match-snippets";

export type SnippetPickerRef = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

type SnippetPickerProps = {
  // Shows "Ask Cue" as the first row, for writing with Cue instead.
  onSelectAsk?: () => void;
  // Shows "Share my free times" under it, while the query could name it.
  onSelectFreeTimes?: () => void;
  onQueryChange?: (query: string) => void;
  onSelectCreate: () => void;
  onSelectSnippet: (snippet: SnippetMatchItem) => void;
  query: string;
  snippets: SnippetMatchItem[];
};

export const SnippetPicker = forwardRef<SnippetPickerRef, SnippetPickerProps>(
  function SnippetPicker(
    {
      onQueryChange,
      onSelectAsk,
      onSelectCreate,
      onSelectFreeTimes,
      onSelectSnippet,
      query,
      snippets,
    },
    ref,
  ) {
    // Ask Cue and free times sit above the snippet rows without becoming the
    // default, so Enter still does what it did before.
    const askIndex = onSelectAsk ? 0 : -1;
    const showFreeTimes = Boolean(onSelectFreeTimes) && matchesFreeTimes(query);
    const freeTimesIndex = showFreeTimes ? askIndex + 1 : -1;
    const leadingRows = (onSelectAsk ? 1 : 0) + (showFreeTimes ? 1 : 0);
    const filteredSnippets = useMemo(
      () => filterSnippets(snippets, query),
      [query, snippets],
    );
    const [selectedIndex, setSelectedIndex] = useState(
      () =>
        leadingRows +
        initialSnippetSelectionIndex({
          createItem: true,
          query,
          snippets: filteredSnippets,
        }),
    );
    const itemCount = leadingRows + filteredSnippets.length + 1;

    useEffect(() => {
      setSelectedIndex(
        leadingRows +
          initialSnippetSelectionIndex({
            createItem: true,
            query,
            snippets: filteredSnippets,
          }),
      );
    }, [leadingRows, query, filteredSnippets]);

    const selectItem = (index: number) => {
      if (index === askIndex) {
        onSelectAsk?.();
        return;
      }
      if (index === freeTimesIndex) {
        onSelectFreeTimes?.();
        return;
      }
      if (index === leadingRows) {
        onSelectCreate();
        return;
      }
      const snippet = filteredSnippets[index - leadingRows - 1];
      if (snippet) onSelectSnippet(snippet);
    };

    const handleKeyDown = (event: {
      key: string;
      preventDefault: () => void;
    }) => {
      if (event.key === "ArrowUp") {
        setSelectedIndex((index) => (index + itemCount - 1) % itemCount);
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelectedIndex((index) => (index + 1) % itemCount);
        return true;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        selectItem(selectedIndex);
        return true;
      }
      return false;
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => handleKeyDown(event),
    }));

    return (
      <div
        className="z-[100] w-[22rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        data-snippet-picker=""
      >
        {onQueryChange ? (
          <input
            aria-label="Search snippets"
            className="h-10 w-full border-b bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (handleKeyDown(event)) event.preventDefault();
            }}
            placeholder="Search snippets"
            value={query}
          />
        ) : null}
        <div
          aria-label="Snippets"
          className="max-h-64 overflow-auto p-1"
          role="listbox"
        >
          {onSelectAsk ? (
            <PickerRow
              selected={selectedIndex === askIndex}
              onSelect={() => selectItem(askIndex)}
            >
              <span
                aria-hidden="true"
                className="w-4 shrink-0 text-center text-muted-foreground"
              >
                ✦
              </span>
              <span className="min-w-0 truncate">
                <span className="font-medium">Ask Cue</span>
                {query ? (
                  <span className="text-muted-foreground">: {query}…</span>
                ) : (
                  <span className="text-muted-foreground"> to write…</span>
                )}
              </span>
            </PickerRow>
          ) : null}
          {showFreeTimes ? (
            <PickerRow
              selected={selectedIndex === freeTimesIndex}
              onSelect={() => selectItem(freeTimesIndex)}
            >
              <CalendarClockIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">
                <span className="font-medium">Share my free times</span>
                <span className="text-muted-foreground">
                  {" "}
                  from your calendar
                </span>
              </span>
            </PickerRow>
          ) : null}
          <PickerRow
            selected={selectedIndex === leadingRows}
            onSelect={() => selectItem(leadingRows)}
          >
            <BracesIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-medium">Turn into snippet</span>
          </PickerRow>
          {filteredSnippets.map((snippet, index) => (
            <PickerRow
              key={snippet.id}
              selected={selectedIndex === leadingRows + index + 1}
              onSelect={() => selectItem(leadingRows + index + 1)}
            >
              <span className="w-24 shrink-0 truncate font-medium">
                /{snippet.shortcut}
              </span>
              <span className="min-w-0 truncate text-muted-foreground">
                {snippetPreview(snippet.content)}
              </span>
            </PickerRow>
          ))}
          {filteredSnippets.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {snippets.length === 0
                ? "No snippets yet. Save one to reuse it with /."
                : "No matching snippets."}
            </p>
          ) : null}
        </div>
      </div>
    );
  },
);

function PickerRow({
  children,
  onSelect,
  selected,
}: {
  children: ReactNode;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <button
      aria-selected={selected}
      className={cn(
        "flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left text-sm",
        selected && "bg-muted",
      )}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      role="option"
      type="button"
    >
      {children}
    </button>
  );
}

const FREE_TIMES_WORDS = ["share", "my", "free", "times", "availability"];

function matchesFreeTimes(query: string) {
  const normalized = normalizeSnippetQuery(query);
  return (
    !normalized || FREE_TIMES_WORDS.some((word) => word.startsWith(normalized))
  );
}
