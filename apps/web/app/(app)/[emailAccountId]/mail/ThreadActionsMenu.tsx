"use client";

import {
  ArchiveIcon,
  ArrowBigUpIcon,
  CornerUpLeftIcon,
  ArchiveRestoreIcon,
  ExternalLinkIcon,
  FlagIcon,
  FlagOffIcon,
  FolderInputIcon,
  LanguagesIcon,
  MailXIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PrinterIcon,
  ShieldAlertIcon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
  TagIcon,
} from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useSenderCommands } from "@/app/(app)/[emailAccountId]/mail/use-sender-commands";
import { getEmailMessageCellActions } from "@/components/EmailMessageCellActions";
import { Kbd } from "@/components/Kbd";
import { toastError, toastSuccess } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/Tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getShortcutHint,
  getShortcutKeyLabels,
  type ShortcutId,
} from "@/lib/shortcuts/registry";
import { useAccount } from "@/providers/EmailAccountProvider";
import { getOpenInMailboxLabel } from "@/utils/url";
import { markNeedsReplyAction } from "@/utils/actions/thread-assist";
import { getActionErrorMessage } from "@/utils/error";
import type { ParsedMessage } from "@/utils/types";

export type ThreadActionsMenuProps = {
  message: ParsedMessage | null;
  isStarred: boolean;
  onToggleStar: () => void;
  isImportant?: boolean;
  /** Gmail only: Outlook has no per-thread importance in the mail engine. */
  onToggleImportant?: () => void;
  onMarkSpam: () => void;
  onDelete: () => void;
  onLabel?: () => void;
  onMove?: () => void;
  onTranslate?: () => void;
  onComment?: () => void;
  onPrint?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * Thread-wide actions in the reader toolbar.
 */
export function ThreadActionsMenu({
  message,
  isStarred,
  onToggleStar,
  isImportant = false,
  onToggleImportant,
  onMarkSpam,
  onDelete,
  onLabel,
  onMove,
  onTranslate,
  onComment,
  onPrint,
  open,
  onOpenChange,
}: ThreadActionsMenuProps) {
  const { emailAccountId, provider, userEmail } = useAccount();
  // The correction for when the AI filed or skipped something that matters.
  const { execute: markNeedsReply } = useAction(
    markNeedsReplyAction.bind(null, emailAccountId),
    {
      onSuccess: () => toastSuccess({ description: "Moved to Needs you" }),
      onError: (error) =>
        toastError({
          description: getActionErrorMessage(error.error, {
            prefix: "Couldn't mark it",
          }),
        }),
    },
  );
  const {
    canManageAutoArchive,
    isUnsubscribeDisabled,
    unsubscribeLabel,
    isAutoArchived,
    isAutoArchiveStatusLoading,
    isUpdatingAutoArchive,
    onToggleAutoArchive,
    onUnsubscribe,
    PremiumModal,
  } = useSenderCommands(message);
  const openUrl = message
    ? getEmailMessageCellActions({
        externalUrl: message.externalUrl,
        messageId: message.id,
        provider,
        threadId: message.threadId,
        userEmail,
      })?.openUrl
    : undefined;

  return (
    <>
      <DropdownMenu onOpenChange={onOpenChange} open={open}>
        <Tooltip shortcuts={["moreActions"]}>
          <DropdownMenuTrigger asChild>
            <Button aria-label="More actions" size="iconXs" variant="outline">
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>

        <DropdownMenuContent
          align="end"
          className="w-80 max-w-[calc(100vw-1rem)]"
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          {onLabel && (
            <DropdownMenuItem onSelect={onLabel}>
              <TagIcon className="mr-2 size-4" />
              Label
              <MenuShortcut id="label" />
            </DropdownMenuItem>
          )}

          {onMove && (
            <DropdownMenuItem onSelect={onMove}>
              <FolderInputIcon className="mr-2 size-4" />
              Move
              <MenuShortcut id="move" />
            </DropdownMenuItem>
          )}

          <DropdownMenuItem onSelect={onToggleStar}>
            {isStarred ? (
              <StarOffIcon className="mr-2 size-4" />
            ) : (
              <StarIcon className="mr-2 size-4" />
            )}
            {isStarred ? "Unstar" : "Star"}
            <MenuShortcut id="star" />
          </DropdownMenuItem>

          {onToggleImportant && (
            <DropdownMenuItem onSelect={onToggleImportant}>
              {isImportant ? (
                <FlagOffIcon className="mr-2 size-4" />
              ) : (
                <FlagIcon className="mr-2 size-4" />
              )}
              {isImportant ? "Mark as not important" : "Mark as important"}
            </DropdownMenuItem>
          )}

          {message ? (
            <DropdownMenuItem
              onSelect={() => markNeedsReply({ threadId: message.threadId })}
            >
              <CornerUpLeftIcon className="mr-2 size-4" />
              Track until I reply
            </DropdownMenuItem>
          ) : null}

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={onDelete}>
            <Trash2Icon aria-hidden className="mr-2 size-4" />
            Delete
            <MenuShortcut id="delete" />
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={onMarkSpam}>
            <ShieldAlertIcon className="mr-2 size-4" />
            Mark as spam
            <MenuShortcut id="markSpam" />
          </DropdownMenuItem>

          {canManageAutoArchive ? (
            <DropdownMenuItem
              disabled={isUnsubscribeDisabled}
              onSelect={onUnsubscribe}
            >
              <MailXIcon className="mr-2 size-4" />
              {unsubscribeLabel}
              <MenuShortcut id="unsubscribe" />
            </DropdownMenuItem>
          ) : null}

          {(onTranslate || onComment || onPrint || canManageAutoArchive) && (
            <DropdownMenuSeparator />
          )}

          {onTranslate && (
            <DropdownMenuItem onSelect={onTranslate}>
              <LanguagesIcon className="mr-2 size-4" />
              Translate
              <MenuShortcut id="translate" />
            </DropdownMenuItem>
          )}

          {onPrint && (
            <DropdownMenuItem onSelect={onPrint}>
              <PrinterIcon className="mr-2 size-4" />
              Print conversation
            </DropdownMenuItem>
          )}

          {onComment && (
            <DropdownMenuItem onSelect={onComment}>
              <MessageSquareIcon className="mr-2 size-4" />
              Comment
              <MenuShortcut id="openTeamComments" />
            </DropdownMenuItem>
          )}

          {canManageAutoArchive ? (
            <DropdownMenuItem
              disabled={isAutoArchiveStatusLoading || isUpdatingAutoArchive}
              onSelect={onToggleAutoArchive}
            >
              {isAutoArchived ? (
                <ArchiveRestoreIcon className="mr-2 size-4" />
              ) : (
                <ArchiveIcon className="mr-2 size-4" />
              )}
              {isAutoArchived
                ? "Show this sender in inbox again"
                : "Skip inbox for this sender"}
              <MenuShortcut id="toggleAutoArchive" />
            </DropdownMenuItem>
          ) : null}

          {openUrl ? <DropdownMenuSeparator /> : null}

          {openUrl ? (
            <DropdownMenuItem asChild>
              <a href={openUrl} rel="noopener noreferrer" target="_blank">
                <ExternalLinkIcon className="mr-2 size-4" />
                {getOpenInMailboxLabel(provider) ?? "Open in email provider"}
                <MenuShortcut id="openExternal" />
              </a>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <PremiumModal />
    </>
  );
}

function MenuShortcut({ id }: { id: ShortcutId }) {
  return (
    <span className="ml-auto flex items-center gap-1">
      <span className="sr-only">{getShortcutHint(id)}</span>
      {getShortcutKeyLabels(id).map((key, index) => (
        <Kbd
          aria-hidden
          className="h-5 min-w-5 px-1.5 font-sans text-[11px]"
          key={`${index}-${key}`}
        >
          {key === "shift" ? <ArrowBigUpIcon className="size-3.5" /> : key}
        </Kbd>
      ))}
    </span>
  );
}
