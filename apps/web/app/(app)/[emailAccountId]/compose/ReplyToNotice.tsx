"use client";

import { Button } from "@/components/ui/button";

/**
 * One quiet line when a reply is addressed to the Reply-To the sender set at
 * another domain, the usual shape of a redirected invoice, with a way to
 * answer the sender instead.
 */
export function ReplyToNotice({
  address,
  sender,
  onReplyToSender,
}: {
  address: string;
  sender: string;
  onReplyToSender: () => void;
}) {
  return (
    <div className="flex min-h-6 flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
      <span className="min-w-0 break-words">
        Goes to {address}, set by the sender's Reply-To
      </span>
      <Button
        type="button"
        variant="ghostMuted"
        size="sm"
        className="h-6 px-1.5 text-xs underline-offset-2 hover:bg-transparent hover:underline"
        onClick={onReplyToSender}
      >
        Reply to {sender} instead
      </Button>
    </div>
  );
}
