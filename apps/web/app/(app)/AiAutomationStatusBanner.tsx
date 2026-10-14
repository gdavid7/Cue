"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SparklesIcon, XIcon } from "lucide-react";
import { useLocalStorage } from "usehooks-ts";
import { AppAlertBanner } from "@/app/(app)/AppAlertBanner";
import { EndTrialButton } from "@/components/EndTrialButton";
import { Button } from "@/components/ui/button";
import { useAiAutomationStatus } from "@/hooks/useAiAutomationStatus";
import { usePremium } from "@/hooks/usePremium";

export function AiAutomationStatusBanner() {
  const { data: status } = useAiAutomationStatus();

  if (status?.status === "trial_ai_limit_reached") {
    return (
      <AppAlertBanner
        title="Action Required"
        description={status.message}
        action={<EndTrialButton variant="red" size="sm" />}
      />
    );
  }

  return <NoAiAccessBanner />;
}

/**
 * Without AI access Cue sorts nothing and drafts nothing, and an empty Needs
 * reply tab would look like a verdict. Say so where people read mail, calmly,
 * since it's a plan choice rather than a fault.
 */
function NoAiAccessBanner() {
  const { hasAiAccess, isLoading, isProPlanWithoutApiKey } = usePremium();
  const pathname = usePathname();
  const [dismissed, setDismissed] = useLocalStorage(
    "cue-no-ai-access-banner-dismissed",
    false,
  );

  // Today and the plans page already explain this in place.
  const explainedInPage =
    pathname?.endsWith("/home") || pathname?.startsWith("/premium");
  if (isLoading || hasAiAccess || dismissed || explainedInPage) return null;

  return (
    <div
      className="relative z-10 flex w-full items-center gap-3 border-border border-b bg-muted/60 px-4 py-2 text-foreground text-sm sm:px-6 lg:pl-[calc(var(--mail-rail-width,0px)+1.5rem)]"
      role="status"
    >
      <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1">
        {isProPlanWithoutApiKey
          ? "Add an AI API key so Cue can sort your mail and draft replies."
          : "The AI assistant is off, so Cue isn't sorting mail or checking what needs a reply."}{" "}
        <Link
          className="font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
          href={isProPlanWithoutApiKey ? "/settings" : "/premium"}
        >
          {isProPlanWithoutApiKey ? "Add API key" : "See plans"}
        </Link>
      </p>
      <Button
        aria-label="Dismiss"
        className="size-8 shrink-0"
        onClick={() => setDismissed(true)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <XIcon className="size-4" />
      </Button>
    </div>
  );
}
