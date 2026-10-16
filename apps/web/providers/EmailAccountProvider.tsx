"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { setLastEmailAccountAction } from "@/utils/actions/email-account-cookie";
import { unownedAccountRedirectUrl } from "@/utils/account-switch-url";
import { ownedLastEmailAccountId } from "@/utils/cookies";
import { reindexMailPath } from "@/utils/mail-url";
import { toastInfo } from "@/components/Toast";
import {
  fetchEmailAccounts,
  subscribeEmailAccounts,
} from "@/utils/fetch-email-accounts";

type Context = {
  /**
   * The user's account ids in connection order: an account's position is the
   * `n` in its `/mail/u/{n}` address.
   */
  accountIds: readonly string[];
  emailAccount: GetEmailAccountsResponse["emailAccounts"][number] | undefined;
  emailAccountId: string;
  userEmail: string;
  isLoading: boolean;
  provider: string;
  providerRateLimit:
    | GetEmailAccountsResponse["emailAccounts"][number]["providerRateLimit"]
    | null;
};

type EmailAccount = GetEmailAccountsResponse["emailAccounts"][number];

/** An account as the server lists it, in connection order. */
export type ServerEmailAccount = {
  id: string;
  email: string;
  provider: string;
};

const NO_ACCOUNTS: ServerEmailAccount[] = [];

const EmailAccountContext = createContext<Context | undefined>(undefined);

const previewContextValue: Context = {
  accountIds: [],
  emailAccount: undefined,
  emailAccountId: "",
  userEmail: "",
  isLoading: false,
  provider: "",
  providerRateLimit: null,
};

export function EmailAccountProvider({
  children,
  accounts: serverAccounts = NO_ACCOUNTS,
}: {
  children: React.ReactNode;
  /**
   * Rendered on the server, so `/mail/u/{n}` resolves and the mail engine
   * can start before the full account list loads.
   */
  accounts?: ServerEmailAccount[];
}) {
  const params = useParams<{
    emailAccountId: string | undefined;
    accountIndex: string | undefined;
  }>();
  const emailAccountId = params.emailAccountId;
  const router = useRouter();
  const [data, setData] = useState<GetEmailAccountsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const loadedAccountIds = useMemo(
    () => data?.emailAccounts.map((account) => account.id),
    [data],
  );
  const serverAccountIds = useMemo(
    () => serverAccounts.map((account) => account.id),
    [serverAccounts],
  );
  const accountIds = loadedAccountIds ?? serverAccountIds;
  // `/mail/u/{n}` is a position, and removing an earlier account (in another
  // tab or device) shifts the list. The page stays on the account it opened.
  const [pin, setPin] = useState<IndexPin | null>(null);
  const activePin = pin?.accountIndex === params.accountIndex ? pin : null;
  const indexedAccountId =
    params.accountIndex === undefined
      ? undefined
      : activePin
        ? activePin.accountId
        : accountIds[Number(params.accountIndex)];
  const ownedRouteId = ownedLastEmailAccountId(
    emailAccountId ?? indexedAccountId ?? null,
    accountIds,
  );
  const lastKnownEmailAccountId = ownedLastEmailAccountId(
    data?.lastEmailAccountId ?? null,
    accountIds,
  );

  useEffect(() => {
    // This provider wraps SWRProvider, so it cannot useAccounts(). SWR mutate
    // still revalidates through fetchEmailAccounts, which notifies listeners.
    const unsubscribe = subscribeEmailAccounts(setData);
    fetchEmailAccounts()
      .then(setData)
      .catch((error) => {
        console.error("Error fetching accounts:", error);
      })
      .finally(() => setIsLoading(false));
    return unsubscribe;
  }, []);

  useEffect(() => {
    // The server's id list owns the route before accounts load, but only the
    // loaded list says which account the cookie already remembers.
    if (!data) return;
    if (ownedRouteId && ownedRouteId !== lastKnownEmailAccountId) {
      setLastEmailAccountAction({ emailAccountId: ownedRouteId }).catch(
        () => {},
      );
    }
  }, [data, ownedRouteId, lastKnownEmailAccountId]);

  const emailAccount = useMemo(() => {
    if (!data?.emailAccounts.length) return;
    return (
      data.emailAccounts.find((account) => account.id === ownedRouteId) ??
      data.emailAccounts.find(
        (account) => account.id === lastKnownEmailAccountId,
      ) ??
      data.emailAccounts[0]
    );
  }, [data, ownedRouteId, lastKnownEmailAccountId]);

  useEffect(() => {
    if (!data) return;
    // Pathname is read here so this app-wide provider does not re-render on
    // every account-scoped navigation.
    const next = unownedAccountRedirectUrl({
      pathname: window.location.pathname,
      routeAccountId: emailAccountId,
      ownedRouteId,
      fallbackAccountId: emailAccount?.id,
      tab: null,
    });
    if (next) router.replace(next);
  }, [data, emailAccount?.id, emailAccountId, ownedRouteId, router]);

  useEffect(() => {
    if (params.accountIndex === undefined || activePin) return;
    const accountId = accountIds[Number(params.accountIndex)];
    if (accountId)
      setPin({ accountIndex: params.accountIndex, accountId, accountIds });
  }, [accountIds, activePin, params.accountIndex]);

  useEffect(() => {
    if (!data || !activePin || !emailAccount) return;
    const pinnedIndex = accountIds.indexOf(activePin.accountId);
    const accountIndex =
      pinnedIndex >= 0 ? pinnedIndex : accountIds.indexOf(emailAccount.id);
    if (String(accountIndex) === activePin.accountIndex) return;
    if (pinnedIndex < 0)
      toastInfo({ description: "That account is no longer connected" });
    const next = reindexMailPath({
      pathname: window.location.pathname,
      search: window.location.search,
      accountIndex,
      previousAccountIds: activePin.accountIds,
      accountIds,
    });
    if (next) router.replace(next);
  }, [accountIds, activePin, data, emailAccount, router]);

  const resolvedEmailAccountId =
    ownedRouteId ?? (data ? (emailAccount?.id ?? "") : (emailAccountId ?? ""));
  const serverAccount = serverAccounts.find(
    (account) => account.id === resolvedEmailAccountId,
  );

  return (
    <EmailAccountContext.Provider
      value={{
        accountIds,
        emailAccount,
        isLoading,
        emailAccountId: resolvedEmailAccountId,
        userEmail: emailAccount?.email ?? serverAccount?.email ?? "",
        provider:
          emailAccount?.account?.provider ?? serverAccount?.provider ?? "",
        providerRateLimit: emailAccount?.providerRateLimit ?? null,
      }}
    >
      {children}
    </EmailAccountContext.Provider>
  );
}

export function EmailAccountPreviewProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <EmailAccountContext.Provider value={previewContextValue}>
      {children}
    </EmailAccountContext.Provider>
  );
}

/**
 * Temporarily scopes account-aware descendants without changing the route,
 * last-account cookie, or the app-wide SWR cache. This lets a combined inbox
 * reader operate as the row's owning account while the surrounding page stays
 * on All Accounts.
 */
export function EmailAccountScopeProvider({
  children,
  emailAccount,
}: {
  children: React.ReactNode;
  emailAccount?: EmailAccount;
}) {
  const parent = useAccount();
  const value = useMemo<Context>(
    () =>
      emailAccount
        ? {
            accountIds: parent.accountIds,
            emailAccount,
            emailAccountId: emailAccount.id,
            userEmail: emailAccount.email,
            isLoading: false,
            provider: emailAccount.account.provider,
            providerRateLimit: emailAccount.providerRateLimit,
          }
        : parent,
    [emailAccount, parent],
  );

  return (
    <EmailAccountContext.Provider value={value}>
      {children}
    </EmailAccountContext.Provider>
  );
}

type IndexPin = {
  accountIndex: string;
  accountId: string;
  /** The list the address's indexes referred to when the page opened it. */
  accountIds: readonly string[];
};

export function useAccount() {
  const context = useContext(EmailAccountContext);

  if (context === undefined) {
    throw new Error(
      "useEmailAccount must be used within an EmailAccountProvider",
    );
  }

  return context;
}
