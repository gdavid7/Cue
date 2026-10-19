"use client";

import {
  MailListToolbarSurface,
  MailSearchSurface,
} from "@inboxzero/mail-ui/MailListToolbarSurface";
import {
  memo,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  ColumnsIcon,
  MailIcon,
  MailOpenIcon,
  RowsIcon,
  SearchIcon,
  SparklesIcon,
  StarIcon,
  StarOffIcon,
  TagIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { MailTitlebarNav } from "@/app/(app)/[emailAccountId]/mail/MailTitlebarNav";
import { MailSearchFiltersForm } from "@/app/(app)/[emailAccountId]/mail/MailSearchFilters";
import { OutlookSearchFiltersForm } from "@/app/(app)/[emailAccountId]/mail/OutlookSearchFilters";
import {
  MailSearchSuggestionList,
  suggestionOptionId,
  useMailSearchSuggestions,
} from "@/app/(app)/[emailAccountId]/mail/MailSearchSuggestions";
import {
  readRecentSearches,
  rememberRecentSearch,
} from "@/store/mail-search-history";
import { parseMailSearchQuery } from "@/app/(app)/[emailAccountId]/mail/mail-search-query";
import { parseOutlookSearchQuery } from "@/app/(app)/[emailAccountId]/mail/outlook-search-query";
import type { MailLayoutMode } from "@/app/(app)/[emailAccountId]/mail/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getShortcutHint } from "@/lib/shortcuts/registry";
import { Tooltip } from "@/components/Tooltip";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAccount } from "@/providers/EmailAccountProvider";
import { cn } from "@/utils";

export type ListToolbarProps = {
  layout: MailLayoutMode;
  isDesktopApp: boolean;
  /** Names the view when it isn't the inbox, e.g. "Sent" or "Search results". */
  viewTitle?: string | null;
  showLayoutToggle?: boolean;
  expandedPreview: boolean;
  /** Committed search query. */
  searchQuery: string;
  onSearch: (query: string) => void;
  searchValue: string;
  onSearchChange: (query: string) => void;
  /** Lets `/` focus the mail search field from the shortcut handler. */
  searchInputRef?: RefObject<HTMLInputElement | null>;
  /** Gmail labels or Outlook categories offered in the Search dropdown. */
  searchLabels?: { name: string }[];
  searchFolders?: { name: string }[];
  searchVariant?: "gmail" | "outlook" | "common";
  onToggleLayout: () => void;
  onTogglePreview: () => void;
  onToggleAssistant: () => void;
  /** Rendered here only when the split tabs row isn't showing to hold it. */
  selectAll?: ReactNode;
  selectedCount: number;
  /** Replaces "N selected", e.g. once every matching conversation is. */
  selectionLabel?: string;
  onArchiveSelected: () => void;
  /** Set when every selected conversation is already archived; replaces Archive. */
  onMoveToInboxSelected?: () => void;
  onDeleteSelected: () => void;
  /** Names Delete when it deletes for good rather than moving to Trash. */
  deleteLabel?: string;
  isUnreadSelected: boolean;
  onMarkReadSelected: () => void;
  onMarkUnreadSelected: () => void;
  /** True when every selected conversation is already starred. */
  isStarredSelected: boolean;
  /** Omitted when the selection can't be starred, such as a whole view. */
  onStarSelected?: () => void;
  /** Omitted when the current view can't label (combined inboxes). */
  onLabelSelected?: () => void;
  /** Shown on a disabled Label button when the selection can't be labelled. */
  labelUnavailableReason?: string;
  onClearSelection: () => void;
};

export const ListToolbar = memo(function ListToolbar({
  layout,
  isDesktopApp,
  viewTitle,
  showLayoutToggle = true,
  expandedPreview,
  searchQuery = "",
  onSearch,
  onSearchChange,
  searchValue,
  searchInputRef,
  searchLabels,
  searchFolders,
  searchVariant = "gmail",
  onToggleLayout,
  onTogglePreview,
  onToggleAssistant,
  selectAll,
  selectedCount,
  selectionLabel,
  onArchiveSelected,
  onMoveToInboxSelected,
  onDeleteSelected,
  deleteLabel,
  isUnreadSelected,
  onMarkReadSelected,
  onMarkUnreadSelected,
  isStarredSelected,
  onStarSelected,
  onLabelSelected,
  labelUnavailableReason,
  onClearSelection,
}: ListToolbarProps) {
  const LayoutIcon = layout === "split" ? ColumnsIcon : RowsIcon;

  return (
    <MailListToolbarSurface>
      <MailTitlebarNav showHistory={isDesktopApp} />
      {selectAll}
      {viewTitle && selectedCount === 0 ? (
        <h1 className="max-w-[40%] shrink-0 truncate font-semibold text-sm">
          {viewTitle}
        </h1>
      ) : null}

      {/* Selection swaps the toolbar's controls in place so the list never
          shifts down to make room for a new row. */}
      {selectedCount > 0 ? (
        <>
          <span
            aria-live="polite"
            className="min-w-0 flex-1 truncate font-medium text-sm"
          >
            {selectionLabel ?? `${selectedCount} selected`}
          </span>

          {onMoveToInboxSelected ? (
            <Tooltip content="Move to inbox">
              <button
                type="button"
                onClick={onMoveToInboxSelected}
                aria-label="Move to inbox"
                className={selectionButton}
              >
                <ArchiveRestoreIcon className="size-3.5" />
              </button>
            </Tooltip>
          ) : (
            <Tooltip shortcuts={["archive"]}>
              <button
                type="button"
                onClick={onArchiveSelected}
                aria-label="Archive"
                className={selectionButton}
              >
                <ArchiveIcon className="size-3.5" />
              </button>
            </Tooltip>
          )}

          <Tooltip
            content={isUnreadSelected ? "Mark as read" : undefined}
            shortcuts={isUnreadSelected ? undefined : ["markUnread"]}
          >
            <button
              type="button"
              onClick={
                isUnreadSelected ? onMarkReadSelected : onMarkUnreadSelected
              }
              aria-label={isUnreadSelected ? "Mark as read" : "Mark as unread"}
              className={selectionButton}
            >
              {isUnreadSelected ? (
                <MailOpenIcon className="size-3.5" />
              ) : (
                <MailIcon className="size-3.5" />
              )}
            </button>
          </Tooltip>

          {onStarSelected ? (
            <Tooltip shortcuts={["star"]}>
              <button
                type="button"
                onClick={onStarSelected}
                aria-label={isStarredSelected ? "Unstar" : "Star"}
                className={selectionButton}
              >
                {isStarredSelected ? (
                  <StarOffIcon className="size-3.5" />
                ) : (
                  <StarIcon className="size-3.5" />
                )}
              </button>
            </Tooltip>
          ) : null}

          <Tooltip
            content={deleteLabel}
            shortcuts={deleteLabel ? undefined : ["delete"]}
          >
            <button
              type="button"
              onClick={onDeleteSelected}
              aria-label={deleteLabel ?? "Delete"}
              className={cn(
                selectionButton,
                "hover:bg-destructive/10 hover:text-destructive",
              )}
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </Tooltip>

          {onLabelSelected ? (
            <Tooltip shortcuts={["label"]}>
              <button
                type="button"
                onClick={onLabelSelected}
                aria-label="Label"
                className={selectionButton}
              >
                <TagIcon className="size-3.5" />
              </button>
            </Tooltip>
          ) : labelUnavailableReason ? (
            <Tooltip content={labelUnavailableReason}>
              <button
                type="button"
                aria-disabled="true"
                aria-label="Label"
                className={cn(selectionButton, "cursor-default opacity-40")}
              >
                <TagIcon className="size-3.5" />
              </button>
            </Tooltip>
          ) : null}

          <Tooltip shortcuts={[{ id: "backToList", label: "Clear selection" }]}>
            <button
              type="button"
              onClick={onClearSelection}
              aria-label="Clear selection"
              className={selectionButton}
            >
              <XIcon className="size-3.5" />
            </button>
          </Tooltip>
        </>
      ) : (
        <MailSearchInput
          // Reset the advanced-search form when the committed query changes.
          key={searchQuery}
          searchQuery={searchQuery}
          onSearch={onSearch}
          onSearchChange={onSearchChange}
          searchValue={searchValue}
          inputRef={searchInputRef}
          searchLabels={searchLabels}
          searchFolders={searchFolders}
          searchVariant={searchVariant}
        />
      )}

      {/* How the list looks is a desk-sized choice: phones always get the
          plain list, so the menu stays out of their way. */}
      {selectedCount === 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="View options"
              className="hidden h-8 gap-1.5 px-2 text-muted-foreground lg:inline-flex"
              size="sm"
              type="button"
              variant="outline"
            >
              <LayoutIcon className="size-3.5" />
              {layout === "list" ? "View" : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuCheckboxItem
              checked={expandedPreview}
              onCheckedChange={onTogglePreview}
            >
              Longer previews
              <DropdownMenuShortcut>
                {getShortcutHint("togglePreview")}
              </DropdownMenuShortcut>
            </DropdownMenuCheckboxItem>
            {showLayoutToggle ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
                  Layout
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={layout}
                  onValueChange={(value) => {
                    if (value !== layout) onToggleLayout();
                  }}
                >
                  <DropdownMenuRadioItem value="list">
                    List
                    <DropdownMenuShortcut>
                      {layout === "split"
                        ? getShortcutHint("toggleLayout")
                        : null}
                    </DropdownMenuShortcut>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="split">
                    Split
                    <DropdownMenuShortcut>
                      {layout === "list"
                        ? getShortcutHint("toggleLayout")
                        : null}
                    </DropdownMenuShortcut>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {selectedCount === 0 ? (
        <Button
          aria-label="Ask Cue"
          // A 44px hit area on touchscreens without a bigger toolbar.
          className="relative h-8 gap-1.5 px-2 text-muted-foreground max-sm:w-8 max-sm:px-0 pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5 pointer-coarse:after:content-['']"
          onClick={onToggleAssistant}
          size="sm"
          type="button"
          variant="outline"
        >
          <SparklesIcon className="size-3.5" />
          {layout === "list" ? (
            <span className="max-sm:sr-only">Ask Cue</span>
          ) : null}
        </Button>
      ) : null}
    </MailListToolbarSurface>
  );
});

function MailSearchInput({
  searchQuery,
  onSearch,
  onSearchChange,
  searchValue,
  inputRef: inputRefProp,
  searchLabels = [],
  searchFolders = [],
  searchVariant = "gmail",
}: {
  searchQuery: string;
  onSearch: (query: string) => void;
  searchValue: string;
  onSearchChange: (query: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  searchLabels?: { name: string }[];
  searchFolders?: { name: string }[];
  searchVariant?: "gmail" | "outlook" | "common";
}) {
  const localRef = useRef<HTMLInputElement>(null);
  const inputRef = inputRefProp ?? localRef;
  const { emailAccountId } = useAccount();
  const suggestionListId = useId();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState(searchQuery);
  const draft = searchValue;
  const [focused, setFocused] = useState(false);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  const suggestions = useMailSearchSuggestions({
    draft,
    emailAccountId,
    enabled: focused && !filtersOpen && !suggestionsDismissed,
    recentSearches,
  });
  const suggestionsOpen = suggestions.length > 0;
  const highlightedIndex = activeIndex < suggestions.length ? activeIndex : -1;

  const commitSearch = (query: string) => {
    const trimmed = query.trim();
    if (trimmed) rememberRecentSearch(emailAccountId, trimmed);
    onSearch(trimmed);
  };

  return (
    <Popover
      modal
      open={filtersOpen}
      onOpenChange={(open) => {
        if (open) setFilterDraft(draft);
        setFiltersOpen(open);
      }}
    >
      <PopoverAnchor asChild>
        <MailSearchSurface
          active={filtersOpen}
          searchIcon={<SearchIcon className="size-3.5 shrink-0" />}
          onSubmit={(event) => {
            event.preventDefault();
            commitSearch(draft);
          }}
          controls={
            <>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Show search options"
                  aria-expanded={filtersOpen}
                  // Wider on touchscreens, and 44px tall through the
                  // toolbar's padding, so it's hard to hit by mistake when
                  // aiming for the field beside it.
                  className={cn(
                    "relative flex h-full w-7 shrink-0 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:w-11 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-1.5 pointer-coarse:after:inset-x-0 pointer-coarse:after:content-['']",
                    filtersOpen && "text-foreground",
                  )}
                >
                  <ChevronDownIcon
                    className={cn(
                      "size-3.5 transition-transform",
                      filtersOpen && "rotate-180",
                    )}
                  />
                </button>
              </PopoverTrigger>
              {suggestionsOpen ? (
                <MailSearchSuggestionList
                  activeIndex={highlightedIndex}
                  id={suggestionListId}
                  onSelect={(suggestion) => commitSearch(suggestion.query)}
                  suggestions={suggestions}
                />
              ) : null}
            </>
          }
        >
          <input
            ref={inputRef}
            value={draft}
            placeholder="Search mail or ask Cue"
            enterKeyHint="search"
            role="combobox"
            aria-label="Search mail"
            aria-autocomplete="list"
            aria-expanded={suggestionsOpen}
            aria-controls={suggestionsOpen ? suggestionListId : undefined}
            aria-activedescendant={
              highlightedIndex >= 0
                ? suggestionOptionId(suggestionListId, highlightedIndex)
                : undefined
            }
            // The forms plugin sizes untyped inputs at 1rem, so the size has
            // to be stated for the field to match the rest of the toolbar.
            // Phones keep 16px: iOS zooms into a focused field below that.
            // On touchscreens the field reaches 44px into the toolbar's
            // padding, so the tap target is bigger than the box drawn.
            className="h-full min-w-0 flex-1 border-0 pointer-coarse:h-11 bg-transparent p-0 text-base text-foreground outline-none md:text-sm focus:ring-0 placeholder:text-muted-foreground"
            onChange={(event) => {
              onSearchChange(event.target.value);
              setActiveIndex(-1);
              setSuggestionsDismissed(false);
            }}
            onFocus={() => {
              setRecentSearches(readRecentSearches(emailAccountId));
              setFocused(true);
            }}
            onBlur={() => {
              setFocused(false);
              setActiveIndex(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && suggestionsOpen) {
                event.preventDefault();
                setActiveIndex(
                  Math.min(highlightedIndex + 1, suggestions.length - 1),
                );
                return;
              }
              if (event.key === "ArrowUp" && suggestionsOpen) {
                event.preventDefault();
                setActiveIndex(Math.max(highlightedIndex - 1, -1));
                return;
              }
              if (event.key === "Enter" && highlightedIndex >= 0) {
                event.preventDefault();
                commitSearch(suggestions[highlightedIndex].query);
                return;
              }
              if (event.key !== "Escape") return;
              // The mail-wide Escape shortcut also clears the search, so a
              // press handled here must not reach it.
              if (suggestionsOpen || filtersOpen || draft || searchQuery) {
                event.preventDefault();
              }
              if (suggestionsOpen) {
                setSuggestionsDismissed(true);
                setActiveIndex(-1);
                return;
              }
              if (filtersOpen) {
                setFiltersOpen(false);
                return;
              }
              if (draft || searchQuery) {
                onSearchChange("");
                onSearch("");
              } else {
                inputRef.current?.blur();
              }
            }}
          />
          {draft || searchQuery ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onSearch("")}
              className="shrink-0 rounded p-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </MailSearchSurface>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[min(34rem,calc(100vw-1.5rem))] p-4"
        onPointerDownOutside={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest("[data-radix-select-viewport]")) {
            event.preventDefault();
          }
        }}
      >
        {filtersOpen ? (
          <AdvancedSearchForm
            filterDraft={filterDraft}
            searchFolders={searchFolders}
            searchLabels={searchLabels}
            searchVariant={searchVariant}
            onSearch={(query) => {
              commitSearch(query);
              setFiltersOpen(false);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function AdvancedSearchForm({
  filterDraft,
  searchFolders,
  searchLabels,
  searchVariant,
  onSearch,
}: {
  filterDraft: string;
  searchFolders: { name: string }[];
  searchLabels: { name: string }[];
  searchVariant: "gmail" | "outlook" | "common";
  onSearch: (query: string) => void;
}) {
  if (searchVariant === "outlook") {
    return (
      <OutlookSearchFiltersForm
        key={filterDraft}
        initialFields={parseOutlookSearchQuery(filterDraft)}
        folders={searchFolders}
        categories={searchLabels}
        onSearch={onSearch}
      />
    );
  }

  return (
    <MailSearchFiltersForm
      key={filterDraft}
      initialFields={parseMailSearchQuery(filterDraft)}
      extraLocations={searchLabels}
      variant={searchVariant === "common" ? "common" : "gmail"}
      onSearch={onSearch}
    />
  );
}

const toolbarButton =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

// Touch-sized below `lg`, where selection is how a phone triages.
const selectionButton = cn(
  toolbarButton,
  "w-8 justify-center px-0 max-lg:size-11",
);
