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
import { blockSender } from "@/app/(app)/[emailAccountId]/bulk-unsubscribe/hooks";
import type { SenderUnsubscribeLinkResponse } from "@/app/api/user/stats/newsletters/unsubscribe-link/route";
import { Button } from "@/components/ui/button";
import { useAccounts } from "@/hooks/useAccounts";
import { usePremium } from "@/hooks/usePremium";
import { useArchiveSenderQueueActions } from "@/store/archive-sender-queue";
import { cn } from "@/utils";
import { formatShortDate } from "@/utils/date";
import { isMicrosoftProvider } from "@/utils/email/provider-types";
import { fetchWithAccount } from "@/utils/fetch";
import type { TodayAccount } from "@/utils/home/merge-home";
import {
  getHttpUnsubscribeLink,
  getUserFacingUnsubscribeLink,
} from "@/utils/parse/unsubscribe";

/**
 * Today's first-week clean-up: senders who keep mailing and are never
 * opened, each with the Bulk unsubscribe page's unsubscribe and Skip inbox,
 * and a "Not now" kept in this browser. Skip inbox is the one action that
 * changes the user's mailbox settings, so its label says so.
 */
export function NeverReadCard({
  senders,
  sinceMs,
  onHide,
  accounts,
  accountColorIndexById,
}: {
  senders: NeverReadSender[];
  /** Set when this browser holds less than the whole window. */
  sinceMs: number | null;
  onHide: (sender: NeverReadSender) => void;
  /** Across accounts: each row names its account. */
  accounts?: TodayAccount[];
  accountColorIndexById: Record<string, number>;
}) {
  const headingId = useId();
  const detailId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { hasUnsubscribeAccess, mutate: refetchPremium } = usePremium();
  const { PremiumModal, openModal } = usePremiumModal();
  const { data: accountsData } = useAccounts();
  if (!senders.length) return null;

  // Focus stays in the card, on the row that moves up into the hidden one's
  // place or else the heading, rather than falling back to the page. After
  // a confirmed unsubscribe it moves even if the dialog left it elsewhere.
  const hide = (
    sender: NeverReadSender,
    index: number,
    { moveFocus = false } = {},
  ) => {
    const hadFocus = listRef.current?.contains(document.activeElement);
    onHide(sender);
    if (!hadFocus && !moveFocus) return;
    requestAnimationFrame(() => {
      const rows = listRef.current?.querySelectorAll("li");
      const next = rows?.[Math.min(index, rows.length - 1)];
      const target = next?.querySelector("button") ?? headingRef.current;
      target?.focus();
    });
  };

  return (
    <section aria-labelledby={headingId}>
      <h2
        className="mb-1 font-title text-foreground text-lg outline-none"
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
      >
        Mail you never read
      </h2>
      <p className="mb-2 text-muted-foreground text-sm" id={detailId}>
        {sinceMs
          ? `Frequent senders you haven't opened since ${formatShortDate(
              new Date(sinceMs),
              { lowercase: true },
            )}. Counted on this device.`
          : "Frequent senders you haven't opened in 30 days. Counted on this device."}
      </p>
      <ul
        aria-describedby={detailId}
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
              onHide={(options) => hide(sender, index, options)}
              onNeedsPremium={openModal}
              provider={
                accountsData?.emailAccounts.find(
                  ({ id }) => id === sender.accountId,
                )?.account.provider
              }
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
  provider,
}: {
  sender: NeverReadSender;
  /** Unknown until the accounts load, when Skip inbox waits. */
  provider?: string;
  account?: TodayAccount;
  accountColorClassName?: string;
  hasUnsubscribeAccess: boolean;
  onNeedsPremium: () => void;
  refetchPremium: () => Promise<unknown>;
  onHide: (options?: { moveFocus?: boolean }) => void;
}) {
  const { queueArchiveSenders } = useArchiveSenderQueueActions(
    sender.accountId,
  );
  const [checking, setChecking] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [confirming, setConfirming] = useState<{
    unsubscribeLink: string | null;
    httpLink: string;
  } | null>(null);
  const label = sender.name || sender.email;

  // The sender's link is looked up only when asked for, and on its own, so
  // Today never waits on the newsletter stats. Without a link nothing else
  // is tried: blocking would add a filter to the user's mailbox.
  const startUnsubscribe = async () => {
    if (checking) return;
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
    if (unsubscribed) onHide({ moveFocus: true });
  };

  const skipInbox = async () => {
    if (skipping || !provider) return;
    if (!hasUnsubscribeAccess) {
      onNeedsPremium();
      return;
    }
    setSkipping(true);
    try {
      await blockSender({
        sender: sender.email,
        emailAccountId: sender.accountId,
        queueArchiveSenders,
      });
    } catch {
      toast.error(`Couldn't skip the inbox for ${label}`);
      return;
    } finally {
      setSkipping(false);
    }
    toast.success(`Mail from ${label} will skip your inbox`);
    onHide({ moveFocus: true });
    // Metering only; it must not read as a failed Skip inbox.
    refetchPremium().catch(() => {});
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
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          aria-label={`Unsubscribe from ${label}`}
          // Stays focusable while the link is looked up; `loading` would
          // disable it and drop focus.
          aria-busy={checking}
          aria-disabled={checking}
          className={checking ? "cursor-progress opacity-60" : undefined}
          onClick={startUnsubscribe}
          size="sm"
          variant="outline"
        >
          Unsubscribe
        </Button>
        <Button
          aria-label={`${skipInboxLabel(provider)} for ${label}`}
          aria-busy={skipping}
          aria-disabled={!provider || skipping}
          className={cn(
            !provider && "opacity-60",
            skipping && "cursor-progress opacity-60",
          )}
          onClick={skipInbox}
          size="sm"
          variant="outline"
        >
          {skipInboxLabel(provider)}
        </Button>
        <Button
          aria-label={`Not now for ${label}`}
          onClick={() => onHide()}
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

/** Says what Skip inbox adds to the user's own mailbox. */
function skipInboxLabel(provider: string | undefined) {
  return provider && isMicrosoftProvider(provider)
    ? "Skip inbox (adds an Outlook rule)"
    : "Skip inbox (adds a Gmail filter)";
}

/** The sender's unsubscribe link from the stats Bulk unsubscribe keeps. */
async function readUnsubscribeLink(sender: NeverReadSender) {
  const response = await fetchWithAccount({
    url: `/api/user/stats/newsletters/unsubscribe-link?${new URLSearchParams({ sender: sender.email })}`,
    emailAccountId: sender.accountId,
  });
  if (!response.ok) throw new Error(`Unsubscribe link: ${response.status}`);
  const { unsubscribeLink } =
    (await response.json()) as SenderUnsubscribeLinkResponse;
  return unsubscribeLink;
}
