"use client";

import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { rememberLastEmailAccount } from "@/utils/last-email-account";
import { unownedAccountRedirectUrl } from "@/utils/account-switch-url";
import { ownedLastEmailAccountId } from "@/utils/cookies";
import { reindexMailPath } from "@/utils/mail-url";
import { staleChatParams } from "@/utils/chat-url";
import { toastInfo } from "@/components/Toast";
import {
  fetchEmailAccounts,
  subscribeEmailAccounts,
} from "@/utils/fetch-email-accounts";
import { setBrowserCacheUser } from "@/utils/browser-cache";

type Context = {
  /**
   * The user's account ids in connection order: an account's position is the
   * `n` in its `/mail/u/{n}` address.
   */
  accountIds: readonly string[];
  emailAccount: GetEmailAccountsResponse["emailAccounts"][number] | undefined;
  emailAccountId: string;
  /** The signed-in user, from the server; empty outside the app. */
  userId: string;
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
  userId: "",
  userEmail: "",
  isLoading: false,
  provider: "",
  providerRateLimit: null,
};

export function EmailAccountProvider({
  children,
  accounts: serverAccounts = NO_ACCOUNTS,
  userId = "",
}: {
  children: React.ReactNode;
  /**
   * Rendered on the server, so `/mail/u/{n}` resolves and the mail engine
   * can start before the full account list loads.
   */
  accounts?: ServerEmailAccount[];
  userId?: string;
}) {
  // Before any child reads the browser caches: their entries are this user's.
  setBrowserCacheUser(
    userId,
    serverAccounts.map((account) => account.id),
  );
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
  // tab or device) shifts the list. The page stays on the account it opened
  // until the address agrees, and every position a rewrite has given it
  // names that account meanwhile.
  const [pin, setPin] = useState<AddressPin | null>(null);
  // The list as of the last change handled: what the app wrote addresses
  // with since then.
  const handledAccountIdsRef = useRef(accountIds);
  const activePin =
    params.accountIndex !== undefined &&
    pin?.addresses.some(
      (address) => address.accountIndex === params.accountIndex,
    )
      ? pin
      : null;
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
      rememberLastEmailAccount(ownedRouteId).catch(() => {});
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

  // Once the router lands anywhere, by a rewrite or by the user navigating,
  // only the latest rewrite and the address now showing can still be in
  // flight or current; older positions no longer name the pinned account.
  const seenPathRef = useRef<string | null>(null);
  // Matched by path: a query change on the old path (the chat clearing its
  // parameters) is not the router landing anywhere.
  const forgetLandedAddresses = useCallback(() => {
    const current = window.location.pathname;
    if (seenPathRef.current === current) return;
    seenPathRef.current = current;
    setPin((previous) => {
      if (!previous || previous.addresses.length < 2) return previous;
      const latest = previous.addresses.at(-1);
      const kept =
        latest && pathOf(latest.url) === current
          ? [latest]
          : previous.addresses.filter(
              (address) =>
                address === latest || pathOf(address.url) === current,
            );
      return kept.length === previous.addresses.length
        ? previous
        : { ...previous, addresses: kept };
    });
  }, []);

  useEffect(() => {
    if (params.accountIndex === undefined || activePin) return;
    const current = currentUrl();
    const accountId = accountIds[Number(params.accountIndex)];
    if (accountId)
      setPin({
        accountId,
        addresses: [
          { url: current, accountIndex: params.accountIndex, accountIds },
        ],
      });
  }, [accountIds, activePin, params.accountIndex]);

  useEffect(() => {
    const previousAccountIds = handledAccountIdsRef.current;
    if (previousAccountIds.join() === accountIds.join()) return;
    if (!data || !emailAccount) return;
    handledAccountIdsRef.current = accountIds;
    if (!activePin || params.accountIndex === undefined) return;

    const current = currentUrl();
    // The address's positions refer to the list it was written with: the
    // rewrite's or the opening address's while the router hasn't moved, or
    // otherwise the list the app had when the user last navigated.
    const written = activePin.addresses.findLast(
      (address) => address.url === current,
    ) ?? {
      url: current,
      accountIndex: params.accountIndex,
      accountIds: previousAccountIds,
    };
    const pinnedIndex = accountIds.indexOf(activePin.accountId);
    const accountId = pinnedIndex >= 0 ? activePin.accountId : emailAccount.id;
    const accountIndex = accountIds.indexOf(accountId);
    if (pinnedIndex < 0)
      toastInfo({
        title: "That account is no longer connected",
        description: `Now showing ${emailAccount.email}`,
      });
    const next = reindexMailPath({
      pathname: window.location.pathname,
      search: window.location.search,
      accountIndex,
      previousAccountIds: written.accountIds,
      accountIds,
      // Otherwise the removed account's chat would come back with the page.
      dropParams: staleChatParams(window.location.search, accountIds),
    });
    if (!next || next === current) {
      setPin({
        accountId,
        addresses: [
          { url: current, accountIndex: String(accountIndex), accountIds },
        ],
      });
      return;
    }
    const sent = activePin.addresses.includes(written)
      ? activePin.addresses
      : [...activePin.addresses, written];
    setPin({
      accountId,
      addresses: [
        ...sent,
        { url: next, accountIndex: String(accountIndex), accountIds },
      ],
    });
    router.replace(next);
  }, [accountIds, activePin, data, emailAccount, params.accountIndex, router]);

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
        userId,
        userEmail: emailAccount?.email ?? serverAccount?.email ?? "",
        provider:
          emailAccount?.account?.provider ?? serverAccount?.provider ?? "",
        providerRateLimit: emailAccount?.providerRateLimit ?? null,
      }}
    >
      {/* Search params suspend while a page renders statically. */}
      <Suspense fallback={null}>
        <AddressWatcher onNavigate={forgetLandedAddresses} />
      </Suspense>
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
            userId: parent.userId,
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

type AddressPin = {
  /** The account the page shows. */
  accountId: string;
  /**
   * The address the page had, then each rewrite sent to the router, with the
   * account list each was written for. All their positions name the account
   * until the router lands on the last one.
   */
  addresses: {
    url: string;
    accountIndex: string;
    accountIds: readonly string[];
  }[];
};

/**
 * Reports each change of the page's address. Kept apart so the app-wide
 * provider does not re-render on every navigation.
 */
function AddressWatcher({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on each address change
  useEffect(() => {
    onNavigate();
  }, [onNavigate, pathname, searchParams]);
  return null;
}

function pathOf(url: string) {
  return url.split("?")[0];
}

function currentUrl() {
  return `${window.location.pathname}${window.location.search}`;
}

export function useAccount() {
  const context = useContext(EmailAccountContext);

  if (context === undefined) {
    throw new Error(
      "useEmailAccount must be used within an EmailAccountProvider",
    );
  }

  return context;
}
