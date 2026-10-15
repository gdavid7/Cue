"use client";

import { env } from "@/env";
import { useUser } from "@/hooks/useUser";
import {
  getUserTier,
  hasUnsubscribeAccess,
  isPremiumRecord,
} from "@/utils/premium";
import { getAiAccess } from "@/utils/premium/ai-access";

export function usePremium() {
  const swrResponse = useUser();
  const { data } = swrResponse;

  const premium = data?.premium;
  const hasAiApiKey = data?.hasAiApiKey;
  const canManageBilling = data?.canManageBilling ?? false;

  const unsubscribeCreditsRemaining = data?.unsubscribeCreditsRemaining;

  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) {
    return {
      ...swrResponse,
      premium,
      canManageBilling,
      isPremium: true,
      hasUnsubscribeAccess: true,
      unsubscribeCreditsRemaining,
      hasAiAccess: true,
      isProPlanWithoutApiKey: false,
      tier: "PROFESSIONAL_ANNUALLY" as const,
    };
  }

  const isUserPremium = isPremiumRecord(premium);
  const tier = getUserTier(premium);
  const aiAccess = getAiAccess({ premium, hasAiApiKey });

  return {
    ...swrResponse,
    premium,
    canManageBilling,
    isPremium: isUserPremium,
    hasUnsubscribeAccess:
      isUserPremium ||
      hasUnsubscribeAccess(tier || null, unsubscribeCreditsRemaining),
    unsubscribeCreditsRemaining,
    hasAiAccess: aiAccess.hasAiAccess,
    isProPlanWithoutApiKey: aiAccess.isProPlanWithoutApiKey,
    tier,
  };
}
