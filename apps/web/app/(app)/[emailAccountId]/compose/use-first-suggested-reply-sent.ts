"use client";

import { useCallback } from "react";
import { posthog } from "@/utils/analytics/posthog-client";
import { toastSuccess } from "@/components/Toast";
import { useUser } from "@/hooks/useUser";
import { dismissHintAction } from "@/utils/actions/hints";
import { ONBOARDING_ANALYTICS_EVENTS } from "@/utils/analytics/product";
import { getFirstReplySentHintId } from "@/utils/get-started/checklist";

/**
 * Records each reply sent from Cue's suggestion. The first one is the moment
 * Cue proves itself, so it gets its own one-time confirmation. Returns whether
 * that was shown, so the caller can skip its usual "Reply sent".
 */
export function useFirstSuggestedReplySent(emailAccountId: string) {
  const { data: user, mutate } = useUser();

  return useCallback(
    ({ edited }: { edited: boolean }) => {
      const hintId = getFirstReplySentHintId(emailAccountId);
      const isFirst = Boolean(user && !user.dismissedHints.includes(hintId));
      posthog?.capture(ONBOARDING_ANALYTICS_EVENTS.suggestedReplySent, {
        edited,
        is_first: isFirst,
      });
      if (!isFirst) return false;
      toastSuccess({ description: "Sent. Cue will learn from your edits." });
      dismissHintAction({ hintId }).then(() => mutate());
      return true;
    },
    [emailAccountId, mutate, user],
  );
}
