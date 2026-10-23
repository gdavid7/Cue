"use client";

import { useMemo } from "react";
import type { Provider } from "@inboxzero/mail-core/identities";
import { useAccount } from "@/providers/EmailAccountProvider";
import { engineProvider } from "@/utils/mail-engine/engine-accounts";

/**
 * The routed account's provider, for views of that account alone. Empty while
 * the account is still loading, which leaves the provider unknown.
 */
export function useRoutedAccountProviders(
  emailAccountId: string,
): ReadonlyMap<string, Provider> {
  const { provider } = useAccount();
  return useMemo(
    () => new Map(provider ? [[emailAccountId, engineProvider(provider)]] : []),
    [emailAccountId, provider],
  );
}
