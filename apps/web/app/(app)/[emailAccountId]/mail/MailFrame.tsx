"use client";

import { MailProductFrame } from "@inboxzero/mail-ui/MailProductFrame";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useState,
  useSyncExternalStore,
} from "react";
import { MailAccountSwitcher } from "@/app/(app)/[emailAccountId]/mail/MailAccountSwitcher";
import { MailMobileNav } from "@/app/(app)/[emailAccountId]/mail/MailMobileNav";
import { MailShellSidebar } from "@/app/(app)/[emailAccountId]/mail/MailShellSidebar";
import { getMailAccountUrl } from "@/app/(app)/[emailAccountId]/mail/mail-account-url";
import { useMailHref } from "@/hooks/useMailHref";
import { getTodayPath, useAllAccountsScope } from "@/hooks/useTodayHref";
import { useAccount } from "@/providers/EmailAccountProvider";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import { prefixPath } from "@/utils/path";
import { redirectToSafeUrl } from "@/utils/redirect";

/**
 * The mail screen's sidebar and phone tab bar around something other than the
 * mailbox: Today, and the mailbox's own placeholder while it loads.
 */
export function MailFrame({
  activeType,
  children,
}: {
  /** The sidebar row to highlight, as `MailShellSidebar` takes it. */
  activeType: string | null;
  children: ReactNode;
}) {
  const { accountIds, emailAccountId } = useAccount();
  const mailHref = useMailHref();
  const router = useRouter();
  const isDesktopApp = useSyncExternalStore(
    subscribeNever,
    () => Boolean(getInboxZeroDesktopApp()),
    () => false,
  );
  const isToday = activeType === "today";
  const allAccountsScope = useAllAccountsScope();
  // Today across accounts keeps the sidebar and switcher All inboxes shows.
  const isAllAccounts = isToday && allAccountsScope;
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  // Switching accounts keeps you where you are.
  const selectAccount = useCallback(
    (accountId: string) =>
      redirectToSafeUrl(
        isToday
          ? prefixPath(accountId, "/home")
          : getMailAccountUrl(accountIds, accountId, window.location),
      ),
    [accountIds, isToday],
  );
  // On Today, all accounts is Today across them, as one account keeps Today.
  const selectAllAccounts = useCallback(
    () =>
      router.push(
        isToday
          ? getTodayPath(emailAccountId, true)
          : mailHref({ allInboxes: true }),
      ),
    [emailAccountId, isToday, mailHref, router],
  );

  return (
    <MailProductFrame
      accountSwitcher={
        <MailMobileNav
          onOpenMailboxes={() => setIsMobileSidebarOpen(true)}
          accountSwitcher={
            <MailAccountSwitcher
              isDesktopApp={isDesktopApp}
              isAllAccounts={isAllAccounts}
              onSelectAccount={selectAccount}
              onSelectAll={selectAllAccounts}
              variant="bar"
            />
          }
        />
      }
    >
      <MailShellSidebar
        activeType={activeType}
        activeLabelId={null}
        activeFolderId={null}
        isAllAccounts={isAllAccounts}
        isDesktopApp={isDesktopApp}
        onSelectAccount={selectAccount}
        onSelectAllAccounts={selectAllAccounts}
        onMailboxItemDeleted={noMailboxScope}
        mobileOpen={isMobileSidebarOpen}
        onMobileOpenChange={setIsMobileSidebarOpen}
      />
      {children}
    </MailProductFrame>
  );
}

function subscribeNever() {
  return () => {};
}

// Nothing here is scoped to a label or folder, so a deletion leaves no view.
async function noMailboxScope() {}
