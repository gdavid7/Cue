"use client";

import { PanelRightOpenIcon, SparklesIcon, XIcon } from "lucide-react";
import { parseAsString, useQueryStates } from "nuqs";
import { MarkNeedsReplyButton } from "@/components/thread-context/MarkNeedsReplyButton";
import { SuggestedReply } from "@/components/thread-context/SuggestedReply";
import { ThreadContextList } from "@/components/thread-context/ThreadContextList";
import { Button } from "@/components/ui/button";

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
}: {
  threadId: string;
  emailAccountId: string;
  onClose: () => void;
}) {
  const [, setOpenThread] = useQueryStates({
    "thread-id": parseAsString,
    "thread-account-id": parseAsString,
  });
  const openThread = (id: string) =>
    setOpenThread({ "thread-id": id, "thread-account-id": emailAccountId });

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
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-3">
        <ThreadContextList
          emailAccountId={emailAccountId}
          onOpenThread={openThread}
          threadId={threadId}
        />
        <section className="space-y-2 border-border border-t px-2 pt-4">
          <h3 className="font-medium text-foreground text-sm">
            Suggested reply
          </h3>
          <SuggestedReply
            emailAccountId={emailAccountId}
            onOpenThread={openThread}
            threadId={threadId}
          />
        </section>
        <section className="space-y-2 border-border border-t px-2 pt-4">
          <p className="text-muted-foreground text-xs leading-5">
            Should this be waiting on you? Cue will track it until you reply.
          </p>
          <MarkNeedsReplyButton
            emailAccountId={emailAccountId}
            threadId={threadId}
          />
        </section>
      </div>
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
