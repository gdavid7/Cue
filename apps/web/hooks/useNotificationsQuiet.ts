import { useSyncExternalStore } from "react";
import { isNotifyingInThisBrowser } from "@/utils/web-notifications/permission";
import {
  readQuietUntilMs,
  subscribeToPreference,
} from "@/utils/web-notifications/preference";

/** Whether this browser notifies at all, and until when it is paused. */
export function useNotificationsQuiet() {
  const canPause = useSyncExternalStore(
    subscribeToPreference,
    isNotifyingInThisBrowser,
    () => false,
  );
  const quietUntilMs = useSyncExternalStore(
    subscribeToPreference,
    () => readQuietUntilMs(),
    () => null,
  );
  return { canPause, quietUntilMs: canPause ? quietUntilMs : null };
}
