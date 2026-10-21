"use client";

import {
  clearRumAccountSwitch,
  markRumAccountSwitch,
} from "@/utils/analytics/rum-app-open";
import { MailProductFrame } from "@inboxzero/mail-ui/MailProductFrame";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { MailAccountSwitcher } from "@/app/(app)/[emailAccountId]/mail/MailAccountSwitcher";
import type { MailboxItem } from "@/app/(app)/[emailAccountId]/mail/MailboxItemContextMenu";
import { MailMobileNav } from "@/app/(app)/[emailAccountId]/mail/MailMobileNav";
import { MailShellSidebar } from "@/app/(app)/[emailAccountId]/mail/MailShellSidebar";
import { getMailAccountUrl } from "@/app/(app)/[emailAccountId]/mail/mail-account-url";
import { useIsLargeScreen } from "@/hooks/use-mobile";
import { useMailHref } from "@/hooks/useMailHref";
import { getTodayPath, useAllAccountsScope } from "@/hooks/useTodayHref";
import { useAccount } from "@/providers/EmailAccountProvider";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import { parseMailPath } from "@/utils/mail-url";
import { prefixPath } from "@/utils/path";
import { redirectToSafeUrl } from "@/utils/redirect";

type MailScreenFrame = {
  /** The sidebar row to highlight, as `MailShellSidebar` takes it. */
  activeType: string | null;
  activeLabelId: string | null;
  activeFolderId: string | null;
  /** The mail screen shows its own phone bar: the open conversation's actions. */
  ownsPhoneBar: boolean;
  onSelectAllAccounts: () => void;
  onMailboxItemDeleted: (item: MailboxItem) => Promise<unknown>;
};

type MailFrameState = Pick<
  MailScreenFrame,
  "activeType" | "activeLabelId" | "activeFolderId" | "ownsPhoneBar"
>;
type MailFrameHandlers = Pick<
  MailScreenFrame,
  "onSelectAllAccounts" | "onMailboxItemDeleted"
>;

const MailFrameContext = createContext<{
  setState: (state: MailFrameState | null) => void;
  handlers: { current: MailFrameHandlers | null };
} | null>(null);

/**
 * The mail screen's sidebar and phone tab bar. Mail and Today share one route
 * layout that renders this, so moving between them keeps the sidebar, its
 * counts and the shortcuts mounted and only the content beside it changes.
 * The mail screen fills in what only it knows, through `useMailScreenFrame`.
 */
export function MailFrame({ children }: { children: ReactNode }) {
  const { accountIds, emailAccountId } = useAccount();
  const mailHref = useMailHref();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const isDesktopApp = useSyncExternalStore(
    subscribeNever,
    () => Boolean(getInboxZeroDesktopApp()),
    () => false,
  );
  const isLargeScreen = useIsLargeScreen();
  const mailLocation = parseMailPath(pathname, searchParams);
  const isToday = !mailLocation;
  // A switch that landed on Today has no first mail row to time.
  useEffect(() => {
    if (isToday) clearRumAccountSwitch();
  }, [isToday]);
  const allAccountsScope = useAllAccountsScope();
  // Today across accounts keeps the sidebar and switcher All inboxes shows.
  const isAllAccounts = isToday
    ? allAccountsScope
    : Boolean(mailLocation.allInboxes);
  const [screen, setScreen] = useState<MailFrameState | null>(null);
  const handlers = useRef<MailFrameHandlers | null>(null);
  const context = useMemo(() => ({ setState: setScreen, handlers }), []);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  // Switching accounts keeps you where you are.
  const selectAccount = useCallback(
    (accountId: string) => {
      if (!isToday) markRumAccountSwitch();
      redirectToSafeUrl(
        isToday
          ? prefixPath(accountId, "/home")
          : getMailAccountUrl(accountIds, accountId, window.location),
      );
    },
    [accountIds, isToday],
  );
  // On Today, all accounts is Today across them, as one account keeps Today.
  const selectAllAccounts = useCallback(() => {
    if (isToday) {
      router.push(getTodayPath(emailAccountId, true));
      return;
    }
    if (handlers.current) handlers.current.onSelectAllAccounts();
    else router.push(mailHref({ allInboxes: true }));
  }, [emailAccountId, isToday, mailHref, router]);
  const deleteMailboxItem = useCallback(
    async (item: MailboxItem) => handlers.current?.onMailboxItemDeleted(item),
    [],
  );
  const mailScreen = isToday ? null : screen;
  const mailView = mailLocation?.view;

  return (
    <MailFrameContext.Provider value={context}>
      <MailProductFrame
        accountSwitcher={
          mailScreen?.ownsPhoneBar ? null : (
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
          )
        }
      >
        <MailShellSidebar
          activeType={
            isToday
              ? "today"
              : mailScreen
                ? mailScreen.activeType
                : // Until the mail screen resolves its view's labels.
                  mailView?.kind === "type"
                  ? mailView.type
                  : mailView?.kind === "label" || mailView?.kind === "folder"
                    ? null
                    : "inbox"
          }
          activeLabelId={mailScreen?.activeLabelId ?? null}
          activeFolderId={mailScreen?.activeFolderId ?? null}
          isAllAccounts={isAllAccounts}
          isDesktopApp={isDesktopApp}
          onSelectAccount={selectAccount}
          onSelectAllAccounts={selectAllAccounts}
          onMailboxItemDeleted={deleteMailboxItem}
          mobileOpen={isMobileSidebarOpen && !isLargeScreen}
          onMobileOpenChange={setIsMobileSidebarOpen}
        />
        {children}
      </MailProductFrame>
    </MailFrameContext.Provider>
  );
}

/**
 * Hands the frame the mail screen's highlighted mailbox and its handlers, for
 * as long as the mail screen is mounted.
 */
export function useMailScreenFrame({
  activeType,
  activeLabelId,
  activeFolderId,
  ownsPhoneBar,
  onSelectAllAccounts,
  onMailboxItemDeleted,
}: MailScreenFrame) {
  const frame = useContext(MailFrameContext);
  useLayoutEffect(() => {
    if (!frame) return;
    frame.handlers.current = { onSelectAllAccounts, onMailboxItemDeleted };
  }, [frame, onSelectAllAccounts, onMailboxItemDeleted]);
  useLayoutEffect(() => {
    frame?.setState({
      activeType,
      activeLabelId,
      activeFolderId,
      ownsPhoneBar,
    });
  }, [frame, activeType, activeLabelId, activeFolderId, ownsPhoneBar]);
  useLayoutEffect(() => {
    if (!frame) return;
    return () => {
      frame.setState(null);
      frame.handlers.current = null;
    };
  }, [frame]);
}

function subscribeNever() {
  return () => {};
}
