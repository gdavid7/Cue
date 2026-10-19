"use client";

import { useEffect, useMemo, useRef } from "react";
import { usePathname } from "next/navigation";
import { getAllInboxesAccounts } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { useAccounts } from "@/hooks/useAccounts";
import { useInboxUnreadCount } from "@/hooks/useInboxUnreadCount";
import { useAccount } from "@/providers/EmailAccountProvider";
import { BRAND_NAME } from "@/utils/branding";
import { parseMailPath } from "@/utils/mail-url";
import { keepUnreadTitle } from "@/utils/web-notifications/unread-title";

/** Gmail-style "Inbox (3) – Cue" in the tab, for the inbox the reader is in. */
export function TabUnreadTitle() {
  const pathname = usePathname();
  const { emailAccountId } = useAccount();
  const isAllInboxes = Boolean(parseMailPath(pathname ?? "", "")?.allInboxes);
  const { data } = useAccounts(isAllInboxes);
  const accountIds = useMemo(() => {
    if (isAllInboxes)
      return getAllInboxesAccounts(data?.emailAccounts ?? []).map(
        (account) => account.id,
      );
    return emailAccountId ? [emailAccountId] : [];
  }, [isAllInboxes, data, emailAccountId]);
  const unreadCount = useInboxUnreadCount(accountIds);
  const title = useRef<ReturnType<typeof keepUnreadTitle>>(undefined);

  useEffect(() => {
    title.current = keepUnreadTitle(BRAND_NAME);
    return () => {
      title.current?.dispose();
      title.current = undefined;
    };
  }, []);

  useEffect(() => {
    title.current?.set(unreadCount);
  }, [unreadCount]);

  return null;
}
