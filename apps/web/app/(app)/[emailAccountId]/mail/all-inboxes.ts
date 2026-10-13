import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import type { CombinedListThread } from "@/utils/threads/load-combined";

// Indexed by an account's position in All inboxes, so two accounts that share a
// name or profile photo still read as different mailboxes on each row.
const ACCOUNT_COLOR_CLASS_NAMES = [
  "bg-blue-600",
  "bg-violet-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-600",
  "bg-fuchsia-500",
  "bg-lime-600",
];

export type AllInboxesAccount = CombinedListThread["account"] & {
  provider: string;
};

/** Connected accounts the user has chosen to show in All inboxes, in account order. */
export function getAllInboxesAccounts(
  emailAccounts: GetEmailAccountsResponse["emailAccounts"],
): AllInboxesAccount[] {
  return emailAccounts
    .filter(
      (emailAccount) =>
        emailAccount.includeInAllAccounts &&
        emailAccount.account.disconnectedAt === null,
    )
    .map(({ id, email, name, image, account }) => ({
      id,
      email,
      name,
      image,
      provider: account.provider,
    }));
}

export function getAccountColorClassName(index: number) {
  return ACCOUNT_COLOR_CLASS_NAMES[index % ACCOUNT_COLOR_CLASS_NAMES.length];
}

/**
 * Whether an account's sidebar section in All inboxes is open. The user's own
 * choice wins; until they make one, two accounts fit open but more would bury
 * each other.
 */
export function isAccountSectionOpen({
  storedOpen,
  accountCount,
}: {
  storedOpen: boolean | null;
  accountCount: number;
}) {
  return storedOpen ?? accountCount <= 2;
}
