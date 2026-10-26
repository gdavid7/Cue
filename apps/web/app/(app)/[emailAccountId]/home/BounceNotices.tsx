"use client";

import { type RefObject, useId, useRef } from "react";
import Link from "next/link";
import { MailXIcon, XIcon } from "lucide-react";
import { getAccountColorClassName } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { AccountMarker } from "@/app/(app)/[emailAccountId]/mail/ThreadRow";
import { Button } from "@/components/ui/button";
import { formatShortDate } from "@/utils/date";
import type { TodayAccount } from "@/utils/home/merge-home";
import type { TodayBounce } from "./use-recent-bounces";

/**
 * One card per recent bounce, so a message that didn't go out isn't taken
 * for sent. Each opens the bounce's conversation, in its own account across
 * accounts, or is dismissed in this browser.
 */
export function BounceNotices({
  bounces,
  onDismiss,
  href,
  accounts,
  accountColorIndexById,
  returnFocusRef,
}: {
  bounces: TodayBounce[];
  onDismiss: (bounce: TodayBounce) => void;
  href: (bounce: TodayBounce) => string;
  /** Across accounts: each card names its account. */
  accounts?: TodayAccount[];
  accountColorIndexById: Record<string, number>;
  /** Where focus goes when the last card is dismissed. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  if (!bounces.length) return null;

  // Focus stays with the cards, on the one that moves up into the dismissed
  // one's place, rather than falling back to the page.
  const dismiss = (bounce: TodayBounce, index: number) => {
    const hadFocus = listRef.current?.contains(document.activeElement);
    onDismiss(bounce);
    if (!hadFocus) return;
    requestAnimationFrame(() => {
      const cards = listRef.current?.querySelectorAll("li");
      const next = cards?.[Math.min(index, cards.length - 1)];
      const target = next?.querySelector("a") ?? returnFocusRef?.current;
      target?.focus({ preventScroll: !next });
    });
  };

  return (
    <ul aria-label="Didn't send" className="space-y-2" ref={listRef}>
      {bounces.map((bounce, index) => {
        const account = accounts?.find(({ id }) => id === bounce.accountId);
        return (
          <BounceCard
            account={account}
            accountColorClassName={
              account
                ? getAccountColorClassName(
                    accountColorIndexById[account.id] ?? 0,
                  )
                : undefined
            }
            bounce={bounce}
            href={href(bounce)}
            key={`${bounce.accountId}:${bounce.conversationId}`}
            onDismiss={() => dismiss(bounce, index)}
          />
        );
      })}
    </ul>
  );
}

function BounceCard({
  bounce,
  href,
  account,
  accountColorClassName,
  onDismiss,
}: {
  bounce: TodayBounce;
  href: string;
  account?: TodayAccount;
  accountColorClassName?: string;
  onDismiss: () => void;
}) {
  const titleId = useId();
  const detailId = useId();
  return (
    <li
      aria-labelledby={`${titleId} ${detailId}`}
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
      data-bounce={bounce.messageId}
    >
      <MailXIcon aria-hidden className="size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground" id={titleId}>
          Didn't send
        </p>
        <p
          className="flex min-w-0 items-center gap-1.5 text-muted-foreground"
          id={detailId}
        >
          {account ? (
            <AccountMarker
              account={account}
              colorClassName={accountColorClassName}
            />
          ) : null}
          <span className="min-w-0 truncate">{bounce.title}</span>
          {/* On a phone the subject needs the room more than the time. */}
          <span aria-hidden className="hidden sm:inline">
            ·
          </span>
          <time
            className="hidden shrink-0 sm:inline"
            dateTime={new Date(bounce.receivedAtMs).toISOString()}
          >
            {formatShortDate(new Date(bounce.receivedAtMs))}
          </time>
        </p>
      </div>
      <Button asChild size="sm" variant="outline">
        <Link aria-describedby={detailId} href={href}>
          Open
        </Link>
      </Button>
      <Button
        aria-describedby={detailId}
        aria-label="Dismiss"
        className="-mr-1 shrink-0"
        onClick={onDismiss}
        size="iconXs"
        variant="ghost"
      >
        <XIcon aria-hidden className="size-4" />
      </Button>
    </li>
  );
}
