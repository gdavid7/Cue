"use client";

import { Fragment, useId } from "react";
import Link from "next/link";
import { format, isSameDay, subDays } from "date-fns";
import { XIcon } from "lucide-react";
import useSWR from "swr";
import type { GetAwaySummaryResponse } from "@/app/api/user/home/away/route";
import { getAccountColorClassName } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { AccountMarker } from "@/app/(app)/[emailAccountId]/mail/ThreadRow";
import { Button } from "@/components/ui/button";
import { dismissAwaySummaryAction } from "@/utils/actions/away-summary";
import type { TodayAccount } from "@/utils/home/merge-home";
import { prefixPath } from "@/utils/path";
import {
  HISTORY_ACTION_NAMES,
  type HistoryAction,
} from "@/utils/rule/history-actions";

type AccountCounts = GetAwaySummaryResponse["accounts"][number];

// Counts change only as Cue works; tab switches share one load.
const FOCUS_REFRESH_MIN_MS = 60_000;

/**
 * What Cue did since the user was last here, loaded on its own beside Today
 * so the lanes never wait for it. Across accounts it sums them, with a line
 * per account whose counts open that account's History.
 */
export function useAwaySummary(emailAccountIds: string[]) {
  const key = emailAccountIds.length
    ? `/api/user/home/away?${new URLSearchParams({
        accounts: emailAccountIds.join(","),
      })}`
    : null;
  const { data, mutate } = useSWR<GetAwaySummaryResponse>(key, {
    focusThrottleInterval: FOCUS_REFRESH_MIN_MS,
    // A card that didn't load is just not shown; Today works without it.
    shouldRetryOnError: false,
  });
  const dismiss = () => {
    mutate((current) => current && { ...current, since: null, accounts: [] }, {
      revalidate: false,
    });
    dismissAwaySummaryAction().catch(() => mutate());
  };
  return { summary: data, dismiss };
}

/**
 * "Since yesterday, Cue sorted 12 emails, archived 8 and drafted 3 replies."
 * Each count opens Assistant > History filtered to that kind of work. Hidden
 * when Cue did nothing, and until the next visit once dismissed.
 */
export function WhileYouWereAway({
  summary,
  onDismiss,
  accounts,
  accountColorIndexById,
}: {
  summary: GetAwaySummaryResponse | undefined;
  onDismiss: () => void;
  /** Across accounts: each line names its account. */
  accounts?: TodayAccount[];
  accountColorIndexById: Record<string, number>;
}) {
  const headingId = useId();
  if (!summary?.since) return null;
  const active = summary.accounts.filter(hasWork);
  if (!active.length) return null;

  const since = sinceLabel(new Date(summary.since), summary.capped);
  const perAccount = accounts && accounts.length > 1;

  return (
    <section
      aria-labelledby={headingId}
      className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
    >
      <div className="min-w-0 flex-1">
        <h2 className="font-medium text-foreground" id={headingId}>
          While you were away
        </h2>
        <p className="mt-0.5 text-muted-foreground">
          {since}, Cue{" "}
          <WorkSentence
            counts={perAccount ? sum(active) : active[0]}
            emailAccountId={perAccount ? undefined : active[0].emailAccountId}
          />
          .
        </p>
        {perAccount ? (
          <ul className="mt-2 space-y-1">
            {active.map((counts) => {
              const account = accounts.find(
                ({ id }) => id === counts.emailAccountId,
              );
              if (!account) return null;
              return (
                <li
                  className="flex min-w-0 items-center gap-2 text-muted-foreground"
                  key={account.id}
                >
                  <AccountMarker
                    account={account}
                    colorClassName={getAccountColorClassName(
                      accountColorIndexById[account.id] ?? 0,
                    )}
                  />
                  <span className="min-w-0 truncate">
                    <span className="text-foreground">{account.email}</span>
                    {": "}
                    <WorkSentence counts={counts} emailAccountId={account.id} />
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      <Button
        aria-label="Dismiss"
        className="-mr-1 shrink-0"
        onClick={onDismiss}
        size="iconXs"
        variant="ghost"
      >
        <XIcon aria-hidden className="size-4" />
      </Button>
    </section>
  );
}

/** "sorted 12 emails, archived 8 and drafted 3 replies", each count a link when it has one account. */
function WorkSentence({
  counts,
  emailAccountId,
}: {
  counts: Record<HistoryAction, number>;
  emailAccountId?: string;
}) {
  const parts = HISTORY_ACTION_NAMES.filter((name) => counts[name] > 0);
  // The noun once, on the first count of emails: "sorted 12 emails, archived 8".
  const firstEmailPart = parts.find((name) => name !== "drafted");
  return (
    <>
      {parts.map((name, index) => {
        const text = partText(name, counts[name], name === firstEmailPart);
        return (
          <Fragment key={name}>
            {separator(index, parts.length)}
            {emailAccountId ? (
              <Link
                className="text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-current"
                href={prefixPath(
                  emailAccountId,
                  `/automation?tab=history&action=${name}`,
                )}
              >
                {text}
              </Link>
            ) : (
              text
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function partText(name: HistoryAction, count: number, withNoun: boolean) {
  const emails = withNoun ? ` ${count === 1 ? "email" : "emails"}` : "";
  if (name === "sorted") return `sorted ${count}${emails}`;
  if (name === "archived") return `archived ${count}${emails}`;
  return `drafted ${count} ${count === 1 ? "reply" : "replies"}`;
}

function separator(index: number, length: number) {
  if (index === 0) return null;
  return index === length - 1 ? " and " : ", ";
}

/** When the window starts, in the user's own day: "Since yesterday". */
export function sinceLabel(since: Date, capped: boolean, now = new Date()) {
  if (capped) return "In the last week";
  if (isSameDay(since, now)) return "Since earlier today";
  if (isSameDay(since, subDays(now, 1))) return "Since yesterday";
  // Within the week, so the weekday names one day.
  if (now.getTime() - since.getTime() < 6 * 86_400_000)
    return `Since ${format(since, "EEEE")}`;
  return `Since ${format(since, "MMM d")}`;
}

function hasWork(counts: AccountCounts) {
  return HISTORY_ACTION_NAMES.some((name) => counts[name] > 0);
}

function sum(accounts: AccountCounts[]) {
  return Object.fromEntries(
    HISTORY_ACTION_NAMES.map((name) => [
      name,
      accounts.reduce((total, counts) => total + counts[name], 0),
    ]),
  ) as Record<HistoryAction, number>;
}
