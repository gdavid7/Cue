"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { StepConnectCalendar } from "./StepConnectCalendar";
import { StepSendTestBrief } from "./StepSendTestBrief";
import { StepReady } from "./StepReady";
import { prefixPath } from "@/utils/path";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useCalendars } from "@/hooks/useCalendars";
import { OnboardingWrapper } from "@/app/(app)/[emailAccountId]/onboarding-brief/OnboardingWrapper";

const TOTAL_STEPS = 3;

interface MeetingBriefsOnboardingContentProps {
  step: number;
}

export function MeetingBriefsOnboardingContent({
  step,
}: MeetingBriefsOnboardingContentProps) {
  const { emailAccountId } = useAccount();
  const router = useRouter();

  const clampedStep = Math.min(Math.max(step, 1), TOTAL_STEPS);
  const { data: calendarsData } = useCalendars();
  const hasCalendarConnected = Boolean(calendarsData?.connections.length);

  // Calendar access is granted at sign-in, so most people skip straight to
  // the test brief instead of being asked to connect it again.
  useEffect(() => {
    if (clampedStep === 1 && hasCalendarConnected)
      router.replace(prefixPath(emailAccountId, "/onboarding-brief?step=2"));
  }, [clampedStep, hasCalendarConnected, router, emailAccountId]);

  const onNext = useCallback(async () => {
    if (clampedStep < TOTAL_STEPS) {
      const nextStep = clampedStep + 1;
      router.push(
        prefixPath(emailAccountId, `/onboarding-brief?step=${nextStep}`),
      );
    }
  }, [router, emailAccountId, clampedStep]);

  return (
    <OnboardingWrapper>
      {clampedStep === 1 && <StepConnectCalendar onNext={onNext} />}
      {clampedStep === 2 && <StepSendTestBrief onNext={onNext} />}
      {clampedStep === 3 && <StepReady />}
    </OnboardingWrapper>
  );
}
