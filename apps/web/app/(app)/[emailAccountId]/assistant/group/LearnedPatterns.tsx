"use client";

import { useState } from "react";
import { useAction } from "next-safe-action/hooks";
import { ViewLearnedPatterns } from "@/app/(app)/[emailAccountId]/assistant/group/ViewLearnedPatterns";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { createGroupAction } from "@/utils/actions/group";
import { useAccount } from "@/providers/EmailAccountProvider";
import { toastError } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";
import { Skeleton } from "@/components/ui/skeleton";

export function LearnedPatternsDialog({
  ruleId,
  groupId,
  disabled,
  label = "View learned patterns",
}: {
  ruleId: string;
  groupId: string | null;
  disabled?: boolean;
  label?: string;
}) {
  const { emailAccountId } = useAccount();

  const [learnedPatternGroupId, setLearnedPatternGroupId] = useState<
    string | null
  >(groupId);

  const { execute, isExecuting } = useAction(
    createGroupAction.bind(null, emailAccountId),
    {
      onSuccess: (data) => {
        if (data.data?.groupId) {
          setLearnedPatternGroupId(data.data.groupId);
        } else {
          toastError({
            description: "There was an error setting up learned patterns.",
          });
        }
      },
      onError: (error) => {
        toastError({
          description: getActionErrorMessage(error.error),
        });
      },
    },
  );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={async () => {
            if (!ruleId) return;
            if (groupId) return;
            if (isExecuting) return;

            execute({ ruleId });
          }}
        >
          {label}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Learned patterns</DialogTitle>
          <DialogDescription>
            Learned patterns are senders and email types Cue has learned from
            your email history. When one matches, Cue picks this rule without
            checking its other conditions.
          </DialogDescription>
        </DialogHeader>

        {isExecuting ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          learnedPatternGroupId && (
            <ViewLearnedPatterns groupId={learnedPatternGroupId} />
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
