"use client";

import { useId } from "react";
import { useRouter } from "next/navigation";
import { getDeepCleanAccounts } from "@/app/(app)/[emailAccountId]/clean/deep-clean-accounts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAccounts } from "@/hooks/useAccounts";
import { useAllAccountsScope } from "@/hooks/useTodayHref";
import { useAccount } from "@/providers/EmailAccountProvider";
import { prefixPath } from "@/utils/path";

/**
 * Deep Clean archives in bulk, so it runs in one account at a time and says
 * which. From All inboxes it offers the other Gmail accounts included there,
 * and never one left out.
 */
export function CleanAccountPicker() {
  const id = useId();
  const router = useRouter();
  const { emailAccountId, emailAccount } = useAccount();
  const allAccounts = useAllAccountsScope();
  const { data } = useAccounts();
  const emailAccounts = data?.emailAccounts ?? [];
  if (!emailAccount || emailAccounts.length < 2) return null;

  const choices = allAccounts ? getDeepCleanAccounts(emailAccounts) : [];
  if (
    choices.length < 2 ||
    !choices.some((choice) => choice.id === emailAccountId)
  )
    return (
      <p className="mb-4 text-center text-muted-foreground text-sm">
        Account:{" "}
        <span className="font-medium text-foreground">
          {emailAccount.email}
        </span>
      </p>
    );

  return (
    <div className="mb-4 flex items-center justify-center gap-2 text-sm">
      <label className="text-muted-foreground" htmlFor={id}>
        Account
      </label>
      <Select
        value={emailAccountId}
        onValueChange={(accountId) =>
          router.push(prefixPath(accountId, "/clean"))
        }
      >
        <SelectTrigger className="w-auto min-w-0 max-w-full" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.id} value={choice.id}>
              {choice.email}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
