"use client";

import {
  BrainIcon,
  CalendarIcon,
  ContactIcon,
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  GlobeIcon,
  GraduationCapIcon,
  ListTodoIcon,
  type LucideIcon,
  MailIcon,
  MessageSquareQuoteIcon,
  MessagesSquareIcon,
  SparklesIcon,
} from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { LoadingContent } from "@/components/LoadingContent";
import { toastError, toastSuccess } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useReplySuggestion } from "@/hooks/useReplySuggestion";
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
  file: FileTextIcon,
  assignment: GraduationCapIcon,
  chat: MessagesSquareIcon,
  web: GlobeIcon,
  task: ListTodoIcon,
  contact: ContactIcon,
  memory: BrainIcon,
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
  const { phase, suggestion, error } = useReplySuggestion({
    threadId,
    emailAccountId,
    enabled: requested,
  });

  if (!requested) {
    return (
      <div>
        <p className="text-muted-foreground text-xs leading-5">
          Only suggested when every fact in it is quoted from your mail,
          calendar, apps or the web.
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
      loading={phase !== "done"}
      loadingComponent={<Note>{suggestionPhaseLabel(phase)}</Note>}
    >
      {suggestion ? (
        <SuggestionBody
          key={threadId}
          onOpenThread={onOpenThread}
          emailAccountId={emailAccountId}
          suggestion={suggestion}
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
      return <Note>{abstentionLine(suggestion.missing)}</Note>;
    case "suggested": {
      const text = edited ?? suggestion.reply;
      return (
        <div className="fade-in animate-in space-y-3 duration-150">
          <Textarea
            aria-label="Suggested reply"
            className="min-h-32 text-sm leading-6"
            onChange={(e) => setEdited(e.target.value)}
            value={text}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={!text.trim() || hasSucceeded}
              loading={isExecuting}
              onClick={() =>
                execute({
                  threadId,
                  content: text,
                  suggested: suggestion.reply,
                })
              }
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
          <CheckedAgainst
            citations={suggestion.citations}
            onOpenThread={onOpenThread}
          />
        </div>
      );
    }
  }
}

/**
 * The reason to trust a suggested reply, in one muted line: what it was
 * checked against. Opens the quotes that back each fact.
 */
export function CheckedAgainst({
  citations,
  onOpenThread,
}: {
  citations: Citation[];
  onOpenThread: (threadId: string) => void;
}) {
  if (!citations.length) return null;
  const places = [
    ...new Set(citations.map((c) => SOURCE_PLACE[c.source.kind])),
  ];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1.5 rounded-md text-left text-muted-foreground text-xs transition-colors hover:text-foreground"
          type="button"
        >
          <CheckIcon className="size-3.5 shrink-0" />
          Checked against {joinWords(places)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1">
        <ul className="max-h-80 space-y-0.5 overflow-y-auto">
          {citations.map((citation, index) => (
            <li key={index}>
              <CitationRow citation={citation} onOpenThread={onOpenThread} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Says, without alarm, that Cue left a reply to the user and why. The reason
 * is the model's own words, so it is named only when it reads as a short
 * phrase; anything else would put raw model text in front of the user.
 */
export function abstentionLine(missing: string) {
  // Its first sentence names what's missing; the rest explains, too long here.
  const sentence = missing.trim().split(/(?<=[.!?])\s/)[0] ?? "";
  const what = sentence.replace(/[.!]+$/, "");
  if (!isShortPhrase(what)) return "Cue left this reply to you.";
  return `Cue couldn't confirm ${what.charAt(0).toLowerCase()}${what.slice(1)}, so it left this for you.`;
}

export function suggestionPhaseLabel(
  phase: ReturnType<typeof useReplySuggestion>["phase"],
) {
  return phase === "checking-web"
    ? "Searching public web pages…"
    : "Checking your mail and calendar…";
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
          {sourceLabel(source)}
        </div>
      </div>
    </div>
  );
  const className =
    "block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60 active:bg-muted";

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

const SOURCE_PLACE: Record<Citation["source"]["kind"], string> = {
  message: "this conversation",
  email: "your email",
  event: "your calendar",
  file: "your files",
  assignment: "your courses",
  chat: "your chats",
  web: "the web",
  task: "your tasks",
  contact: "your contacts",
  memory: "your past edits",
};

function sourceLabel(source: Citation["source"]) {
  if (source.kind === "message") return "This conversation";
  if (source.kind === "web" && source.url)
    return `Web · ${new URL(source.url).hostname.replace(/^www\./, "")}`;
  return source.title;
}

function joinWords(words: string[]) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

const MAX_REASON_LENGTH = 60;
const MAX_REASON_WORDS = 8;

// A list, a question or a clause doesn't fit "Cue couldn't confirm …".
function isShortPhrase(text: string) {
  return (
    text.length > 0 &&
    text.length <= MAX_REASON_LENGTH &&
    text.split(/\s+/).length <= MAX_REASON_WORDS &&
    !/[?,:;()[\]{}"“”<>\n]/.test(text)
  );
}
