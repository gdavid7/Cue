"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { BellOffIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUser } from "@/hooks/useUser";
import { dismissHintAction } from "@/utils/actions/hints";
import { getTodayIntroHintId } from "@/app/(app)/[emailAccountId]/mail/TodayIntroLine";
import { useAccount } from "@/providers/EmailAccountProvider";
import {
  chooseWebNotificationMode,
  getWebNotificationPermission,
  isDesktopShell,
} from "@/utils/web-notifications/permission";
import {
  hasBeenAskedToEnable,
  readEffectiveMode,
  readOffHintShownAtMs,
  readStoredMode,
  subscribeToPreference,
  writeOffHintShownAtMs,
} from "@/utils/web-notifications/preference";

export const NOTIFICATIONS_OFF_HINT_ID = "web-notifications-off";
const HINT_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A calm reminder, for people who passed on the notifications offer or whose
 * browser blocks them, that new mail won't alert them. It waits behind the
 * one-time Today pointer, shows at most once per interval, and the close
 * button silences it for good.
 */
export function NotificationsOffHint({ ready }: { ready: boolean }) {
  const { emailAccountId } = useAccount();
  const { data: user, mutate } = useUser();
  const permission = useSyncExternalStore(
    subscribeToPreference,
    getWebNotificationPermission,
    () => "unsupported" as const,
  );
  const mode = useSyncExternalStore(
    subscribeToPreference,
    readEffectiveMode,
    () => "important" as const,
  );
  const declinedOffer = useSyncExternalStore(
    subscribeToPreference,
    () => readStoredMode() === "off" || hasBeenAskedToEnable(),
    () => false,
  );
  const isDesktopApp = useSyncExternalStore(
    subscribeToPreference,
    isDesktopShell,
    () => true,
  );
  // Read once so the hint stays up for the visit that first showed it.
  const [lastShownAtMs] = useState(readOffHintShownAtMs);
  const [now] = useState(Date.now);

  const notifying = permission === "granted" && mode !== "off";
  const eligible =
    ready &&
    Boolean(user) &&
    !isDesktopApp &&
    permission !== "unsupported" &&
    !notifying &&
    (permission === "denied" || declinedOffer) &&
    Boolean(
      user?.dismissedHints.includes(getTodayIntroHintId(emailAccountId)),
    ) &&
    !user?.dismissedHints.includes(NOTIFICATIONS_OFF_HINT_ID) &&
    (lastShownAtMs === null || now - lastShownAtMs >= HINT_INTERVAL_MS);

  useEffect(() => {
    if (eligible) writeOffHintShownAtMs(Date.now());
  }, [eligible]);

  if (!eligible || !user) return null;

  const dismiss = () => {
    mutate(
      {
        ...user,
        dismissedHints: [...user.dismissedHints, NOTIFICATIONS_OFF_HINT_ID],
      },
      { revalidate: false },
    );
    dismissHintAction({ hintId: NOTIFICATIONS_OFF_HINT_ID }).then(() =>
      mutate(),
    );
  };

  return (
    <div
      role="status"
      className="mx-3 my-2 flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
    >
      <BellOffIcon
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <p className="min-w-0 flex-1">
        {permission === "denied"
          ? "Notifications are off. To get alerts, allow them for this site in your browser settings."
          : "Notifications are off, so new mail won't alert you."}
      </p>
      {permission !== "denied" && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            chooseWebNotificationMode("important").catch(() => undefined);
          }}
        >
          Turn on
        </Button>
      )}
      <Button
        size="iconXs"
        variant="ghost"
        aria-label="Dismiss"
        onClick={dismiss}
      >
        <XIcon className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
