import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { getAllInboxesAccounts } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { isGoogleProvider } from "@/utils/email/provider-types";

/**
 * The accounts Deep Clean may run in while the user looks at All inboxes: the
 * Gmail ones they included there. It runs in one of them at a time, never in
 * an account left out of All inboxes.
 */
export function getDeepCleanAccounts(
  emailAccounts: GetEmailAccountsResponse["emailAccounts"],
) {
  return getAllInboxesAccounts(emailAccounts).filter((account) =>
    isGoogleProvider(account.provider),
  );
}
