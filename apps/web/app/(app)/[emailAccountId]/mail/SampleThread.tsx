"use client";

import { SparklesIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toastError } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";
import { useUser } from "@/hooks/useUser";
import { useAccount } from "@/providers/EmailAccountProvider";
import { dismissHintAction } from "@/utils/actions/hints";
import {
  getSampleThreadHintId,
  shouldShowSampleThread,
} from "@/app/(app)/[emailAccountId]/mail/sample-thread";

/**
 * A static example of what Cue does with a conversation, for inboxes too quiet
 * to show it. Lives outside the thread list, so it is never counted, selected,
 * searched, or sent anywhere. Every output below is written by hand; no model
 * is called.
 */
export function SampleThread({
  isPlainInbox,
  isFirstSync,
  isLoading,
  hasError,
  threadCount,
}: {
  isPlainInbox: boolean;
  isFirstSync: boolean;
  isLoading: boolean;
  hasError: boolean;
  threadCount: number;
}) {
  const { emailAccountId } = useAccount();
  const { data: user, mutate } = useUser();
  const hintId = getSampleThreadHintId(emailAccountId);

  if (
    !user ||
    !shouldShowSampleThread({
      isPlainInbox,
      isFirstSync,
      isLoading,
      hasError,
      threadCount,
      dismissed: user.dismissedHints.includes(hintId),
    })
  ) {
    return null;
  }

  const dismiss = () => {
    mutate(
      { ...user, dismissedHints: [...user.dismissedHints, hintId] },
      { revalidate: false },
    );
    dismissHintAction({ hintId }).then((result) => {
      if (result?.serverError || result?.validationErrors) {
        toastError({ description: getActionErrorMessage(result) });
      }
      mutate();
    });
  };

  return (
    <section
      aria-label="Sample conversation"
      className="mx-3 my-2 shrink-0 rounded-xl border border-border bg-card text-sm"
    >
      <header className="flex items-start gap-2 px-4 pt-3">
        <SparklesIcon
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Sample</Badge>
            <span className="font-medium">Cue</span>
            <span className="text-muted-foreground">
              Not real mail. It stays on this screen.
            </span>
          </div>
          <h2 className="mt-1 font-semibold">
            Here is what Cue does with a conversation
          </h2>
        </div>
        <Button
          size="iconXs"
          variant="ghost"
          aria-label="Dismiss sample"
          onClick={dismiss}
        >
          <XIcon className="size-4" aria-hidden />
        </Button>
      </header>

      <div className="space-y-3 px-4 pt-3 pb-4">
        <p className="text-muted-foreground">
          Hi, can you confirm Thursday at 2pm works for the project review? I
          need to book the room today.
        </p>
        <dl className="space-y-3">
          <div>
            <dt className="text-muted-foreground text-xs">Sorted for you</dt>
            <dd>Needs reply: someone is waiting on an answer today.</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Summary</dt>
            <dd>Asks you to confirm Thursday at 2pm for the project review.</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Suggested reply</dt>
            <dd className="mt-1 rounded-lg bg-muted px-3 py-2">
              Thursday at 2pm works for me. Please go ahead and book the room.
            </dd>
          </div>
        </dl>
        <p className="text-muted-foreground text-xs">
          Real mail gets this as it arrives. This sample goes away on its own
          once your inbox fills up.
        </p>
      </div>
    </section>
  );
}
