"use client";

import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/utils";

export type MailSplitTab = {
  id: string;
  name: string;
  /** Built-in splits (e.g. All) can't be edited or removed. */
  deletable: boolean;
};

export type SplitTabsProps = {
  splits: MailSplitTab[];
  activeSplitId: string | null;
  /** Unread conversations in each split. Missing entries and zeros stay blank. */
  countsById?: ReadonlyMap<string, number>;
  onSelect: (splitId: string) => void;
  onDelete: (splitId: string) => void;
  onEdit?: (splitId: string) => void;
  onNewSplit: () => void;
  /** Split creation stays account-scoped, so it is hidden in All accounts. */
  canCreateSplits: boolean;
  /** Sits before the tabs, lined up with the row checkboxes below. */
  leading?: ReactNode;
  className?: string;
};

// Users see splits as "tabs": "split" also names the reader's layout toggle.
export function SplitTabs({
  splits,
  activeSplitId,
  countsById,
  onSelect,
  onDelete,
  onEdit,
  onNewSplit,
  canCreateSplits,
  leading,
  className,
}: SplitTabsProps) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const [deleting, setDeleting] = useState<MailSplitTab | null>(null);

  useEffect(() => {
    const tabs = tabsRef.current;
    const focusedTab = document.activeElement;
    if (
      !activeSplitId ||
      !(focusedTab instanceof HTMLButtonElement) ||
      !tabs?.contains(focusedTab) ||
      !focusedTab.hasAttribute("data-split-tab")
    ) {
      return;
    }

    activeTabRef.current?.focus({ preventScroll: true });
  }, [activeSplitId]);

  return (
    <div
      ref={tabsRef}
      className={cn(
        // Padded to sit under the toolbar's search field rather than against
        // the column edge, and ruled off so the tabs read as a header for the
        // list instead of crowding the first row. On a phone they scroll
        // sideways: a second row of tabs pushes the mail down. The right edge
        // fades so a cut-off tab reads as "more this way", and the extra end
        // padding lets the last tab scroll clear of the fade.
        "flex flex-wrap items-center gap-1 border-border border-b px-3 pb-2 max-lg:flex-nowrap max-lg:overflow-x-auto max-lg:pr-8 max-lg:[mask-image:linear-gradient(to_right,black_calc(100%_-_2rem),transparent)] max-lg:[scrollbar-width:none] [&>*]:shrink-0",
        className,
      )}
    >
      {leading ? <span className="mr-1.5 flex">{leading}</span> : null}
      {splits.map((split) => {
        const active = split.id === activeSplitId;
        const countLabel = splitCountLabel(countsById?.get(split.id));

        return (
          <span className="flex items-center" key={split.id}>
            <ContextMenu>
              <ContextMenuTrigger asChild disabled={!split.deletable}>
                <button
                  type="button"
                  ref={active ? activeTabRef : undefined}
                  data-split-tab
                  onClick={() => onSelect(split.id)}
                  // The count sits in this button, so innerText includes it.
                  // The accessible name stays the tab itself.
                  aria-label={split.name}
                  aria-current={active ? "true" : undefined}
                  aria-description={
                    countLabel ? `${countLabel} unread` : undefined
                  }
                  className={cn(
                    "flex items-center gap-1 rounded-full py-0.5 pr-2 pl-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <span data-split-name>{split.name}</span>
                  {countLabel ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "font-normal tabular-nums",
                        active ? "text-primary/70" : "opacity-70",
                      )}
                    >
                      {countLabel}
                    </span>
                  ) : null}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-44">
                {onEdit && (
                  <ContextMenuItem onSelect={() => onEdit(split.id)}>
                    Edit tab…
                  </ContextMenuItem>
                )}
                <ContextMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setDeleting(split)}
                >
                  Delete tab…
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {/* The same actions for touch and keyboard, on the open tab. */}
            {active && split.deletable && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Options for the ${split.name} tab`}
                    className="ml-0.5 flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  {onEdit && (
                    <DropdownMenuItem onSelect={() => onEdit(split.id)}>
                      Edit tab…
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setDeleting(split)}
                  >
                    Delete tab…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        );
      })}

      {canCreateSplits && (
        <button
          type="button"
          aria-label="New tab"
          onClick={onNewSplit}
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PlusIcon className="size-3.5" />
        </button>
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete the “{deleting?.name}” tab?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its mail stays in your inbox. You can add the tab again from New
              tab.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleting) onDelete(deleting.id);
                setDeleting(null);
              }}
            >
              Delete tab
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function splitCountLabel(count: number | undefined): string | null {
  if (count == null || !Number.isFinite(count) || count <= 0) return null;
  return count.toLocaleString("en-US");
}
