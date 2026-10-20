import { useLayoutEffect } from "react";
import { setRumContext } from "@/utils/analytics/rum-actions";
import { startRumAppOpen } from "@/utils/analytics/rum-app-open";

/**
 * Tells the timing events which account and provider they belong to, and
 * starts the clock for the first inbox row. Layout effects, so both happen
 * before the sign-in marker is cleared and the first paint; neither renders.
 */
export function useRumAppOpen({
  emailAccountId,
  provider,
  accountCount,
}: {
  emailAccountId: string;
  provider: string | null | undefined;
  accountCount: number;
}) {
  useLayoutEffect(() => {
    setRumContext({ accountId: emailAccountId, provider, accountCount });
    startRumAppOpen(emailAccountId);
  }, [emailAccountId, provider, accountCount]);
}
