import { env } from "@/env";
import { getUserTier, hasAiAccess, isPremiumRecord } from "@/utils/premium";

/** Set when the "AI assistant is off" banner is dismissed; the server reads it. */
export const NO_AI_BANNER_DISMISSED_COOKIE = "cue-no-ai-banner-dismissed";

export type AiAccess = {
  hasAiAccess: boolean;
  isProPlanWithoutApiKey: boolean;
};

/**
 * Whether the user's plan lets Cue's AI work, worked out the same way on the
 * server and in the browser.
 */
export function getAiAccess({
  premium,
  hasAiApiKey,
}: {
  premium?: Parameters<typeof getUserTier>[0];
  hasAiApiKey?: boolean | null;
}): AiAccess {
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) {
    return { hasAiAccess: true, isProPlanWithoutApiKey: false };
  }
  const tier = getUserTier(premium);
  return {
    hasAiAccess:
      isPremiumRecord(premium) && hasAiAccess(tier || null, hasAiApiKey),
    isProPlanWithoutApiKey:
      (tier === "PRO_MONTHLY" || tier === "PRO_ANNUALLY") && !hasAiApiKey,
  };
}
