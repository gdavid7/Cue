import {
  buildMailPath,
  mailPathForAccount,
  parseMailPath,
  withPageParams,
} from "@/utils/mail-url";

/**
 * Where switching to another account lands: the same built-in view or search
 * when there is one, since labels, folders, split tabs and threads belong to
 * the account being left. Unrelated query parameters ride along.
 */
export function getMailAccountUrl(
  accountIds: readonly string[],
  accountId: string,
  current?: { pathname: string; search: string },
) {
  const accountIndex = accountIds.indexOf(accountId);
  if (accountIndex < 0) return mailPathForAccount(accountIds, accountId);
  const view = current
    ? parseMailPath(current.pathname, current.search)?.view
    : undefined;
  return withPageParams(
    buildMailPath({
      accountIndex,
      view: view?.kind === "type" || view?.kind === "search" ? view : undefined,
    }),
    current?.search ?? "",
    // The side panel's thread belongs to the account being left too.
    ["side-panel-thread-id"],
  );
}
