"use client";

import { useCallback } from "react";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckIcon, Plus } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useAccounts } from "@/hooks/useAccounts";
import { useAccount } from "@/providers/EmailAccountProvider";
import { rememberLastEmailAccount } from "@/utils/last-email-account";
import { ProfileImage } from "@/components/ProfileImage";
import { getAccountSwitchUrl } from "@/utils/account-switch-url";
import { getMailAccountUrl } from "@/app/(app)/[emailAccountId]/mail/mail-account-url";
import { isMailPath } from "@/utils/mail-url";
import { redirectToSafeUrl } from "@/utils/redirect";

/**
 * The account list inside the account menu: switch to another account (on the
 * same page) or add one. Shown above the menu's settings and sign-out rows so
 * the sidebar has a single identity block.
 */
export function AccountSwitcherMenuItems({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const { data: accountsData } = useAccounts();
  const { emailAccountId: activeEmailAccountId, accountIds } = useAccount();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useParams<{ emailAccountId?: string }>();

  const getHref = useCallback(
    (emailAccountId: string) => {
      if (!activeEmailAccountId || isMailPath(pathname))
        return getMailAccountUrl(accountIds, emailAccountId, {
          pathname,
          search: searchParams.toString(),
        });

      return getAccountSwitchUrl({
        pathname,
        currentAccountId: params.emailAccountId,
        targetAccountId: emailAccountId,
        tab: searchParams.get("tab"),
      });
    },
    [
      pathname,
      activeEmailAccountId,
      accountIds,
      params.emailAccountId,
      searchParams,
    ],
  );

  const handleSelect = useCallback(
    async (emailAccountId: string) => {
      try {
        await rememberLastEmailAccount(emailAccountId);
      } catch {
        // Ignore cookie update failures and continue navigation.
      }

      // A hard reload refreshes every account-scoped cache, which resetting
      // the SWR cache alone didn't do reliably.
      redirectToSafeUrl(getHref(emailAccountId));
    },
    [getHref],
  );

  const emailAccounts = accountsData?.emailAccounts ?? [];

  return (
    <>
      {emailAccounts.length > 1 ? (
        <>
          <DropdownMenuLabel className="text-muted-foreground text-xs">
            Switch account
          </DropdownMenuLabel>
          {emailAccounts.map((emailAccount) => {
            const isActive = emailAccount.id === activeEmailAccountId;
            return (
              <DropdownMenuItem
                key={emailAccount.id}
                className="gap-2 p-2"
                onSelect={() => {
                  if (isActive) return;
                  onNavigate?.();
                  handleSelect(emailAccount.id);
                }}
              >
                <ProfileImage
                  image={emailAccount.image}
                  label={emailAccount.name || emailAccount.email}
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">
                    {emailAccount.name || emailAccount.email}
                  </span>
                  {emailAccount.name && (
                    <span className="truncate text-muted-foreground text-xs">
                      {emailAccount.email}
                    </span>
                  )}
                </div>
                {isActive ? (
                  <CheckIcon aria-label="Current account" className="size-4" />
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </>
      ) : null}
      <DropdownMenuItem asChild className="gap-2 p-2">
        <Link href="/accounts" onClick={onNavigate}>
          <div className="flex size-6 items-center justify-center rounded-md border bg-background">
            <Plus className="size-4" />
          </div>
          <div className="font-medium text-muted-foreground">
            Add or manage accounts
          </div>
        </Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}
