"use client";

import useSWR, { type SWRConfiguration } from "swr";
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
