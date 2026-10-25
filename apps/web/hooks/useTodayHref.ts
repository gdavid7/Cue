"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { getAllInboxesAccounts } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { useAccounts } from "@/hooks/useAccounts";
import { useAccount } from "@/providers/EmailAccountProvider";
import { parseMailPath } from "@/utils/mail-url";
import { prefixPath } from "@/utils/path";

/** `?accounts=all` on Today: every account in All inboxes, as one Today. */
export const TODAY_SCOPE_PARAM = "accounts";
const ALL_ACCOUNTS = "all";
const STORAGE_KEY = "cue:account-scope";

type AccountScope = "all" | "account";

export function getTodayPath(emailAccountId: string, allAccounts: boolean) {
  const path = prefixPath(emailAccountId, "/home");
  return allAccounts ? `${path}?${TODAY_SCOPE_PARAM}=${ALL_ACCOUNTS}` : path;
}

/**
 * Whether the open page shows All inboxes or Today across accounts, one
 * account, or neither, as an account's own settings and tools.
 */
export function getPageAccountScope(
  pathname: string,
  search: string,
): AccountScope | null {
  const mail = parseMailPath(pathname, search);
  if (mail) return mail.allInboxes ? "all" : "account";
  if (!pathname.endsWith("/home")) return null;
  return new URLSearchParams(search).get(TODAY_SCOPE_PARAM) === ALL_ACCOUNTS
    ? "all"
    : "account";
}

/**
 * Whether the user is looking at all their accounts together: on All inboxes
 * or Today across accounts, or, on a page of neither, last time they were.
 * Only with two or more accounts in All inboxes.
 */
export function useAllAccountsScope() {
  const pathname = usePathname() ?? "";
  const search = useSearchParams()?.toString() ?? "";
  const pageScope = getPageAccountScope(pathname, search);
  const storedScope = useSyncExternalStore(
    subscribeToStoredScope,
    readStoredScope,
    () => null,
  );
  useEffect(() => {
    if (pageScope) writeStoredScope(pageScope);
  }, [pageScope]);
  const { data } = useAccounts();
  const hasAllInboxes =
    getAllInboxesAccounts(data?.emailAccounts ?? []).length > 1;
  return hasAllInboxes && (pageScope ?? storedScope) === "all";
}

/**
 * Today for what the user is looking at: one account, or all of them. Null
 * until there is an account, as `/home` alone is only a redirect; links keep
 * their place and wait rather than fetch or open it.
 */
export function useTodayHref() {
  const { emailAccountId } = useAccount();
  const allAccounts = useAllAccountsScope();
  return emailAccountId ? getTodayPath(emailAccountId, allAccounts) : null;
}

function readStoredScope(): AccountScope | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "all" || value === "account" ? value : null;
  } catch {
    return null;
  }
}

function writeStoredScope(scope: AccountScope) {
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === scope) return;
    window.localStorage.setItem(STORAGE_KEY, scope);
    // Storage events reach other tabs only; this one hears it too.
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
  } catch {
    // Without storage, pages that aren't mail or Today show one account.
  }
}

function subscribeToStoredScope(onChange: () => void) {
  const listener = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
