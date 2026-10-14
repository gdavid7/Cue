"use client";

import {
  ArchiveIcon,
  ClockIcon,
  InboxIcon,
  type LucideIcon,
  MailIcon,
  MailOpenIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { getSnoozePresets } from "@/app/(app)/[emailAccountId]/mail/snooze-command-palette";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/utils";

export type ThreadRowActionHandlers = {
  archive: (threadKey: string) => void;
  moveToInbox: (threadKey: string) => void;
  trash: (threadKey: string) => void;
  setRead: (threadKey: string, read: boolean) => void;
  setStarred: (threadKey: string, starred: boolean) => void;
  snooze: (threadKey: string, until: Date) => void;
};

/**
 * Gmail's hover actions for one row: archive (or back to the inbox), delete,
 * read state, star and snooze, without opening or selecting the thread.
 * A mouse shortcut: the same actions are in the toolbar and on the keyboard,
 * so these stay out of the tab order rather than add five tab stops per row.
 * They sit beside the row's `role="option"`, so assistive tech still finds
 * them as named buttons.
 */
export function ThreadRowActions({
  threadKey,
  isArchived,
  isUnread,
  isStarred,
  handlers,
}: {
  threadKey: string;
  isArchived: boolean;
  isUnread: boolean;
  isStarred: boolean;
  handlers: ThreadRowActionHandlers;
}) {
  return (
    // Stops clicks from reaching the row, which would open the thread.
    <div
      className="flex items-center gap-0.5"
      data-testid="thread-row-actions"
      onClick={stop}
      // Enter on an action is that action, not "open the conversation".
      onKeyDown={stop}
    >
      {isArchived ? (
        <RowButton
          icon={InboxIcon}
          label="Move to inbox"
          ariaLabel="Move conversation to inbox"
          onClick={() => handlers.moveToInbox(threadKey)}
        />
      ) : (
        <RowButton
          icon={ArchiveIcon}
          label="Archive"
          ariaLabel="Archive conversation"
          onClick={() => handlers.archive(threadKey)}
        />
      )}
      <RowButton
        icon={Trash2Icon}
        label="Delete"
        ariaLabel="Delete conversation"
        onClick={() => handlers.trash(threadKey)}
      />
      <RowButton
        icon={isUnread ? MailOpenIcon : MailIcon}
        label={isUnread ? "Mark as read" : "Mark as unread"}
        ariaLabel={
          isUnread ? "Mark conversation as read" : "Mark conversation as unread"
        }
        onClick={() => handlers.setRead(threadKey, isUnread)}
      />
      <RowButton
        active={isStarred}
        icon={StarIcon}
        label={isStarred ? "Unstar" : "Star"}
        ariaLabel={isStarred ? "Unstar conversation" : "Star conversation"}
        onClick={() => handlers.setStarred(threadKey, !isStarred)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={BUTTON_CLASS}
            aria-label="Snooze conversation"
            tabIndex={-1}
            title="Snooze"
            type="button"
          >
            <ClockIcon className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={stop}>
          {getSnoozePresets(new Date()).map((preset) => (
            <DropdownMenuItem
              key={preset.id}
              onSelect={() => handlers.snooze(threadKey, preset.until)}
            >
              {preset.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const BUTTON_CLASS =
  "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

// The accessible name says "conversation" so it stays distinct from the
// toolbar's button for the same action.
export function RowButton({
  icon: Icon,
  label,
  ariaLabel,
  onClick,
  active,
}: {
  icon: LucideIcon;
  label: string;
  ariaLabel: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      className={BUTTON_CLASS}
      aria-label={ariaLabel}
      onClick={onClick}
      tabIndex={-1}
      title={label}
      type="button"
    >
      <Icon
        className={cn("size-4", active && "fill-yellow-400 text-yellow-500")}
      />
    </button>
  );
}

function stop(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}
