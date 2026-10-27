import { swrFetcher } from "@/providers/swr-fetcher";

/**
 * Reads an account-scoped route for each account, as that account, so the
 * server checks each one is the user's. Accounts that fail are listed rather
 * than failing the rest; only when every account fails does this throw.
 * `path` may differ per account.
 */
export async function fetchForAccounts<T>(
  path: string | ((accountId: string) => string),
  accountIds: string[],
) {
  const results = await Promise.allSettled(
    accountIds.map(
      (accountId) =>
        swrFetcher(
          typeof path === "string" ? path : path(accountId),
          undefined,
          accountId,
        ) as Promise<T>,
    ),
  );
  const failedAccountIds = accountIds.filter(
    (_, index) => results[index].status === "rejected",
  );
  const firstFailure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (firstFailure && failedAccountIds.length === accountIds.length)
    throw firstFailure.reason;
  return {
    byAccount: accountIds.flatMap((accountId, index) => {
      const result = results[index];
      return result.status === "fulfilled"
        ? [{ accountId, data: result.value }]
        : [];
    }),
    failedAccountIds,
  };
}
