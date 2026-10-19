"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { checkPermissionsAction } from "@/utils/actions/permissions";
import { useAccount } from "@/providers/EmailAccountProvider";
import { getPermissionsConsentPath } from "@/utils/permissions-consent";
import { useOrgAccess } from "@/hooks/useOrgAccess";
import { scheduleAfterPageLoad } from "@/utils/schedule-after-page-load";

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
    // for the page to settle instead of queueing in front of the first load.
    return scheduleAfterPageLoad(
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
      { fallbackDelay: 3000, idleTimeout: 5000 },
    );
  }, [router, emailAccountId, isAccountOwner]);

  return null;
}
