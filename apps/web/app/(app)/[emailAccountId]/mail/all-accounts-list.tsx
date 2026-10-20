"use client";

import useSWR, { type SWRConfiguration } from "swr";
import {
  type AllInboxesAccount,
  getAccountColorClassName,
} from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { AccountMarker } from "@/app/(app)/[emailAccountId]/mail/ThreadRow";
import { fetchForAccounts } from "@/utils/fetch-for-accounts";

type AccountsResult<T> = Awaited<ReturnType<typeof fetchForAccounts<T>>>;

/**
 * An account-scoped list read for every account in All inboxes, each as
 * itself, for views kept in Cue's database rather than the mailbox. Null
 * `accounts` reads nothing.
 */
export function useAllAccountsList<T>(
  path: string,
  accounts: { id: string }[] | undefined,
  config?: SWRConfiguration<AccountsResult<T>>,
) {
  const accountIds = accounts?.map((account) => account.id);
  return useSWR<AccountsResult<T>>(
    accountIds ? [path, "all-accounts", ...accountIds] : null,
    () => fetchForAccounts<T>(path, accountIds ?? []),
    config,
  );
}

/** The marker naming a row's account, colored as All inboxes colors it. */
export function AccountRowMarker({
  accounts,
  accountId,
}: {
  accounts: AllInboxesAccount[] | undefined;
  accountId: string;
}) {
  const index = accounts?.findIndex((account) => account.id === accountId);
  const account = index === undefined ? undefined : accounts?.[index];
  if (!account || index === undefined) return null;
  return (
    <AccountMarker
      account={account}
      colorClassName={getAccountColorClassName(index)}
    />
  );
}
