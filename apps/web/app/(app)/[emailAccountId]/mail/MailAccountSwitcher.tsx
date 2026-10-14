"use client";

import { MailAccountSwitcherTrigger } from "@inboxzero/mail-ui/MailAccountSwitcherTrigger";
import { memo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  EllipsisVerticalIcon,
  KeyboardIcon,
  LogOutIcon,
  PlusIcon,
  Settings2Icon,
  SettingsIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { AddAccount } from "@/components/AddAccount";
import { AllAccountsSelectionDialog } from "@/app/(app)/[emailAccountId]/mail/AllAccountsSelectionDialog";
import {
  getAccountColorClassName,
  getAllInboxesAccounts,
} from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { ProfileImage } from "@/components/ProfileImage";
import { Kbd } from "@/components/Kbd";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RailTooltip } from "@/app/(app)/[emailAccountId]/mail/MailSidebar";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useAccounts } from "@/hooks/useAccounts";
import {
  formatShortcutKeys,
  getShortcut,
  getShortcutHint,
} from "@/lib/shortcuts/registry";
import { getMailAccountUrl } from "@/app/(app)/[emailAccountId]/mail/mail-account-url";
import { useMailAppLinks } from "@/app/(app)/[emailAccountId]/mail/use-mail-app-links";

import { shortcutsDialogOpenAtom } from "@/store/command-palette";
import { useSetAtom } from "jotai";
import { useSettingsDialog } from "@/hooks/useSettingsDialog";
import { logOut } from "@/utils/user";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import { cn } from "@/utils";

/** One tab of the phone's bottom bar; `MailMobileNav` draws the others. */
export const barItemClassName =
  "flex min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-1 text-xs active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const SWITCHER_WRAPPER: Record<"compact" | "sidebar" | "bar", string> = {
  compact:
    "shrink-0 border-border border-t bg-background px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:hidden",
  sidebar: "mt-2 hidden shrink-0 border-border border-t pt-2 lg:block",
  bar: "shrink-0",
};

export const MailAccountSwitcher = memo(function MailAccountSwitcher({
  isAllAccounts,
  isDesktopApp,
  onSelectAccount,
  onSelectAll,
  variant,
  collapsed = false,
}: {
  isAllAccounts: boolean;
  isDesktopApp: boolean;
  onSelectAccount: (accountId: string) => void;
  onSelectAll: () => void;
  /** "bar": an avatar in the phone's bottom bar. */
  variant: "compact" | "sidebar" | "bar";
  /** Icon-only rail: the trigger shrinks to the account avatar. */
  collapsed?: boolean;
}) {
  const { data, mutate } = useAccounts();
  const { emailAccount } = useAccount();
  const [isSelectionOpen, setIsSelectionOpen] = useState(false);
  const [isAddAccountOpen, setIsAddAccountOpen] = useState(false);
  const { appLinks } = useMailAppLinks();
  const { openSettings } = useSettingsDialog();
  const setShortcutsOpen = useSetAtom(shortcutsDialogOpenAtom);
  // A dialog opened from a menu row must keep focus: the menu handing it back
  // to its trigger as it closes would dismiss the dialog straight away.
  const isOpeningDialog = useRef(false);
  const openFromMenu = (open: () => void) => {
    isOpeningDialog.current = true;
    open();
  };

  if (!data) return null;

  const allInboxesAccounts = getAllInboxesAccounts(data.emailAccounts);
  const getAccountColor = (accountId: string) => {
    const index = allInboxesAccounts.findIndex(
      (account) => account.id === accountId,
    );
    return allInboxesAccounts.length > 1 && index >= 0
      ? getAccountColorClassName(index)
      : undefined;
  };

  const activeLabel = isAllAccounts
    ? "All accounts"
    : emailAccount?.name || emailAccount?.email || "Choose account";
  const activeEmail =
    !isAllAccounts && emailAccount?.name ? emailAccount.email : null;
  let activeIcon: ReactNode = null;
  if (isAllAccounts) {
    activeIcon = <AllAccountsIcon />;
  } else if (emailAccount) {
    activeIcon = (
      <ProfileImage
        className="size-8"
        image={emailAccount.image}
        label={emailAccount.name || emailAccount.email}
      />
    );
  }

  // The menu holds Settings and Sign out as well as accounts, so its name says so.
  const triggerLabel = ["Account and settings", activeLabel, activeEmail]
    .filter(Boolean)
    .join(", ");
  const rowClassName = cn(
    "gap-3 rounded-xl px-3",
    variant === "sidebar" ? "py-2" : "py-3",
  );

  return (
    <div className={SWITCHER_WRAPPER[variant]}>
      <DropdownMenu>
        <RailTooltip label={collapsed ? activeLabel : null}>
          <DropdownMenuTrigger asChild>
            {variant === "bar" ? (
              <button
                type="button"
                aria-label={triggerLabel}
                className={cn(barItemClassName, "text-muted-foreground")}
              >
                {emailAccount && !isAllAccounts ? (
                  <ProfileImage
                    className="size-5"
                    image={emailAccount.image}
                    label={emailAccount.name || emailAccount.email}
                  />
                ) : (
                  <span className="flex size-5 items-center justify-center [&>span]:size-5">
                    {activeIcon}
                  </span>
                )}
                Account
              </button>
            ) : (
              <MailAccountSwitcherTrigger
                aria-label={triggerLabel}
                icon={activeIcon}
                indicator={
                  <EllipsisVerticalIcon className="size-4 text-muted-foreground" />
                }
                label={activeLabel}
                email={activeEmail}
                collapsed={collapsed}
                compact={variant !== "sidebar"}
              />
            )}
          </DropdownMenuTrigger>
        </RailTooltip>
        <DropdownMenuContent
          onCloseAutoFocus={(event) => {
            if (!isOpeningDialog.current) return;
            isOpeningDialog.current = false;
            event.preventDefault();
          }}
          align="start"
          className={cn(
            "rounded-2xl p-2 shadow-xl",
            variant !== "sidebar"
              ? "w-[calc(100vw-1.5rem)]"
              : "w-[--radix-dropdown-menu-trigger-width] min-w-72",
          )}
          side="top"
          sideOffset={8}
        >
          {emailAccount ? (
            <DropdownMenuLabel className="px-3 font-normal text-muted-foreground text-xs">
              Signed in as{" "}
              <span className="font-medium text-foreground">
                {emailAccount.email}
              </span>
            </DropdownMenuLabel>
          ) : null}
          {data.emailAccounts.length > 1 ? (
            <>
              <div className="flex items-stretch gap-1">
                <DropdownMenuItem
                  className="min-w-0 flex-1 gap-3 rounded-xl p-3"
                  onSelect={onSelectAll}
                >
                  <AllAccountsIcon />
                  <span className="font-medium">All accounts</span>
                  {isDesktopApp && (
                    <Kbd className="ml-auto shrink-0">
                      {getShortcutHint("switchAllAccounts")}
                    </Kbd>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  aria-label="Choose accounts"
                  title="Choose accounts"
                  className="w-10 justify-center rounded-xl p-0 text-muted-foreground"
                  onSelect={() => openFromMenu(() => setIsSelectionOpen(true))}
                >
                  <SlidersHorizontalIcon />
                </DropdownMenuItem>
              </div>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {data.emailAccounts.map((account, index) => (
            <AccountItem
              account={account}
              colorClassName={getAccountColor(account.id)}
              isDesktopApp={isDesktopApp}
              key={account.id}
              onSelect={onSelectAccount}
              shortcutKey={
                isDesktopApp
                  ? getShortcut("switchAccount").keys[index]
                  : undefined
              }
            />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-3 rounded-xl p-3"
            onSelect={() => openFromMenu(() => setIsAddAccountOpen(true))}
          >
            <span className="flex size-8 items-center justify-center rounded-full bg-muted">
              <PlusIcon className="size-4" />
            </span>
            <span className="font-medium">Add another account</span>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className={rowClassName}>
            <Link href="/accounts">
              <Settings2Icon className="size-4 text-muted-foreground" />
              Manage accounts
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* The sidebar lists these itself; the phone has only this menu. */}
          {variant !== "sidebar" &&
            appLinks.map((link) => (
              <DropdownMenuItem
                asChild
                className={cn(rowClassName, "[&_svg]:text-muted-foreground")}
                key={link.href}
              >
                <Link href={link.href}>
                  {link.icon}
                  {link.name}
                </Link>
              </DropdownMenuItem>
            ))}
          <DropdownMenuItem
            className={rowClassName}
            onSelect={() => openFromMenu(openSettings)}
          >
            <SettingsIcon className="size-4 text-muted-foreground" />
            Settings
          </DropdownMenuItem>
          {/* Phones have no keyboard to need the list. */}
          {variant === "sidebar" ? (
            <DropdownMenuItem
              className={rowClassName}
              onSelect={() => openFromMenu(() => setShortcutsOpen(true))}
            >
              <KeyboardIcon className="size-4 text-muted-foreground" />
              Keyboard shortcuts
              <Kbd className="ml-auto">{getShortcutHint("help")}</Kbd>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className={rowClassName}
            onSelect={() => logOut(window.location.origin)}
          >
            <LogOutIcon className="size-4 text-muted-foreground" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isSelectionOpen ? (
        <AllAccountsSelectionDialog
          emailAccounts={data.emailAccounts}
          onClose={() => setIsSelectionOpen(false)}
          onSaved={mutate}
        />
      ) : null}
      <Dialog open={isAddAccountOpen} onOpenChange={setIsAddAccountOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add another account</DialogTitle>
            <DialogDescription>
              Its mail joins All inboxes alongside your other accounts.
            </DialogDescription>
          </DialogHeader>
          <AddAccount />
        </DialogContent>
      </Dialog>
    </div>
  );
});

function AccountItem({
  account,
  colorClassName,
  isDesktopApp,
  onSelect,
  shortcutKey,
}: {
  account: GetEmailAccountsResponse["emailAccounts"][number];
  /** Matches the marker on this account's rows in All inboxes. */
  colorClassName: string | undefined;
  isDesktopApp: boolean;
  onSelect: (accountId: string) => void;
  shortcutKey: string | undefined;
}) {
  // Radix onSelect receives a CustomEvent without metaKey/ctrlKey.
  const openInNewWindow = useRef(false);

  return (
    <DropdownMenuItem
      className="gap-3 rounded-xl p-3"
      onPointerDown={(event) => {
        openInNewWindow.current =
          isDesktopApp && isDesktopNewWindowClick(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          openInNewWindow.current =
            isDesktopApp && isDesktopNewWindowClick(event);
        }
      }}
      onSelect={() => {
        const shouldOpenWindow = openInNewWindow.current;
        openInNewWindow.current = false;
        if (shouldOpenWindow) {
          const openWindow = getInboxZeroDesktopApp()?.openWindow;
          if (openWindow) {
            openWindow(getMailAccountUrl(account.id, "")).catch(() => {});
            return;
          }
        }
        onSelect(account.id);
      }}
    >
      <ProfileImage
        className="size-10"
        image={account.image}
        label={account.name || account.email}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">
          {account.name || account.email}
        </span>
        {account.name ? (
          <span className="block truncate text-muted-foreground text-xs">
            {account.email}
          </span>
        ) : null}
      </span>
      {colorClassName ? (
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", colorClassName)}
        />
      ) : null}
      {shortcutKey && (
        <Kbd className="shrink-0">
          {formatShortcutKeys({
            ...getShortcut("switchAccount"),
            display: [shortcutKey.replace("mod+", "modorctrl+")],
          })}
        </Kbd>
      )}
    </DropdownMenuItem>
  );
}

function AllAccountsIcon() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center gap-0.5 rounded-full bg-muted">
      <span className="size-2 rounded-full bg-blue-600" />
      <span className="size-2 rounded-full bg-violet-500" />
      <span className="size-2 rounded-full bg-emerald-500" />
    </span>
  );
}

function isDesktopNewWindowClick(event: {
  metaKey: boolean;
  ctrlKey: boolean;
}) {
  return event.metaKey || event.ctrlKey;
}
