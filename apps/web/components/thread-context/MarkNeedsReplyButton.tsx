"use client";

import { CornerUpLeftIcon } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { toastError, toastSuccess } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { markNeedsReplyAction } from "@/utils/actions/thread-assist";
import { getActionErrorMessage } from "@/utils/error";

/**
 * The correction for when the AI filed or skipped something that matters:
 * brings the conversation back to the inbox and into "Needs you".
 */
export function MarkNeedsReplyButton({
  threadId,
  emailAccountId,
  onMarked,
}: {
  threadId: string;
  emailAccountId: string;
  onMarked?: () => void;
}) {
  const { execute, isExecuting, hasSucceeded, input } = useAction(
    markNeedsReplyAction.bind(null, emailAccountId),
    {
      onSuccess: () => {
        toastSuccess({ description: "Moved to Needs you" });
        onMarked?.();
      },
      onError: (error) =>
        toastError({
          description: getActionErrorMessage(error.error, {
            prefix: "Couldn't mark it",
          }),
        }),
    },
  );
  // The same button stays mounted when another conversation is picked.
  const done = hasSucceeded && input?.threadId === threadId;

  return (
    <Button
      disabled={done}
      loading={isExecuting}
      onClick={() => execute({ threadId })}
      size="sm"
      type="button"
      variant="outline"
    >
      <CornerUpLeftIcon className="mr-2 size-4" />
      {done ? "Tracking until you reply" : "Track until I reply"}
    </Button>
  );
}
