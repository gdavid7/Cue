"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyedMutator } from "swr";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import {
  type AllInboxesAccount,
  getAllInboxesAccounts,
} from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { useStableCallback } from "@/app/(app)/[emailAccountId]/mail/use-stable-callback";
import { useAccounts } from "@/hooks/useAccounts";
import { useHome } from "@/hooks/useHome";
import { TODAY_SCOPE_PARAM } from "@/hooks/useTodayHref";
import {
  type AccountHome,
  mergeHomeData,
  type TodayAccount,
} from "@/utils/home/merge-home";

type AccountFeed = Omit<AccountHome, "account">;
type FeedControls = {
  mutate: KeyedMutator<GetHomeResponse>;
  retry: () => void;
};

const NO_ACCOUNTS: AllInboxesAccount[] = [];

/**
 * The accounts Today shows together, from `?accounts=all`: those in All
 * inboxes, while there are two or more. Empty while the list loads; null for
 * one account's Today.
 */
export function useTodayAccounts(): AllInboxesAccount[] | null {
  const allAccounts = useSearchParams()?.get(TODAY_SCOPE_PARAM) === "all";
  const { data } = useAccounts();
  return useMemo(() => {
    if (!allAccounts) return null;
    if (!data) return NO_ACCOUNTS;
    const accounts = getAllInboxesAccounts(data.emailAccounts);
    return accounts.length > 1 ? accounts : null;
  }, [allAccounts, data]);
}

/**
 * Today for several accounts. Each loads as its own Today does, through its
 * own request, which the server checks is the user's, with its own cache,
 * pending refreshes and quota. Render `loaders` for them to load.
 */
export function useAllAccountsHome(accounts: AllInboxesAccount[] | null) {
  const [feeds, setFeeds] = useState<Record<string, AccountFeed>>({});
  const controls = useRef(new Map<string, FeedControls>());
  const report = useCallback(
    (accountId: string, feed: AccountFeed, control: FeedControls) => {
      controls.current.set(accountId, control);
      setFeeds((current) => {
        const previous = current[accountId];
        if (
          previous &&
          previous.data === feed.data &&
          previous.error === feed.error &&
          previous.gaveUp === feed.gaveUp
        )
          return current;
        return { ...current, [accountId]: feed };
      });
    },
    [],
  );

  const todayAccounts = useMemo(
    () =>
      accounts?.map(({ id, email }): TodayAccount => ({ id, email })) ?? null,
    [accounts],
  );
  const merged = useMemo(() => {
    if (!todayAccounts) return null;
    const entries = todayAccounts.map(
      (account): AccountHome => ({
        ...(feeds[account.id] ?? { gaveUp: false }),
        account,
      }),
    );
    const { data, failedAccountIds } = mergeHomeData(entries);
    const errors = entries.filter(
      (entry) => !entry.data && entry.error !== undefined,
    );
    return {
      data: data ?? undefined,
      failedAccountIds,
      // Until one account answers, as one account's Today waits for it, and
      // while the account list itself loads.
      isLoading:
        !data && (entries.length === 0 || errors.length < entries.length),
      error:
        !data && entries.length > 0 && errors.length === entries.length
          ? errors[0].error
          : undefined,
    };
  }, [feeds, todayAccounts]);

  return {
    merged,
    loaders: todayAccounts?.map((account) => (
      <HomeAccountFeed
        accountId={account.id}
        key={account.id}
        onReport={report}
      />
    )),
    mutateAccount: useCallback(
      (accountId: string) => controls.current.get(accountId)?.mutate,
      [],
    ),
    retryAccounts: useCallback((accountIds: string[]) => {
      for (const accountId of accountIds)
        controls.current.get(accountId)?.retry();
    }, []),
  };
}

function HomeAccountFeed({
  accountId,
  onReport,
}: {
  accountId: string;
  onReport: (
    accountId: string,
    feed: AccountFeed,
    control: FeedControls,
  ) => void;
}) {
  const { data, error, gaveUp, mutate, retry } = useHome(accountId);
  const stableRetry = useStableCallback(retry);
  useEffect(() => {
    onReport(
      accountId,
      { data, error, gaveUp },
      { mutate, retry: stableRetry },
    );
  }, [accountId, data, error, gaveUp, mutate, onReport, stableRetry]);
  return null;
}
