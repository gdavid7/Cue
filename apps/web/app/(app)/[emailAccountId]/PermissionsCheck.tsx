"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { checkPermissionsAction } from "@/utils/actions/permissions";
import { useAccount } from "@/providers/EmailAccountProvider";
import { getPermissionsConsentPath } from "@/utils/permissions-consent";
import { useOrgAccess } from "@/hooks/useOrgAccess";
import { afterFirstMailList } from "@/utils/mail-engine/first-mail-list";

const permissionsChecked: Record<string, boolean> = {};

export function PermissionsCheck() {
  const router = useRouter();
  const { emailAccountId } = useAccount();
  const { isAccountOwner } = useOrgAccess();

  useEffect(() => {
    // Skip permissions check when viewing another user's account (non-owner)
    if (!isAccountOwner) return;

    if (permissionsChecked[emailAccountId]) return;

    // Server actions run one at a time, ahead of navigations, so this waits
    // for the mail list instead of queueing in front of the first load. An
    // expired grant hides every mail, so it waits for nothing else, and never
    // more than a few seconds.
    return afterFirstMailList(
      () => {
        if (permissionsChecked[emailAccountId]) return;
        permissionsChecked[emailAccountId] = true;
        checkPermissionsAction(emailAccountId).then((result) => {
          const expired = result?.data?.hasRefreshToken === false;
          if (expired || result?.data?.hasAllPermissions === false) {
            router.replace(
              getPermissionsConsentPath(emailAccountId, { expired }),
            );
          }
        });
      },
      { fallbackMs: 2000, settleMs: 0, capMs: 3000 },
    );
  }, [router, emailAccountId, isAccountOwner]);

  return null;
}
