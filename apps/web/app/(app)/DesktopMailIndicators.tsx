"use client";

import { useEffect } from "react";
import { useAccounts } from "@/hooks/useAccounts";
import { useInboxUnreadCount } from "@/hooks/useInboxUnreadCount";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";

const MAX_INDICATOR_ACCOUNTS = 50;

export function DesktopMailIndicators() {
  const { data } = useAccounts();
  const accountIds = (data?.emailAccounts ?? [])
    .filter((account) => !account.account.disconnectedAt)
    .map((account) => account.id)
    .sort()
    .slice(0, MAX_INDICATOR_ACCOUNTS);
  const unreadCount = useInboxUnreadCount(accountIds);

  useEffect(() => {
    getInboxZeroDesktopApp()?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  useEffect(() => () => getInboxZeroDesktopApp()?.setUnreadCount?.(0), []);

  return null;
}
