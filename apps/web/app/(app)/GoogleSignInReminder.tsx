"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useLocalStorage } from "usehooks-ts";
import { AppAlertBanner } from "@/app/(app)/AppAlertBanner";
import { Button } from "@/components/ui/button";
import { toastError } from "@/components/Toast";
import { useAccounts } from "@/hooks/useAccounts";
import { useHydrated } from "@/hooks/useHydrated";
import { getAccountLinkingUrl } from "@/utils/account-linking";
import {
  getGoogleSignInWarning,
  localDayKey,
} from "@/utils/google-sign-in-warning";
import { redirectToSafeUrl } from "@/utils/redirect";

const DISMISSED_KEY = "cue-google-sign-in-reminder-dismissed";

/**
 * While the Google app is in Testing, sign-ins end a week after consent. This
 * asks for the sign-in a day or two early, so it doesn't happen mid-day.
 */
export function GoogleSignInReminder() {
  const hydrated = useHydrated();
  const pathname = usePathname();
  const { data } = useAccounts();
  const [dismissed, setDismissed] = useLocalStorage<Record<string, string>>(
    DISMISSED_KEY,
    {},
    { initializeWithValue: false },
  );
  const [isReconnecting, setIsReconnecting] = useState(false);

  if (!hydrated || !data) return null;
  // The consent page is itself the reconnect.
  if (pathname?.endsWith("/permissions/consent")) return null;

  const warning = getGoogleSignInWarning({
    accounts: data.emailAccounts,
    now: new Date(),
    // A hand-edited or old value must not break the page.
    dismissed: dismissed && typeof dismissed === "object" ? dismissed : {},
  });
  if (!warning) return null;

  const reconnect = async () => {
    setIsReconnecting(true);
    try {
      const url = await getAccountLinkingUrl("google", {
        reconnectEmailAccountId: warning.emailAccountId,
      });
      redirectToSafeUrl(url, { allowExternal: true });
    } catch (error) {
      toastError({
        title: "Couldn't start signing in",
        description:
          error instanceof Error
            ? error.message
            : "Check your connection and try again.",
      });
      setIsReconnecting(false);
    }
  };

  return (
    <AppAlertBanner
      tone="notice"
      title={`Google asks you to sign in again by ${warning.when}`}
      description={
        warning.hasMultipleAccounts
          ? `For ${warning.email}. Reconnecting now keeps mail flowing.`
          : "Reconnecting now keeps mail flowing."
      }
      action={
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={reconnect} loading={isReconnecting}>
            Reconnect now
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setDismissed({
                ...(dismissed && typeof dismissed === "object"
                  ? dismissed
                  : {}),
                [warning.emailAccountId]: localDayKey(new Date()),
              })
            }
          >
            Not now
          </Button>
        </div>
      }
    />
  );
}
