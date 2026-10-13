"use client";

import { PanelRightOpenIcon, SparklesIcon, XIcon } from "lucide-react";
import { parseAsString, useQueryStates } from "nuqs";
import { MarkNeedsReplyButton } from "@/components/thread-context/MarkNeedsReplyButton";
import { SuggestedReply } from "@/components/thread-context/SuggestedReply";
import { ThreadContextList } from "@/components/thread-context/ThreadContextList";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * What else in the user's mail and calendar matters for this thread, found by
 * walking from the people on it and by shared topic, each item saying why it's
 * here. Also where to correct the AI's triage and ask for a reply backed by
 * that context.
 */
export function ThreadContextPanel({
  threadId,
  emailAccountId,
  onClose,
  onDraftSaved,
  onWriteReply,
  variant,
}: {
  threadId: string;
  emailAccountId: string;
  /**
   * `inline` sits beside the reader as a pane. `sheet` slides over it, for
   * readers too narrow to give up a column.
   */
  variant: "inline" | "sheet";
  onClose: () => void;
  onDraftSaved?: () => void;
  onWriteReply?: () => void;
}) {
  const [, setOpenThread] = useQueryStates({
    "thread-id": parseAsString,
    "thread-account-id": parseAsString,
  });
  const openThread = (id: string) =>
    setOpenThread({ "thread-id": id, "thread-account-id": emailAccountId });

  const body = (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-3">
      <ThreadContextList
        emailAccountId={emailAccountId}
        onOpenThread={openThread}
        threadId={threadId}
      />
      <section className="space-y-2 border-border border-t px-2 pt-4">
        <h3 className="font-medium text-foreground text-sm">Suggested reply</h3>
        <SuggestedReply
          emailAccountId={emailAccountId}
          onDraftSaved={onDraftSaved}
          onOpenThread={openThread}
          onWriteReply={onWriteReply}
          threadId={threadId}
        />
      </section>
      <section className="space-y-2 border-border border-t px-2 pt-4">
        <p className="text-muted-foreground text-xs leading-5">
          Not marked as needing your reply? Cue can track it until you answer.
        </p>
        <MarkNeedsReplyButton
          emailAccountId={emailAccountId}
          threadId={threadId}
        />
      </section>
    </div>
  );

  if (variant === "sheet") {
    return (
      <Sheet onOpenChange={(open) => !open && onClose()} open>
        <SheetContent
          className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
          data-testid="thread-context-panel"
        >
          <div className="flex items-center gap-2 border-border border-b px-5 py-4 pr-12">
            <SparklesIcon className="size-4 text-muted-foreground" />
            <SheetTitle className="font-title font-medium text-foreground text-sm">
              Relevant context
            </SheetTitle>
          </div>
          <SheetDescription className="sr-only">
            Related mail, meetings and files, and a suggested reply.
          </SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      aria-label="Relevant context"
      className="flex w-80 shrink-0 flex-col border-border border-l bg-card"
      data-testid="thread-context-panel"
    >
      <div className="flex items-center gap-2 border-border border-b px-5 py-4">
        <SparklesIcon className="size-4 text-muted-foreground" />
        <h2 className="flex-1 font-title font-medium text-foreground text-sm">
          Relevant context
        </h2>
        <Button
          aria-label="Hide relevant context"
          className="-mr-2"
          onClick={onClose}
          size="iconXs"
          type="button"
          variant="ghostMuted"
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      {body}
    </aside>
  );
}

/** Shown in place of the panel after it's hidden, to bring it back. */
export function ThreadContextRail({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex shrink-0 flex-col items-center border-border border-l bg-card px-1 py-3">
      <Button
        aria-label="Show relevant context"
        onClick={onOpen}
        size="iconXs"
        title="Show relevant context"
        type="button"
        variant="ghostMuted"
      >
        <PanelRightOpenIcon className="size-4" />
      </Button>
    </div>
  );
}
