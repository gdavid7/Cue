"use client";

import Link from "next/link";
import { SunIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUser } from "@/hooks/useUser";
import { useAccount } from "@/providers/EmailAccountProvider";
import { dismissHintAction } from "@/utils/actions/hints";
import { useTodayHref } from "@/hooks/useTodayHref";
import { getInboxStyleHintId } from "@/utils/split-inbox/inbox-styles";

export function getTodayIntroHintId(emailAccountId: string) {
  return `today-intro:${emailAccountId}`;
}

/**
 * Points to Today once, after setup and the first sync are done, since new
 * people otherwise never find it from the inbox.
 */
export function TodayIntroLine({ ready }: { ready: boolean }) {
  const { emailAccountId } = useAccount();
  const { data: user, mutate } = useUser();
  const hintId = getTodayIntroHintId(emailAccountId);
  const todayHref = useTodayHref();

  if (!ready || !user) return null;
  const setupDone = user.dismissedHints.includes(
    getInboxStyleHintId(emailAccountId),
  );
  if (!setupDone || user.dismissedHints.includes(hintId)) return null;

  const dismiss = () => {
    mutate(
      { ...user, dismissedHints: [...user.dismissedHints, hintId] },
      { revalidate: false },
    );
    dismissHintAction({ hintId }).then(() => mutate());
  };

  return (
    <div className="mx-3 my-2 flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <SunIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="min-w-0 flex-1">
        Your day, prepared:{" "}
        <Link
          href={todayHref}
          onClick={dismiss}
          className="font-medium underline underline-offset-4"
        >
          see what needs you on Today
        </Link>
      </p>
      <Button
        size="iconXs"
        variant="ghost"
        aria-label="Dismiss"
        onClick={dismiss}
      >
        <XIcon className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
