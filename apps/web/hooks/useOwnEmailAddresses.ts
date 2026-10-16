import { useMemo } from "react";
import { useAccounts } from "@/hooks/useAccounts";
import { useAccount } from "@/providers/EmailAccountProvider";

/**
 * Every address the user has connected. Mail between them is the user, so
 * none of them is copied on a reply all or named as anyone but "me".
 */
export function useOwnEmailAddresses() {
  const { userEmail } = useAccount();
  const { data } = useAccounts();
  return useMemo(
    () => [
      userEmail,
      ...(data?.emailAccounts.map((account) => account.email) ?? []),
    ],
    [userEmail, data],
  );
}
