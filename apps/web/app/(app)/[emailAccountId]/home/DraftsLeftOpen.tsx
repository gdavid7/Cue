"use client";

import Link from "next/link";
import type { LeftOpenDraft } from "@inboxzero/mail-core/queries";
import { getAccountColorClassName } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { AccountMarker } from "@/app/(app)/[emailAccountId]/mail/ThreadRow";
import { extractNameFromEmail } from "@/utils/email";
import { formatShortDate } from "@/utils/date";
import type { TodayAccount } from "@/utils/home/merge-home";

/**
 * Today's "Drafts you left open" rows. Each opens its conversation, whose
 * reader opens the newest draft in the composer, in its own account across
 * accounts.
 */
export function DraftsLeftOpenList({
  drafts,
  href,
  accounts,
  accountColorIndexById,
}: {
  drafts: LeftOpenDraft[];
  href: (draft: LeftOpenDraft) => string;
  /** Across accounts: each row names its account. */
  accounts?: TodayAccount[];
  accountColorIndexById: Record<string, number>;
}) {
  return (
    <ul
      aria-label="Drafts you left open"
      className="-mx-4 sm:mx-0 border-border/60 border-t"
    >
      {drafts.map((draft) => {
        const account = accounts?.find(({ id }) => id === draft.accountId);
        const recipients = draft.to
          .map((address) => extractNameFromEmail(address))
          .filter(Boolean)
          .join(", ");
        return (
          <li key={`${draft.accountId}:${draft.conversationId}`}>
            <Link
              // Text starts where the lanes' rows put it, past their unread-dot slot.
              className="flex w-full items-center gap-3 border-border/60 border-b bg-background py-2.5 pr-3.5 pl-8 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted lg:pr-5"
              data-left-open-draft={draft.messageId}
              href={href(draft)}
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  {account ? (
                    <AccountMarker
                      account={account}
                      colorClassName={getAccountColorClassName(
                        accountColorIndexById[account.id] ?? 0,
                      )}
                    />
                  ) : null}
                  <span className="truncate font-medium text-foreground text-sm">
                    {draft.subject.trim() || "(no subject)"}
                  </span>
                </div>
                {recipients ? (
                  <div className="truncate text-muted-foreground text-xs">
                    {recipients}
                  </div>
                ) : null}
              </div>
              <time
                className="shrink-0 whitespace-nowrap text-muted-foreground text-xs"
                dateTime={new Date(draft.savedAtMs).toISOString()}
              >
                {formatShortDate(new Date(draft.savedAtMs))}
              </time>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
