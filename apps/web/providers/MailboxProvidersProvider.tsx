"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { MailboxProvider } from "@/utils/oauth/provider-config";

const MailboxProvidersContext = createContext<
  readonly MailboxProvider[] | null
>(null);

export function MailboxProvidersProvider({
  enabledProviders,
  children,
}: {
  enabledProviders: readonly MailboxProvider[];
  children: ReactNode;
}) {
  return (
    <MailboxProvidersContext.Provider value={enabledProviders}>
      {children}
    </MailboxProvidersContext.Provider>
  );
}

export function useEnabledMailboxProviders(): readonly MailboxProvider[] {
  const enabledProviders = useContext(MailboxProvidersContext);
  if (!enabledProviders) {
    throw new Error(
      "useEnabledMailboxProviders must be used within MailboxProvidersProvider",
    );
  }
  return enabledProviders;
}
