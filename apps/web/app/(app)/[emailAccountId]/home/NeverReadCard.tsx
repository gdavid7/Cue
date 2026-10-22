"use client";

import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import type { NeverReadSender } from "@inboxzero/mail-core/queries";
import { usePremiumModal } from "@/app/(app)/premium/PremiumModal";
import { getAccountColorClassName } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { AccountMarker } from "@/app/(app)/[emailAccountId]/mail/ThreadRow";
import {
  openUnsubscribePage,
  UnsubscribeConfirmDialog,
  unsubscribeAndArchiveSender,
} from "@/app/(app)/[emailAccountId]/mail/use-unsubscribe-sender";
import type { NewsletterStatsResponse } from "@/app/api/user/stats/newsletters/route";
import { Button } from "@/components/ui/button";
import { usePremium } from "@/hooks/usePremium";
import { useArchiveSenderQueueActions } from "@/store/archive-sender-queue";
import { formatShortDate } from "@/utils/date";
import { canonicalizeEmailAddress } from "@/utils/email";
import { fetchWithAccount } from "@/utils/fetch";
import type { TodayAccount } from "@/utils/home/merge-home";
import {
  getHttpUnsubscribeLink,
  getUserFacingUnsubscribeLink,
} from "@/utils/parse/unsubscribe";
import { createSearchParams } from "@/utils/url";

/**
 * Today's first-week clean-up: senders who keep mailing and are never
 * opened, each with the Bulk unsubscribe page's unsubscribe and a "Not now"
 * kept in this browser. Nothing here changes the user's mail settings.
 */
export function NeverReadCard({
  senders,
  onHide,
  accounts,
  accountColorIndexById,
}: {
  senders: NeverReadSender[];
  onHide: (sender: NeverReadSender) => void;
  /** Across accounts: each row names its account. */
  accounts?: TodayAccount[];
  accountColorIndexById: Record<string, number>;
}) {
  const headingId = useId();
  const detailId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const { hasUnsubscribeAccess, mutate: refetchPremium } = usePremium();
  const { PremiumModal, openModal } = usePremiumModal();
  if (!senders.length) return null;

  // Focus stays in the list, on the row that moves up into the hidden one's
  // place, rather than falling back to the page.
  const hide = (sender: NeverReadSender, index: number) => {
    const hadFocus = listRef.current?.contains(document.activeElement);
    onHide(sender);
    if (!hadFocus) return;
    requestAnimationFrame(() => {
      const rows = listRef.current?.querySelectorAll("li");
      const next = rows?.[Math.min(index, rows.length - 1)];
      next?.querySelector("button")?.focus();
    });
  };

  return (
    <section aria-labelledby={headingId}>
      <h2 className="mb-1 font-title text-foreground text-lg" id={headingId}>
        Mail you never read
      </h2>
      <p className="mb-2 text-muted-foreground text-sm" id={detailId}>
        Frequent senders you haven't opened in 30 days. Counted on this device.
      </p>
      <ul
        aria-describedby={detailId}
        aria-labelledby={headingId}
        className="-mx-4 sm:mx-0 divide-y divide-border/60 border-border/60 border-y"
        ref={listRef}
      >
        {senders.map((sender, index) => {
          const account = accounts?.find(({ id }) => id === sender.accountId);
          return (
            <NeverReadRow
              account={account}
              accountColorClassName={
                account
                  ? getAccountColorClassName(
                      accountColorIndexById[account.id] ?? 0,
                    )
                  : undefined
              }
              hasUnsubscribeAccess={hasUnsubscribeAccess}
              key={`${sender.accountId}:${sender.email}`}
              onHide={() => hide(sender, index)}
              onNeedsPremium={openModal}
              refetchPremium={refetchPremium}
              sender={sender}
            />
          );
        })}
      </ul>
      <PremiumModal />
    </section>
  );
}

function NeverReadRow({
  sender,
  account,
  accountColorClassName,
  hasUnsubscribeAccess,
  onNeedsPremium,
  refetchPremium,
  onHide,
}: {
  sender: NeverReadSender;
  account?: TodayAccount;
  accountColorClassName?: string;
  hasUnsubscribeAccess: boolean;
  onNeedsPremium: () => void;
  refetchPremium: () => Promise<unknown>;
  onHide: () => void;
}) {
  const { queueArchiveSenders } = useArchiveSenderQueueActions(
    sender.accountId,
  );
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState<{
    unsubscribeLink: string | null;
    httpLink: string;
  } | null>(null);
  const label = sender.name || sender.email;

  // The sender's link is looked up only when asked for, so Today never waits
  // on the newsletter stats. Without a link nothing else is tried: blocking
  // would add a filter to the user's mailbox.
  const startUnsubscribe = async () => {
    if (!hasUnsubscribeAccess) {
      onNeedsPremium();
      return;
    }
    setChecking(true);
    try {
      const unsubscribeLink = await readUnsubscribeLink(sender);
      const httpLink = getHttpUnsubscribeLink({ unsubscribeLink });
      const pageLink = getUserFacingUnsubscribeLink({ unsubscribeLink });
      if (httpLink) setConfirming({ unsubscribeLink, httpLink });
      else if (pageLink) openUnsubscribePage(pageLink);
      else toast.error(`Couldn't find an unsubscribe link for ${label}`);
    } catch {
      toast.error(`Couldn't check how to unsubscribe from ${label}`);
    } finally {
      setChecking(false);
    }
  };

  const confirmUnsubscribe = async () => {
    if (!confirming) return;
    const unsubscribed = await unsubscribeAndArchiveSender({
      emailAccountId: sender.accountId,
      senderEmail: sender.email,
      senderName: label,
      unsubscribeLink: confirming.unsubscribeLink,
      manualLink: confirming.httpLink,
      queueArchiveSenders,
      refetchPremium,
    });
    if (unsubscribed) onHide();
  };

  return (
    <li
      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-0"
      data-never-read-sender={sender.email}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {account ? (
          <AccountMarker
            account={account}
            colorClassName={accountColorClassName}
          />
        ) : null}
        <div className="min-w-0">
          <p className="truncate text-sm">
            <span className="font-medium">{label}</span>
            {sender.name ? (
              <span className="ml-1.5 text-muted-foreground text-xs">
                {sender.email}
              </span>
            ) : null}
          </p>
          <p className="truncate text-muted-foreground text-xs">
            {sender.count} emails, none opened · latest{" "}
            {formatShortDate(new Date(sender.lastReceivedAtMs), {
              lowercase: true,
            })}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          aria-label={`Unsubscribe from ${label}`}
          disabled={checking}
          loading={checking}
          onClick={startUnsubscribe}
          size="sm"
          variant="outline"
        >
          Unsubscribe
        </Button>
        <Button
          aria-label={`Not now for ${label}`}
          onClick={onHide}
          size="sm"
          variant="ghost"
        >
          Not now
        </Button>
      </div>
      <UnsubscribeConfirmDialog
        onConfirm={confirmUnsubscribe}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        open={Boolean(confirming)}
        senderName={label}
      />
    </li>
  );
}

/** The sender's unsubscribe link from the stats Bulk unsubscribe keeps. */
async function readUnsubscribeLink(sender: NeverReadSender) {
  const url = `/api/user/stats/newsletters?${createSearchParams({
    types: [],
    search: sender.email,
    orderBy: "emails",
    orderDirection: "desc",
    includeMissingUnsubscribe: true,
  })}`;
  const response = await fetchWithAccount({
    url,
    emailAccountId: sender.accountId,
  });
  if (!response.ok) throw new Error(`Sender stats: ${response.status}`);
  const stats = (await response.json()) as NewsletterStatsResponse;
  const canonical = canonicalizeEmailAddress(sender.email);
  return (
    stats.newsletters.find((newsletter) => newsletter.name === canonical)
      ?.unsubscribeLink ?? null
  );
}
