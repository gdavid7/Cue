"use client";

import {
  type AllInboxesAccount,
  getAccountColorClassName,
} from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { AccountMarker } from "@/app/(app)/[emailAccountId]/mail/ThreadRow";

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
