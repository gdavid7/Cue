"use client";

import { useMemo, useState } from "react";
import {
  Loader2Icon,
  MailMinusIcon,
  PenLineIcon,
  SparklesIcon,
} from "lucide-react";
import {
  getCueStripVisibility,
  getThreadCategories,
  isFromPerson,
} from "@/app/(app)/[emailAccountId]/mail/cue-strip";
import { useUnsubscribeSender } from "@/app/(app)/[emailAccountId]/mail/use-unsubscribe-sender";
import type { ThreadMessage } from "@/components/email-list/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { threadInsightItem, useInboxInsights } from "@/hooks/useInboxInsights";
import { useThreadBrief } from "@/hooks/useThreadBrief";
import { useThreadPlans } from "@/hooks/useThreadPlans";
import type { EmailLabels } from "@/providers/email-label-types";
import { cn } from "@/utils";

const NO_PLANS: never[] = [];

/**
 * Cue's read of the open conversation, above the messages: what the sender
 * wants in one line, the actions the reader doesn't already show, and a way
 * to ask Cue about it. Only for conversations with people (see
 * `getCueStripVisibility`).
 *
 * The messages never wait for it, and never move for it: its space is held
 * from the first render whenever it could show, and folds away if it doesn't.
 */
export function CueStrip({
  emailAccountId,
  threadId,
  messages,
  userLabels,
  newestIsIncoming,
  enabled,
  reply,
  onDraftReply,
  onAskCue,
}: {
  /** The account that owns the thread, not the one the screen started on. */
  emailAccountId: string;
  threadId: string;
  /** The thread's messages without drafts, oldest first. */
  messages: ThreadMessage[];
  userLabels: EmailLabels;
  /** Whether someone else wrote the newest message, not the user. */
  newestIsIncoming: boolean;
  /**
   * False until the conversation is actually open, so moving through the list
   * with the keyboard never asks for anything.
   */
  enabled: boolean;
  reply: { canRequest: boolean; drafts: boolean; pending: boolean };
  onDraftReply: () => void;
  /** Unset when the assistant can't see this thread, e.g. another account's. */
  onAskCue?: () => void;
}) {
  const latest = messages.at(-1);
  const messageId = latest?.id;
  const fromPerson =
    newestIsIncoming && latest ? isFromPerson(latest.headers) : false;

  const { data: planData, error: plansError } = useThreadPlans({
    threadId: enabled ? threadId : null,
    emailAccountId,
  });
  const categories = getThreadCategories({
    messages,
    userLabels,
    plans: planData?.plans ?? NO_PLANS,
  });
  const categoriesLoaded = Boolean(planData || plansError);
  const needsInsight =
    getCueStripVisibility({
      categories,
      categoriesLoaded,
      fromPerson,
      insight: undefined,
    }) === "pending";

  // The same request the reader's reply suggestion and calendar action make,
  // so it's usually already answered from the inbox's own notes.
  const insightItems = useMemo(
    () =>
      enabled && messageId && needsInsight
        ? [threadInsightItem({ emailAccountId, threadId, messageId })]
        : [],
    [enabled, messageId, needsInsight, threadId, emailAccountId],
  );
  const { data: insights, error: insightsError } =
    useInboxInsights(insightItems);
  const insight =
    insights || insightsError
      ? (insights?.[threadId]?.insight ?? null)
      : undefined;

  const visibility = getCueStripVisibility({
    categories,
    categoriesLoaded,
    fromPerson,
    insight,
  });

  const { data: briefData, error: briefError } = useThreadBrief({
    emailAccountId,
    threadId,
    messageId,
    enabled: enabled && visibility === "show",
  });
  const briefSettled = Boolean(briefData || briefError);

  // Held from the first render that could show it, so a strip that lands late
  // never pushes the messages down; one that won't show folds away instead.
  const [heldFor, setHeldFor] = useState<string>();
  if (messageId && visibility !== "hide" && heldFor !== messageId)
    setHeldFor(messageId);
  if (!messageId || heldFor !== messageId) return null;
  const open = visibility !== "hide";

  const brief = briefData?.brief;
  const unsubscribeMessage =
    latest?.headers["list-unsubscribe"] && visibility === "show"
      ? latest
      : null;

  return (
    <div
      aria-hidden={open ? undefined : true}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr] opacity-0",
      )}
      data-cue-strip-state={open ? visibility : "hidden"}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">
        <section
          aria-busy={!briefSettled}
          aria-label="Cue summary"
          className="mb-3 flex flex-col gap-1 rounded-lg border border-border/70 bg-muted/40 px-3 pt-2 pb-1.5"
          data-cue-strip
        >
          <div className="flex min-h-5 min-w-0 items-center gap-2 max-sm:min-h-10 max-sm:items-start">
            <SparklesIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground max-sm:mt-[3px]"
            />
            {briefSettled ? (
              <StripSummary
                key={messageId}
                quoted={brief?.source === "extract"}
                summary={brief?.summary}
              />
            ) : (
              <>
                <Skeleton className="h-3 w-full max-w-sm motion-reduce:animate-none" />
                {visibility === "show" && enabled ? (
                  <span className="sr-only" role="status">
                    Summarizing this conversation
                  </span>
                ) : null}
              </>
            )}
          </div>
          {/* Under the summary, so the line gets the strip's full width. Only
              what the toolbar and the phone's bottom bar don't already show. */}
          <div className="ml-4 flex min-h-6 flex-wrap items-center gap-1 pointer-coarse:min-h-9">
            {visibility === "show" && (reply.canRequest || reply.pending) ? (
              <StripButton
                busy={reply.pending}
                icon={reply.pending ? SpinnerIcon : PenLineIcon}
                onClick={onDraftReply}
              >
                {reply.pending
                  ? "Drafting…"
                  : reply.drafts
                    ? "Draft reply"
                    : "Reply"}
              </StripButton>
            ) : null}
            {unsubscribeMessage ? (
              <StripUnsubscribeButton message={unsubscribeMessage} />
            ) : null}
            {onAskCue ? (
              <StripButton
                aria-label="Ask Cue about this email"
                icon={SparklesIcon}
                onClick={onAskCue}
              >
                Ask Cue
              </StripButton>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * One line (two on a phone, in space held from the start), so the strip keeps
 * its height; the whole of it is a press away and always there for screen
 * readers.
 */
function StripSummary({
  summary,
  quoted,
}: {
  summary: string | undefined;
  /** The email's own words, shown when no model wrote the summary. */
  quoted: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!summary) {
    return (
      <p className="min-w-0 truncate text-muted-foreground text-xs">
        No summary for this conversation yet.
      </p>
    );
  }
  const text = quoted ? `“${summary}”` : summary;
  return (
    <button
      aria-expanded={expanded}
      className={cn(
        "min-w-0 rounded-sm text-left text-[13px] text-foreground/90 leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        expanded
          ? "whitespace-normal"
          : "truncate max-sm:line-clamp-2 max-sm:whitespace-normal",
      )}
      onClick={() => setExpanded((value) => !value)}
      title={expanded ? undefined : summary}
      type="button"
    >
      {text}
    </button>
  );
}

function StripUnsubscribeButton({ message }: { message: ThreadMessage }) {
  const { isUnsubscribeDisabled, onUnsubscribe, PremiumModal } =
    useUnsubscribeSender(message);
  return (
    <>
      <StripButton
        disabled={isUnsubscribeDisabled}
        icon={MailMinusIcon}
        onClick={onUnsubscribe}
      >
        Unsubscribe
      </StripButton>
      <PremiumModal />
    </>
  );
}

function StripButton({
  icon: Icon,
  busy = false,
  children,
  className,
  ...props
}: React.ComponentProps<typeof Button> & {
  icon: React.ElementType;
  busy?: boolean;
}) {
  return (
    <Button
      aria-busy={busy || undefined}
      className={cn(
        "gap-1 font-normal text-muted-foreground hover:text-foreground pointer-coarse:h-9 pointer-coarse:px-2.5",
        busy && "pointer-events-none",
        className,
      )}
      size="xs"
      variant="ghost"
      {...props}
    >
      <Icon aria-hidden className="size-3.5" />
      {children}
    </Button>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <Loader2Icon
      className={cn("animate-spin motion-reduce:animate-none", className)}
    />
  );
}
