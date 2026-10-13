"use client";

import type { ReactElement, ReactNode } from "react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  MailIcon,
  MailOpenIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Undo2Icon,
} from "lucide-react";
import {
  MailReaderToolbar,
  type MailReaderToolbarButton,
} from "@inboxzero/mail-ui/MailReaderSurface";
import { MailLabelChip } from "@/app/(app)/[emailAccountId]/mail/MailLabelChip";
import { SnoozeButton } from "@/app/(app)/[emailAccountId]/mail/SnoozeButton";
import type { EmailMessageCellLabel } from "@/components/EmailMessageCellLabels";
import { Tooltip } from "@/components/Tooltip";
import { Button } from "@/components/ui/button";

type ReaderToolbarProps = {
  subject: string;
  isStarred: boolean;
  isUnread: boolean;
  labels: EmailMessageCellLabel[];
  /**
   * Chips navigate to a label's view and nothing else: a label carries no
   * reason, because several rules — or none at all — can put one on a thread.
   * The "why" is rule-scoped and lives in `menu`.
   */
  labelHref: (labelId: string) => string;
  onRemoveLabel?: (labelId: string) => void;
  onBackToInbox: () => void;
  onArchive: () => void;
  /** Set when the thread is already archived; swaps out the Archive button. */
  onMoveToInbox?: () => void;
  /** Set when the thread is in the trash; swaps out the Archive button. */
  onRestore?: () => void;
  /** Set when the thread is in spam; swaps out the Archive button. */
  onNotSpam?: () => void;
  onSnooze?: (until: Date) => void;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  /**
   * Set when the reader is too narrow for the relevant context pane, which
   * then opens from here instead.
   */
  onOpenContext?: () => void;
  /** The ⋯ dropdown, i.e. `ThreadActionsMenu`, composed by the shell. */
  menu?: ReactNode;
  /** Shown beside snooze, e.g. `AddToCalendarButton`. */
  extraAction?: ReactNode;
  messageExpansion?: {
    allExpanded: boolean;
    canExpand: boolean;
    onToggleAll: () => void;
  };
};

/**
 * The reader's header: what the thread is, and what you can do to it.
 * Archive and read state stay visible; everything else lives in `menu`.
 */
export function ReaderToolbar({
  subject,
  isStarred,
  isUnread,
  labels,
  labelHref,
  onRemoveLabel,
  onBackToInbox,
  onArchive,
  onMoveToInbox,
  onRestore,
  onNotSpam,
  onSnooze,
  onMarkRead,
  onMarkUnread,
  onOpenContext,
  menu,
  extraAction,
  messageExpansion,
}: ReaderToolbarProps) {
  return (
    <MailReaderToolbar
      icons={{
        archive: <ArchiveIcon className="size-3.5" />,
        back: <ArrowLeftIcon className="size-3.5" />,
        collapse_all: <ChevronsDownUpIcon className="size-3.5" />,
        expand_all: <ChevronsUpDownIcon className="size-3.5" />,
        mark_read: <MailOpenIcon className="size-3.5" />,
        move_to_inbox: <ArchiveRestoreIcon className="size-3.5" />,
        mark_unread: <MailIcon className="size-3.5" />,
        not_spam: <ShieldCheckIcon className="size-3.5" />,
        restore: <Undo2Icon className="size-3.5" />,
      }}
      extraActions={
        extraAction || onSnooze || onOpenContext ? (
          <>
            {onOpenContext ? (
              <Button
                onClick={onOpenContext}
                size="xs-2"
                title="Related mail, meetings and files, and a suggested reply"
                variant="outline"
              >
                <SparklesIcon className="size-3.5" />
                Context
              </Button>
            ) : null}
            {extraAction}
            {onSnooze ? <SnoozeButton onSnooze={onSnooze} /> : null}
          </>
        ) : null
      }
      isStarred={isStarred}
      isUnread={isUnread}
      labelChips={labels.map((label) => (
        <MailLabelChip
          color={label.color}
          href={labelHref(label.id)}
          key={label.id}
          name={label.name}
          onRemove={onRemoveLabel ? () => onRemoveLabel(label.id) : undefined}
        />
      ))}
      menu={menu}
      messageExpansion={messageExpansion}
      onArchive={onArchive}
      onMoveToInbox={onMoveToInbox}
      onRestore={onRestore}
      onNotSpam={onNotSpam}
      onBackToInbox={onBackToInbox}
      onMarkRead={onMarkRead}
      onMarkUnread={onMarkUnread}
      renderActionTooltip={renderActionTooltip}
      renderButton={renderButton}
      subject={subject}
    />
  );
}

function renderButton(button: MailReaderToolbarButton) {
  return (
    <Button
      aria-label={button.ariaLabel}
      onClick={button.onClick}
      size="iconXs"
      title={button.title}
      variant={button.variant}
    >
      {button.icon}
    </Button>
  );
}

function renderActionTooltip(
  button: MailReaderToolbarButton,
  children: ReactElement,
) {
  if (button.action === "archive") {
    return <Tooltip shortcuts={["archive"]}>{children}</Tooltip>;
  }
  if (button.action === "move_to_inbox") {
    return <Tooltip content="Move to inbox">{children}</Tooltip>;
  }
  if (button.action === "mark_unread") {
    return <Tooltip shortcuts={["markUnread"]}>{children}</Tooltip>;
  }
  if (button.action === "restore") {
    return <Tooltip content="Restore to inbox">{children}</Tooltip>;
  }
  if (button.action === "not_spam") {
    return <Tooltip content="Not spam">{children}</Tooltip>;
  }
  if (button.action === "mark_read") {
    return <Tooltip shortcuts={["markRead"]}>{children}</Tooltip>;
  }
  return children;
}
