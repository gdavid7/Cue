"use client";

import { useState } from "react";
import { AppAlertBanner } from "@/app/(app)/AppAlertBanner";
import { Button } from "@/components/ui/button";
import { useEmailAccountFull } from "@/hooks/useEmailAccountFull";
import { getProviderRateLimitBannerLabel } from "@/utils/email/rate-limit-mode-error";
import { BRAND_NAME } from "@/utils/branding";

export function ProviderRateLimitBanner() {
  const { data, isLoading, error } = useEmailAccountFull();
  // Keyed by the retry time, so a new limit shows again after a dismiss.
  const [dismissedRetryAt, setDismissedRetryAt] = useState<string | null>(null);

  if (isLoading || error || !data?.providerRateLimit) return null;

  const { provider, retryAt } = data.providerRateLimit;
  if (dismissedRetryAt === retryAt) return null;
  const providerLabel = getProviderRateLimitBannerLabel(provider);

  return (
    <AppAlertBanner
      title={`${providerLabel} is limiting this account for now`}
      description={
        <p>
          {BRAND_NAME} pauses its actions and picks up again automatically
          around <strong>{formatRetryAt(retryAt)}</strong>. Other apps on this
          mailbox count toward the same {providerLabel} limit.
        </p>
      }
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDismissedRetryAt(retryAt)}
        >
          Dismiss
        </Button>
      }
    />
  );
}

function formatRetryAt(retryAt: string) {
  const date = new Date(retryAt);
  if (Number.isNaN(date.getTime())) return retryAt;
  const isToday = date.toDateString() === new Date().toDateString();
  return isToday
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      });
}
