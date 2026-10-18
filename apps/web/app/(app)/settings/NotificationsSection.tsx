"use client";

import { useSyncExternalStore } from "react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastError } from "@/components/Toast";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import {
  chooseWebNotificationMode,
  getWebNotificationPermission,
} from "@/utils/web-notifications/permission";
import {
  readEffectiveMode,
  subscribeToPreference,
  type WebNotificationMode,
  WEB_NOTIFICATION_MODES,
} from "@/utils/web-notifications/preference";

const MODE_LABELS: Record<WebNotificationMode, string> = {
  off: "Off",
  important: "Important mail",
  all: "All new mail",
};

/** Browser notifications are per browser, so this lives with the device settings. */
export function NotificationsSection() {
  const permission = useSyncExternalStore(
    subscribeToPreference,
    getWebNotificationPermission,
    () => "unsupported" as const,
  );
  const storedMode = useSyncExternalStore(
    subscribeToPreference,
    readEffectiveMode,
    () => "off" as const,
  );
  // The desktop app shows its own notifications.
  if (permission === "unsupported" || getInboxZeroDesktopApp()) return null;

  const mode = permission === "granted" ? storedMode : "off";

  return (
    <>
      <ItemSeparator />
      <Item size="sm">
        <ItemContent>
          <ItemTitle>Desktop notifications</ItemTitle>
          <ItemDescription>
            {permission === "denied"
              ? "Notifications are blocked. Allow them for this site in your browser settings."
              : "Get a notification for new mail while Cue is open in a browser tab."}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            value={mode}
            disabled={permission === "denied"}
            onValueChange={(value) => {
              const next = WEB_NOTIFICATION_MODES.find(
                (candidate) => candidate === value,
              );
              if (!next) return;
              chooseWebNotificationMode(next)
                .then((result) => {
                  if (next !== "off" && result !== "granted")
                    toastError({
                      description:
                        "Notifications weren't allowed. You can change this in your browser settings.",
                    });
                })
                .catch(() => undefined);
            }}
          >
            <SelectTrigger
              aria-label="Desktop notifications"
              className="h-9 w-40"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEB_NOTIFICATION_MODES.map((option) => (
                <SelectItem key={option} value={option}>
                  {MODE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
    </>
  );
}
