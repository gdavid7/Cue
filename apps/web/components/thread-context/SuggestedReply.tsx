"use client";

import {
  CalendarIcon,
  CopyIcon,
  type LucideIcon,
  MailIcon,
  MessageSquareQuoteIcon,
  SparklesIcon,
} from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError, toastSuccess } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useSuggestedReply } from "@/hooks/useSuggestedReply";
import { saveSuggestedReplyAction } from "@/utils/actions/thread-assist";
import { getActionErrorMessage } from "@/utils/error";
import type {
  Citation,
  SuggestedReply as Suggestion,
} from "@/utils/thread-context/suggest-reply";

const SOURCE_ICON: Record<Citation["source"]["kind"], LucideIcon> = {
  message: MessageSquareQuoteIcon,
  email: MailIcon,
  event: CalendarIcon,
};

/**
 * A reply Cue suggests only when the conversation and related email and
 * meetings back every fact in it, shown with those sources. Otherwise it says
 * what's missing. Fetched on request: each suggestion is a model call.
 */
export function SuggestedReply({
  threadId,
  emailAccountId,
  onOpenThread,
}: {
  threadId: string;
  emailAccountId: string;
  onOpenThread: (threadId: string) => void;
}) {
  // Per thread, so picking another conversation doesn't run another model call.
  const [requestedFor, setRequestedFor] = useState<string | null>(null);
  const requested = requestedFor === threadId;
  const { data, isLoading, error } = useSuggestedReply({
    threadId,
    emailAccountId,
    enabled: requested,
  });

  if (!requested) {
    return (
      <div>
        <p className="text-muted-foreground text-xs leading-5">
          Only suggested when your email and calendar back every fact in it.
        </p>
        <Button
          className="mt-2"
          onClick={() => setRequestedFor(threadId)}
          size="sm"
          type="button"
          variant="outline"
        >
          <SparklesIcon className="mr-2 size-4" />
          Suggest a reply
        </Button>
      </div>
    );
  }

  return (
    <LoadingContent
      error={error}
      loading={isLoading}
      loadingComponent={
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            Checking what your email and calendar can back up…
          </p>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      }
    >
      {data?.suggestion ? (
        <SuggestionBody
          // A new thread starts a new edit.
          key={threadId}
          onOpenThread={onOpenThread}
          emailAccountId={emailAccountId}
          suggestion={data.suggestion}
          threadId={threadId}
        />
      ) : (
        <Note>No suggestion for this conversation.</Note>
      )}
    </LoadingContent>
  );
}

function SuggestionBody({
  suggestion,
  threadId,
  emailAccountId,
  onOpenThread,
}: {
  suggestion: Suggestion;
  threadId: string;
  emailAccountId: string;
  onOpenThread: (threadId: string) => void;
}) {
  const [edited, setEdited] = useState<string | null>(null);
  const { execute, isExecuting, hasSucceeded } = useAction(
    saveSuggestedReplyAction.bind(null, emailAccountId),
    {
      onSuccess: () =>
        toastSuccess({ description: "Saved as a draft in the conversation" }),
      onError: (error) =>
        toastError({
          description: getActionErrorMessage(error.error, {
            prefix: "Couldn't save the draft",
          }),
        }),
    },
  );

  switch (suggestion.status) {
    case "already-replied":
      return (
        <Note>You sent the last message, so there's nothing to reply to.</Note>
      );
    case "unavailable":
      return (
        <Note>Suggested replies need AI access. Upgrade or add an AI key.</Note>
      );
    case "insufficient":
      return (
        <div className="rounded-lg bg-amber-50 p-3 text-amber-950 text-sm dark:bg-amber-950/30 dark:text-amber-100">
          <div className="font-medium">Not enough to go on</div>
          <p className="mt-1 leading-5">
            {suggestion.missing ||
              "The reply would rely on facts your email and calendar don't back up."}
          </p>
          {suggestion.unsupported.length ? (
            <>
              <div className="mt-2 text-xs opacity-80">Couldn't confirm:</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                {suggestion.unsupported.map((fact, index) => (
                  <li key={index}>{fact}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      );
    case "suggested": {
      const text = edited ?? suggestion.reply;
      return (
        <div className="space-y-3">
          <Textarea
            aria-label="Suggested reply"
            className="min-h-32 text-sm leading-6"
            onChange={(e) => setEdited(e.target.value)}
            value={text}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!text.trim() || hasSucceeded}
              loading={isExecuting}
              onClick={() => execute({ threadId, content: text })}
              size="sm"
              type="button"
            >
              {hasSucceeded ? "Saved as draft" : "Save as draft"}
            </Button>
            <Button
              onClick={() =>
                navigator.clipboard
                  .writeText(text)
                  .then(() => toastSuccess({ description: "Copied" }))
              }
              size="sm"
              type="button"
              variant="outline"
            >
              <CopyIcon className="mr-2 size-4" />
              Copy
            </Button>
          </div>
          {suggestion.citations.length ? (
            <div>
              <div className="font-medium text-xs">Based on</div>
              <ul className="mt-1 space-y-1">
                {suggestion.citations.map((citation, index) => (
                  <li key={index}>
                    <CitationRow
                      citation={citation}
                      onOpenThread={onOpenThread}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              States no facts, so there was nothing to check.
            </p>
          )}
        </div>
      );
    }
  }
}

function CitationRow({
  citation,
  onOpenThread,
}: {
  citation: Citation;
  onOpenThread: (threadId: string) => void;
}) {
  const { source } = citation;
  const Icon = SOURCE_ICON[source.kind];
  const content = (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-xs">{citation.fact}</div>
        <div className="mt-0.5 line-clamp-2 text-muted-foreground text-xs italic">
          “{citation.quote}”
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {source.kind === "message" ? "This conversation" : source.title}
        </div>
      </div>
    </div>
  );
  const className =
    "block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60";

  if (source.threadId) {
    const threadId = source.threadId;
    return (
      <button
        className={className}
        onClick={() => onOpenThread(threadId)}
        type="button"
      >
        {content}
      </button>
    );
  }
  if (source.url) {
    return (
      <a
        className={className}
        href={source.url}
        rel="noreferrer"
        target="_blank"
      >
        {content}
      </a>
    );
  }
  return <div className={className}>{content}</div>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}
