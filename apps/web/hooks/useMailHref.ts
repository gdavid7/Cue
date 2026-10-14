import { useCallback } from "react";
import { useAccount } from "@/providers/EmailAccountProvider";
import { type MailUrl, mailPathForAccount } from "@/utils/mail-url";

/**
 * Builds a link into the mail screen (`/mail/u/{n}/…`) for the current
 * account, or another one by id. Every mail link goes through here or
 * `buildMailPath`, so the address scheme has one owner.
 */
export function useMailHref() {
  const { emailAccountId, accountIds } = useAccount();
  return useCallback(
    ({
      accountId = emailAccountId,
      ...url
    }: Omit<MailUrl, "accountIndex"> & { accountId?: string } = {}) =>
      mailPathForAccount(accountIds, accountId, url),
    [accountIds, emailAccountId],
  );
}
