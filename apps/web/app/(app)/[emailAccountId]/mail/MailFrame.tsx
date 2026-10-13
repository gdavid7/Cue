"use client";

import { MailProductFrame } from "@inboxzero/mail-ui/MailProductFrame";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import { MailAccountSwitcher } from "@/app/(app)/[emailAccountId]/mail/MailAccountSwitcher";
import { MailMobileNav } from "@/app/(app)/[emailAccountId]/mail/MailMobileNav";
import { MailShellSidebar } from "@/app/(app)/[emailAccountId]/mail/MailShellSidebar";
import { getMailAccountUrl } from "@/app/(app)/[emailAccountId]/mail/mail-account-url";
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
  const { emailAccountId } = useAccount();
  const router = useRouter();
  const isDesktopApp = useSyncExternalStore(
    subscribeNever,
    () => Boolean(getInboxZeroDesktopApp()),
    () => false,
  );
  const isToday = activeType === "today";
  // Switching accounts keeps you where you are.
  const selectAccount = useCallback(
    (accountId: string) =>
      redirectToSafeUrl(
        isToday
          ? prefixPath(accountId, "/home")
          : getMailAccountUrl(accountId, window.location.search),
      ),
    [isToday],
  );
  const selectAllAccounts = useCallback(
    () => router.push(prefixPath(emailAccountId, "/mail?accountScope=all")),
    [emailAccountId, router],
  );

  return (
    <MailProductFrame
      accountSwitcher={
        <MailMobileNav
          accountSwitcher={
            <MailAccountSwitcher
              isDesktopApp={isDesktopApp}
              isAllAccounts={false}
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
        isAllAccounts={false}
        isDesktopApp={isDesktopApp}
        onSelectAccount={selectAccount}
        onSelectAllAccounts={selectAllAccounts}
        onMailboxItemDeleted={noMailboxScope}
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
