"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import type { MatchingBulkAction } from "@/utils/actions/mail-bulk-matching.validation";
import { getMatchingConfirmCopy } from "@/app/(app)/[emailAccountId]/mail/select-all-matching";

/** Asks before a destructive action over many conversations, or one for good. */
export function MatchingConfirmDialog({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: { action: MatchingBulkAction; total: number | null } | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const copy = pending
    ? getMatchingConfirmCopy(pending.action, pending.total)
    : null;

  return (
    <AlertDialog
      open={Boolean(pending)}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={onConfirm}
          >
            {copy?.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
