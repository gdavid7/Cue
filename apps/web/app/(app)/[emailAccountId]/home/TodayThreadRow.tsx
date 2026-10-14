"use client";

import {
  ArchiveIcon,
  EllipsisIcon,
  type LucideIcon,
  ReplyIcon,
} from "lucide-react";
import { MailThreadRow } from "@inboxzero/mail-ui/MailThreadRow";
import { MailLabelChip } from "@/app/(app)/[emailAccountId]/mail/MailLabelChip";
import { getSnoozePresets } from "@/app/(app)/[emailAccountId]/mail/snooze-command-palette";
import {
  RowButton,
  type ThreadRowActionHandlers,
  ThreadRowActions,
} from "@/app/(app)/[emailAccountId]/mail/ThreadRowActions";
import type { MailLayoutMode } from "@/app/(app)/[emailAccountId]/mail/types";
import { EmailDate } from "@/components/email-list/EmailDate";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/utils";
import type { HomeThread } from "@/utils/home/get-home";

export type TodayRowHandlers = ThreadRowActionHandlers & {
  open: (threadId: string) => void;
  reply: (threadId: string) => void;
};

/** Fixes Cue's call on a conversation, such as "No reply needed". */
export type TodayRowCorrection = {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
};

/**
 * One of Today's conversations, drawn and acted on like an inbox row: the
 * inbox's hover actions plus Reply on wider screens, and Reply, Archive and a
 * menu that stay visible on phones, which have no hover.
 */
export function TodayThreadRow({
  thread,
  canChange,
  layout,
  isFocused,
  waiting,
  correction,
  handlers,
}: {
  thread: HomeThread;
  /** False until the mail engine is up: the row can open and reply only. */
  canChange: boolean;
  layout: MailLayoutMode;
  isFocused: boolean;
  /** Show how long the user has been waiting in place of the date. */
  waiting?: boolean;
  correction?: TodayRowCorrection;
  handlers: TodayRowHandlers;
}) {
  const id = thread.threadId;
  const CorrectionIcon = correction?.icon;

  return (
    <div className="contents" data-today-thread={id}>
      <MailThreadRow
        actions={
          <>
            {/* Over the date column, which the row hides on hover. */}
            <div
              className={cn(
                "absolute hidden rounded-md bg-background shadow-sm sm:group-hover:flex",
                layout === "list"
                  ? "-translate-y-1/2 top-1/2 right-5"
                  : "top-2 right-3.5",
              )}
            >
              <div className="flex items-center gap-0.5">
                {correction ? (
                  <RowButton
                    ariaLabel={correction.label}
                    icon={correction.icon}
                    label={correction.label}
                    onClick={correction.onClick}
                  />
                ) : null}
                <RowButton
                  ariaLabel="Reply to conversation"
                  icon={ReplyIcon}
                  label="Reply"
                  onClick={() => handlers.reply(id)}
                />
                {canChange ? (
                  <ThreadRowActions
                    handlers={handlers}
                    isArchived={!thread.inInbox}
                    isStarred={thread.starred}
                    isUnread={thread.unread}
                    threadKey={id}
                  />
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center border-border/60 border-b bg-background pr-1.5 sm:hidden">
              <PhoneButton
                icon={ReplyIcon}
                label="Reply to conversation"
                onClick={() => handlers.reply(id)}
              />
              {thread.inInbox ? (
                <PhoneButton
                  disabled={!canChange}
                  icon={ArchiveIcon}
                  label="Archive conversation"
                  onClick={() => handlers.archive(id)}
                />
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label="More actions for conversation"
                    className={PHONE_BUTTON_CLASS}
                    type="button"
                  >
                    <EllipsisIcon className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {correction && CorrectionIcon ? (
                    <DropdownMenuItem onSelect={correction.onClick}>
                      <CorrectionIcon className="size-4" />
                      {correction.label}
                    </DropdownMenuItem>
                  ) : null}
                  {thread.inInbox ? null : (
                    <DropdownMenuItem
                      disabled={!canChange}
                      onSelect={() => handlers.moveToInbox(id)}
                    >
                      Move to inbox
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    disabled={!canChange}
                    onSelect={() => handlers.setRead(id, thread.unread)}
                  >
                    {thread.unread ? "Mark as read" : "Mark as unread"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canChange}
                    onSelect={() => handlers.setStarred(id, !thread.starred)}
                  >
                    {thread.starred ? "Unstar" : "Star"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canChange}
                    onSelect={() => handlers.trash(id)}
                  >
                    Delete
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
                    Snooze until
                  </DropdownMenuLabel>
                  {getSnoozePresets(new Date()).map((preset) => (
                    <DropdownMenuItem
                      disabled={!canChange}
                      key={preset.id}
                      onSelect={() => handlers.snooze(id, preset.until)}
                    >
                      {preset.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        }
        date={
          <div className="flex items-center justify-end sm:group-hover:invisible">
            {waiting ? (
              <span className="whitespace-nowrap text-muted-foreground text-xs">
                {waitingFor(thread.at)}
              </span>
            ) : (
              <EmailDate
                className="font-normal text-xs"
                date={new Date(thread.at)}
              />
            )}
          </div>
        }
        hasAnySelection={false}
        index={0}
        isDraft={false}
        isFocused={isFocused}
        isSelected={false}
        isStarred={thread.starred}
        isUnread={thread.unread}
        labels={
          thread.tag ? [<MailLabelChip key="tag" name={thread.tag} />] : []
        }
        layout={layout}
        messageCount={1}
        onOpen={() => handlers.open(id)}
        onSelectRangeTo={noop}
        onToggleSelect={noop}
        participantSummary={thread.fromName}
        selectionEnabled={false}
        snippet={thread.preview}
        subject={thread.subject}
      />
    </div>
  );
}

// 40px: the smallest comfortable target for a thumb.
const PHONE_BUTTON_CLASS =
  "flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted disabled:opacity-50";

function PhoneButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      aria-label={label}
      disabled={disabled}
      className={PHONE_BUTTON_CLASS}
      onClick={onClick}
      type="button"
    >
      <Icon className="size-4" />
    </button>
  );
}

function noop() {}

function waitingFor(iso: string) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days < 1 ? "Today" : `Waiting ${days}d`;
}
