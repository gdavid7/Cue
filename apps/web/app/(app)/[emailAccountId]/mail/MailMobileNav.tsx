"use client";

import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  EllipsisIcon,
  InboxIcon,
  MenuIcon,
  PenIcon,
  ReplyIcon,
  SunIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { barItemClassName } from "@/app/(app)/[emailAccountId]/mail/MailAccountSwitcher";
import { useMailHref } from "@/hooks/useMailHref";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useComposeModal } from "@/providers/ComposeModalProvider";
import { cn } from "@/utils";
import { parseMailPath } from "@/utils/mail-url";
import { prefixPath } from "@/utils/path";

export type MailMobileReaderActions = {
  onBack: () => void;
  /** Absent for a conversation that's already archived. */
  onArchive?: () => void;
  /** Set for an archived conversation; takes Archive's place. */
  onMoveToInbox?: () => void;
  onReply: () => void;
  onDelete: () => void;
  onMore: () => void;
};

/**
 * The phone's way around: the sidebar is hidden below `lg`, so mailboxes,
 * compose and the Today briefing need a home within thumb reach. While a
 * conversation is open the bar becomes that conversation's actions instead.
 */
export function MailMobileNav({
  accountSwitcher,
  onOpenMailboxes,
  readerActions,
}: {
  /** `MailAccountSwitcher` with the "bar" variant. */
  accountSwitcher: ReactNode;
  /** Opens the mail sidebar as a sheet: Sent, Drafts, labels, tools. */
  onOpenMailboxes?: () => void;
  readerActions?: MailMobileReaderActions | null;
}) {
  const { emailAccountId } = useAccount();
  const mailHref = useMailHref();
  const { onOpen: openCompose } = useComposeModal();
  const pathname = usePathname() ?? "";
  const isToday = pathname.endsWith("/home");
  const searchParams = useSearchParams();
  // Inbox is current only on the inbox itself (any of its tabs), not on Sent,
  // a label, a search or All Inboxes.
  const mailView = parseMailPath(pathname, searchParams);
  const isInbox =
    !isToday &&
    (!mailView ||
      (!mailView.allInboxes &&
        (mailView.view?.kind === "inbox" || mailView.view?.kind === "split")));

  if (readerActions) {
    return (
      <nav
        aria-label="Conversation"
        data-mail-mobile-nav
        className={barClassName}
      >
        <BarButton
          current
          icon={ArrowLeftIcon}
          label="Back"
          onClick={readerActions.onBack}
        />
        {readerActions.onMoveToInbox ? (
          <BarButton
            current
            icon={ArchiveRestoreIcon}
            label="To inbox"
            onClick={readerActions.onMoveToInbox}
          />
        ) : readerActions.onArchive ? (
          <BarButton
            current
            icon={ArchiveIcon}
            label="Archive"
            onClick={readerActions.onArchive}
          />
        ) : null}
        <BarButton
          current
          icon={ReplyIcon}
          label="Reply"
          onClick={readerActions.onReply}
        />
        <BarButton
          current
          icon={Trash2Icon}
          label="Delete"
          onClick={readerActions.onDelete}
        />
        <BarButton
          current
          icon={EllipsisIcon}
          label="More"
          onClick={readerActions.onMore}
        />
      </nav>
    );
  }

  return (
    <nav aria-label="Mail" data-mail-mobile-nav className={barClassName}>
      {onOpenMailboxes ? (
        <BarButton
          icon={MenuIcon}
          label="Mailboxes"
          onClick={onOpenMailboxes}
          current={!isInbox && !isToday}
        />
      ) : null}
      <Link
        aria-current={isInbox ? "page" : undefined}
        className={cn(
          barItemClassName,
          isInbox ? "text-foreground" : "text-muted-foreground",
        )}
        href={mailHref()}
      >
        <InboxIcon className="size-5" />
        Inbox
      </Link>
      <button
        aria-label="Compose"
        className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-transform duration-100 active:scale-95"
        onClick={openCompose}
        type="button"
      >
        <PenIcon className="size-5" />
      </button>
      <Link
        aria-current={isToday ? "page" : undefined}
        className={cn(
          barItemClassName,
          isToday ? "text-foreground" : "text-muted-foreground",
        )}
        href={prefixPath(emailAccountId, "/home")}
      >
        <SunIcon className="size-5" />
        Today
      </Link>
      {accountSwitcher}
    </nav>
  );
}

const barClassName =
  "flex shrink-0 items-center justify-around gap-1 border-border/60 border-t bg-background/80 px-2 backdrop-blur-xl backdrop-saturate-150 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] lg:hidden";

function BarButton({
  icon: Icon,
  label,
  onClick,
  current,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  current?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        barItemClassName,
        current ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon className="size-5" />
      {label}
    </button>
  );
}
