"use client";

import {
  useCallback,
  useState,
  createContext,
  useMemo,
  useEffect,
  useRef,
} from "react";
import { SWRConfig, mutate, useSWRConfig } from "swr";
import { useAccount } from "@/providers/EmailAccountProvider";
import { swrFetcher } from "./swr-fetcher";
import {
  accountIdFromSnapshotKey,
  clearPersistedSwrCacheForAccount,
  PERSISTED_SWR_KEYS,
  persistSwrEntries,
  readPersistedSwrEntries,
} from "@/utils/swr-persistence";
import {
  shouldResetSwrCacheForAccountId,
  shouldRevalidateAllLiveSwrKeysForAccountId,
  getDevSWRErrorRetryMs,
  onSWRErrorRetry,
} from "@/utils/swr";

// swr/infinite stores each list under its first page's key with this prefix.
const INFINITE_KEY_PREFIX = "$inf$";

interface Context {
  resetCache: () => void;
}

const defaultContextValue = {
  resetCache: () => {},
};

export const SWRContext = createContext<Context>(defaultContextValue);

export const SWRProvider = (props: { children: React.ReactNode }) => {
  const [provider, setProvider] = useState(new Map());
  const { emailAccountId } = useAccount();
  const previousEmailAccountIdRef = useRef<string | null>(null);

  const resetCache = useCallback(() => {
    // based on: https://swr.vercel.app/docs/mutation#mutate-multiple-items
    mutate(() => true, undefined, { revalidate: false });

    // not sure we also need this approach anymore to clear cache but keeping both for now
    setProvider(new Map());
  }, []);

  // Replace the provider Map on account switch. Empty → id is handled inside
  // SWRConfig: module-level mutate() talks to SWR's default cache, not this
  // custom Map, so it cannot drop a first-paint 403.
  useEffect(() => {
    const previousEmailAccountId = previousEmailAccountIdRef.current;
    if (
      shouldResetSwrCacheForAccountId(previousEmailAccountId, emailAccountId) &&
      previousEmailAccountId !== ""
    ) {
      resetCache();
    }
    previousEmailAccountIdRef.current = emailAccountId;
  }, [emailAccountId, resetCache]);

  const enhancedFetcher = useCallback(
    async (keyOrUrl: string | [string, string], init?: RequestInit) => {
      if (Array.isArray(keyOrUrl)) {
        const [url, overrideEmailAccountId] = keyOrUrl;
        return swrFetcher(url, init, overrideEmailAccountId);
      }
      return swrFetcher(keyOrUrl, init, emailAccountId);
    },
    [emailAccountId],
  );

  const value = useMemo(() => ({ resetCache }), [resetCache]);

  return (
    <SWRContext.Provider value={value}>
      <SWRConfig
        value={{
          fetcher: enhancedFetcher,
          provider: () => provider,
          onError: (error: unknown) => console.log("SWR error:", error),
          onErrorRetry: onSWRErrorRetry,
          ...getDevOnlySWRConfig(),
        }}
      >
        <PersistedSwrCache />
        {props.children}
      </SWRConfig>
    </SWRContext.Provider>
  );
};

/**
 * Hydrates whitelisted SWR entries from localStorage and snapshots them back.
 * Must live inside SWRConfig: SWR initializes its cache from the provider
 * exactly once, so only the scoped `cache`/`mutate` from useSWRConfig reach
 * the live cache. Hydrating in an effect (after the hydration render) keeps
 * client and server HTML identical.
 */
function PersistedSwrCache() {
  const { cache, mutate: scopedMutate } = useSWRConfig();
  const { emailAccountId } = useAccount();
  const hydratedForRef = useRef<string | null>(null);
  const previousEmailAccountIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (hydratedForRef.current === emailAccountId) return;
    if (!emailAccountId) {
      hydratedForRef.current = "";
      return;
    }
    const isAccountSwitch = hydratedForRef.current !== null;
    // Empty → id is a first account, not a switch: the effect below
    // revalidates that.
    const previousAccountId = hydratedForRef.current;
    hydratedForRef.current = emailAccountId;
    const persisted = readPersistedSwrEntries(emailAccountId);
    if (previousAccountId) {
      // Keys without the account in them (/api/user/group, the chat list…)
      // still hold the previous account's data, and a failed refresh leaves
      // data on screen. Hooks still mounted ask again for this account; a
      // clear without revalidating would also drop the fetch they already
      // started, leaving them loading. Persisted keys are re-seeded below.
      const isKeptOnSwitch = (key: unknown) =>
        (PERSISTED_SWR_KEYS as readonly unknown[]).includes(key) ||
        (Array.isArray(key) && key.includes(emailAccountId));
      scopedMutate((key) => !isKeptOnSwitch(key), undefined, {
        revalidate: true,
      });
      // That filter skips useSWRInfinite's entries, which hold the pages a
      // list shows. Each is named after its first page's key, whose cache
      // entry keeps the original key to judge it by.
      for (const key of [...cache.keys()]) {
        if (!key.startsWith(INFINITE_KEY_PREFIX)) continue;
        // `_k` is where SWR keeps an entry's original key; it isn't typed.
        const firstPage = cache.get(key.slice(INFINITE_KEY_PREFIX.length)) as
          | { _k?: unknown }
          | undefined;
        if (isKeptOnSwitch(firstPage?._k)) continue;
        scopedMutate(key, undefined, { revalidate: true });
      }
    }
    for (const key of PERSISTED_SWR_KEYS) {
      const data = persisted.get(key)?.data;
      if (isAccountSwitch) {
        // The provider reset doesn't reach the live scoped cache (SWR only
        // initializes its provider once), so the previous account's values
        // still occupy these keys. Replace them with this account's snapshot
        // (or clear them) so they can't render or get persisted under the
        // wrong account.
        scopedMutate(key, data, { populateCache: true, revalidate: false });
      } else if (data !== undefined && cache.get(key)?.data === undefined) {
        scopedMutate(key, data, { populateCache: true, revalidate: false });
      }
    }
  }, [emailAccountId, cache, scopedMutate]);

  useEffect(() => {
    const previousEmailAccountId = previousEmailAccountIdRef.current;
    if (
      shouldRevalidateAllLiveSwrKeysForAccountId(
        previousEmailAccountId,
        emailAccountId,
      )
    ) {
      scopedMutate(shouldRevalidateLiveKeyOnEmptyAccountId);
    }
    previousEmailAccountIdRef.current = emailAccountId;
  }, [emailAccountId, scopedMutate]);

  // If another tab removes an account's snapshot (logout or account
  // deletion), stop this tab from re-persisting it out of its warm cache.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.newValue !== null) return;
      const removedAccountId = accountIdFromSnapshotKey(event.key ?? "");
      if (removedAccountId) clearPersistedSwrCacheForAccount(removedAccountId);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Snapshot when the app is backgrounded, closed, or this account unmounts;
  // there is no per-write hook on the SWR cache, and the visibility event also
  // covers the desktop shell hiding its window.
  useEffect(() => {
    if (!emailAccountId) return;

    const persist = () => persistSwrEntries(emailAccountId, cache);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") persist();
    };

    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      persist();
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [emailAccountId, cache]);

  return null;
}

// Dev-only config to handle transient 404s during HMR
function getDevOnlySWRConfig() {
  if (process.env.NODE_ENV !== "development") return {};

  return {
    keepPreviousData: true,
    onErrorRetry: (
      error: Error & { status?: number },
      _key: string,
      _config: unknown,
      revalidate: (opts: { retryCount: number }) => void,
      { retryCount }: { retryCount: number },
    ) => {
      const delayMs = getDevSWRErrorRetryMs(error, retryCount);
      if (delayMs == null) return;
      setTimeout(() => revalidate({ retryCount }), delayMs);
    },
  };
}

function shouldRevalidateLiveKeyOnEmptyAccountId(key: unknown) {
  const path = Array.isArray(key) ? key[0] : key;
  if (typeof path !== "string") return true;
  return !(PERSISTED_SWR_KEYS as readonly string[]).includes(path);
}
