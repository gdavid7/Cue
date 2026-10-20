"use client";

import { useEffect } from "react";
import { useSWRConfig } from "swr";
import { useUser } from "@/hooks/useUser";
import { GET_STARTED_KEY } from "@/hooks/useGetStarted";
import { dismissHintAction } from "@/utils/actions/hints";
import {
  type GetStartedClientStep,
  getGetStartedStepHintId,
  isGetStartedWindowOpen,
} from "@/utils/get-started/checklist";
import {
  noteGetStartedStep,
  subscribeGetStartedSteps,
} from "@/utils/get-started/client-steps";
import { useStableCallback } from "@/app/(app)/[emailAccountId]/mail/use-stable-callback";

const INSTALLED_PHONE_QUERY =
  "(display-mode: standalone) and (pointer: coarse)";

/**
 * Saves the get-started steps only the browser sees (keyboard triage, a
 * search, opening the installed phone app) during a person's first week.
 * Afterwards, or once a step is saved, it sends nothing.
 */
export function GetStartedRecorder() {
  const { data: user, mutate: mutateUser } = useUser();
  const { mutate } = useSWRConfig();
  const active = Boolean(user && isGetStartedWindowOpen(user, new Date()));

  const record = useStableCallback((step: GetStartedClientStep) => {
    const hintId = getGetStartedStepHintId(step);
    if (!user || !active || user.dismissedHints.includes(hintId)) return;
    mutateUser(
      { ...user, dismissedHints: [...user.dismissedHints, hintId] },
      { revalidate: false },
    );
    dismissHintAction({ hintId }).finally(() => {
      mutateUser();
      mutate(GET_STARTED_KEY);
    });
  });

  useEffect(() => {
    if (!active) return;
    const unsubscribe = subscribeGetStartedSteps(record);
    if (window.matchMedia?.(INSTALLED_PHONE_QUERY).matches)
      noteGetStartedStep("phone");
    return unsubscribe;
  }, [active, record]);

  return null;
}
