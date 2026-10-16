"use client";

import { type ReactNode, useMemo, useState } from "react";
import {
  ArchiveIcon,
  CalendarPlusIcon,
  Clock3Icon,
  Loader2Icon,
  MailMinusIcon,
  PenLineIcon,
  SparklesIcon,
} from "lucide-react";
import {
  AddToCalendarPopover,
  useCalendarDraft,
} from "@/app/(app)/[emailAccountId]/mail/AddToCalendarButton";
import {
  type CueStripAction,
  getCueStripActions,
  getCueStripVisibility,
  getThreadCategories,
} from "@/app/(app)/[emailAccountId]/mail/cue-strip";
import { SnoozeButton } from "@/app/(app)/[emailAccountId]/mail/SnoozeButton";
import { useUnsubscribeSender } from "@/app/(app)/[emailAccountId]/mail/use-unsubscribe-sender";
import type { ThreadMessage } from "@/components/email-list/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useInboxInsights } from "@/hooks/useInboxInsights";
import { useThreadBrief } from "@/hooks/useThreadBrief";
import { useThreadPlans } from "@/hooks/useThreadPlans";
import type { EmailLabels } from "@/providers/email-label-types";
import { cn } from "@/utils";

const NO_PLANS: never[] = [];

/**
 * Cue's read of the open conversation, above the messages: what the sender
 * wants in one line, up to three actions that fit, and a way to ask Cue
 * about it. Only for conversations with people (see `getCueStripVisibility`).
 *
 * The messages never wait for it. Once Cue knows the strip belongs, its
 * space is held at full height while the summary loads behind a skeleton.
 */
export function CueStrip({
  emailAccountId,
  threadId,
  messages,
  userLabels,
  subject,
  enabled,
  reply,
  onDraftReply,
  onArchive,
  onSnooze,
  onAskCue,
}: {
  /** The account that owns the thread, not the one the screen started on. */
  emailAccountId: string;
  threadId: string;
  /** The thread's messages without drafts, oldest first. */
  messages: ThreadMessage[];
  userLabels: EmailLabels;
  subject: string;
  /**
   * False until the conversation is actually open, so moving through the list
   * with the keyboard never asks for a summary.
   */
  enabled: boolean;
  reply: { canRequest: boolean; pending: boolean };
  onDraftReply: () => void;
  onArchive?: () => void;
  onSnooze?: (until: Date) => void;
  /** Unset when the assistant can't see this thread, e.g. another account's. */
  onAskCue?: () => void;
}) {
  const latest = messages.at(-1);
  const messageId = latest?.id;

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
      insight: undefined,
    }) === "pending";

  // The same request the reader's reply suggestion and calendar action make,
  // so it's usually already answered from the inbox's own notes.
  const insightItems = useMemo(
    () =>
      enabled && messageId && needsInsight
        ? [{ key: threadId, emailAccountId, threadId, messageId }]
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
    insight,
  });
  const show = enabled && visibility === "show";

  const { data: briefData, error: briefError } = useThreadBrief({
    emailAccountId,
    threadId,
    messageId,
    enabled: show,
  });
  const briefSettled = Boolean(briefData || briefError);
  const calendarDraft = useCalendarDraft({
    emailAccountId,
    threadId,
    messageId: messageId ?? "",
    subject,
  });
  const unsubscribeMessage = latest?.headers["list-unsubscribe"]
    ? latest
    : null;

  // Chosen once per message, when the summary lands: buttons that reshuffled
  // as slower answers arrived would move under the user's pointer.
  const [chosen, setChosen] = useState<{
    messageId: string;
    actions: CueStripAction[];
  }>();
  if (show && briefSettled && messageId && chosen?.messageId !== messageId) {
    setChosen({
      messageId,
      actions: getCueStripActions({
        canDraftReply: reply.canRequest,
        canAddToCalendar: Boolean(calendarDraft),
        canUnsubscribe: Boolean(unsubscribeMessage),
        canSnooze: Boolean(onSnooze),
        canArchive: Boolean(onArchive),
      }),
    });
  }
  const actions = chosen?.messageId === messageId ? chosen.actions : [];

  if (!show) return null;

  const brief = briefData?.brief;

  const renderAction = (action: CueStripAction): ReactNode => {
    switch (action) {
      case "draft-reply":
        return reply.canRequest || reply.pending ? (
          <StripButton
            busy={reply.pending}
            icon={reply.pending ? SpinnerIcon : PenLineIcon}
            key={action}
            onClick={onDraftReply}
          >
            {reply.pending ? "Drafting…" : "Draft reply"}
          </StripButton>
        ) : null;
      case "add-to-calendar":
        return calendarDraft ? (
          <AddToCalendarPopover
            draft={calendarDraft}
            emailAccountId={emailAccountId}
            key={action}
            trigger={
              <StripButton icon={CalendarPlusIcon}>Add to calendar</StripButton>
            }
          />
        ) : null;
      case "unsubscribe":
        return unsubscribeMessage ? (
          <StripUnsubscribeButton key={action} message={unsubscribeMessage} />
        ) : null;
      case "snooze":
        return onSnooze ? (
          <SnoozeButton
            key={action}
            onSnooze={onSnooze}
            trigger={<StripButton icon={Clock3Icon}>Snooze</StripButton>}
          />
        ) : null;
      case "archive":
        return onArchive ? (
          <StripButton icon={ArchiveIcon} key={action} onClick={onArchive}>
            Archive
          </StripButton>
        ) : null;
    }
  };

  return (
    <section
      aria-busy={!briefSettled}
      aria-label="Cue summary"
      className="fade-in mb-3 flex animate-in flex-col gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 duration-200 motion-reduce:animate-none sm:flex-row sm:items-center sm:gap-3 sm:py-1.5"
      data-cue-strip
    >
      <div className="flex min-h-6 min-w-0 flex-1 items-center gap-2 pointer-coarse:min-h-9">
        <SparklesIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
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
            <span className="sr-only" role="status">
              Summarizing this conversation
            </span>
          </>
        )}
      </div>
      <div className="flex min-h-6 shrink-0 flex-wrap items-center gap-1 pointer-coarse:min-h-9">
        {actions.map(renderAction)}
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
  );
}

/**
 * One line, so the strip keeps its height; the whole of it is a press away and
 * always there for screen readers.
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
        "min-w-0 rounded-sm text-left text-foreground/90 text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-[13px]",
        expanded ? "whitespace-normal" : "truncate",
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
