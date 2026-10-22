"use client";

import {
  ArchiveIcon,
  MailIcon,
  MailOpenIcon,
  PaperclipIcon,
} from "lucide-react";
import {
  memo,
  type MouseEvent,
  type PointerEvent,
  type Ref,
  useMemo,
  useRef,
} from "react";
import { MailThreadRow } from "@inboxzero/mail-ui/MailThreadRow";
import { isThreadStarred } from "@/app/(app)/[emailAccountId]/mail/star-state";
import { MailLabelChip } from "@/app/(app)/[emailAccountId]/mail/MailLabelChip";
import {
  isThreadArchived,
  isThreadUnread,
} from "@/app/(app)/[emailAccountId]/mail/read-state";
import {
  type ThreadRowActionHandlers,
  ThreadRowActions,
} from "@/app/(app)/[emailAccountId]/mail/ThreadRowActions";
import { getThreadParticipantNames } from "@/app/(app)/[emailAccountId]/mail/thread-participants";
import type { RowHoverIntent } from "@/app/(app)/[emailAccountId]/mail/use-reader-row-prefetch";
import { useRowSwipe } from "@/app/(app)/[emailAccountId]/mail/use-row-swipe";
import {
  getListThreadKey,
  type ListThread,
  type MailLayoutMode,
} from "@/app/(app)/[emailAccountId]/mail/types";
import { EmailDate } from "@/components/email-list/EmailDate";
import { SentMessageOpenStatus } from "@/components/email-list/SentMessageOpenStatus";
import { getEmailThreadLabels } from "@/components/EmailMessageCellLabels";
import { Tooltip } from "@/components/Tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { mailCheckboxClassName } from "@/app/(app)/[emailAccountId]/mail/SelectAllCheckbox";
import type { EmailLabels } from "@/providers/email-label-types";
import { cn } from "@/utils";
import { internalDateToDate } from "@/utils/date";
import { decodeSnippet } from "@/utils/gmail/decode";
import { GmailLabel } from "@/utils/gmail/label";
import { SystemType } from "@/generated/prisma/enums";
import { getRuleLabel } from "@/utils/rule/consts";
import {
  composeInsight,
  type InsightLine,
} from "@/utils/inbox-insights/compose-insight";
import type { ThreadInsightData } from "@/utils/inbox-insights/get-inbox-insights";

export type ThreadRowProps = {
  thread: ListThread;
  /** Position in the rendered list — selection and focus are index-addressed. */
  index: number;
  layout: MailLayoutMode;
  userEmail: string;
  userLabels: EmailLabels;
  isFocused: boolean;
  isSelected: boolean;
  /** Keeps every checkbox visible once the list has a selection. */
  hasAnySelection: boolean;
  compact?: boolean;
  /** Wraps the snippet onto its own line so more of it is readable. */
  expandedPreview?: boolean;
  selectionEnabled?: boolean;
  onOpen: (index: number) => void;
  /** The mouse came to rest on the row (see use-reader-row-prefetch). */
  onHoverIntent?: (intent: RowHoverIntent) => void;
  /** The mouse left the row or pressed it. */
  onHoverIntentEnd?: (threadId: string) => void;
  onToggleSelect: (index: number) => void;
  onSelectRangeTo: (index: number) => void;
  rowRef?: Ref<HTMLDivElement>;
  sentMessageOpen?: {
    firstOpenedAt: string | null;
    lastOpenedAt: string | null;
    openCount: number;
  };
  insightData?: ThreadInsightData;
  /** Background of the marker naming a combined-inbox row's account. */
  accountColorClassName?: string;
  /** The row is in its account's inbox, which its account marker then names. */
  inInbox?: boolean;
  /** Hover actions on wide rows; touch layouts use selection instead. */
  rowActions?: ThreadRowActionHandlers;
};

export const ThreadRow = memo(function ThreadRow({
  thread,
  index,
  layout,
  userEmail,
  userLabels,
  isFocused,
  isSelected,
  hasAnySelection,
  compact = false,
  expandedPreview = false,
  selectionEnabled = true,
  onOpen,
  onHoverIntent,
  onHoverIntentEnd,
  onToggleSelect,
  onSelectRangeTo,
  rowRef,
  sentMessageOpen,
  insightData,
  accountColorClassName,
  inInbox,
  rowActions,
}: ThreadRowProps) {
  // Like Gmail, an unsent draft is marked on the row but doesn't stand in for
  // the message the user received.
  const message =
    thread.messages.findLast(
      (message) => !message.labelIds?.includes(GmailLabel.DRAFT),
    ) ?? thread.messages.at(-1);
  const labels = useMemo(
    () =>
      getEmailThreadLabels({
        messages: thread.messages,
        userLabels,
      }),
    [thread.messages, userLabels],
  );
  const account = "account" in thread ? thread.account : null;
  const accountEmail = account?.email ?? userEmail;
  const participantSummary = useMemo(
    () =>
      getThreadParticipantNames(
        [...(thread.participantMessages ?? []), ...thread.messages],
        accountEmail,
      ).join(", "),
    [thread.messages, thread.participantMessages, accountEmail],
  );

  const longPress = useLongPressToSelect(() => {
    if (selectionEnabled) onToggleSelect(index);
  });
  const isUnread = isThreadUnread(thread.messages);
  const threadKey = getListThreadKey(thread);
  // While selecting, a touch picks rows; it shouldn't also move them.
  const swipeEnabled = !!rowActions && !hasAnySelection;
  const swipe = useRowSwipe({
    enabled: swipeEnabled
      ? { archive: !isThreadArchived(thread.messages), toggleRead: true }
      : null,
    // The same handlers as the hover actions, so sync, the optimistic update
    // and Undo behave as they do for the keyboard and toolbar.
    onCommit: (action) => {
      if (!rowActions) return;
      if (action === "archive") rowActions.archive(threadKey);
      else rowActions.setRead(threadKey, isUnread);
    },
  });

  const insight = useMemo(
    () =>
      composeInsight({
        thread,
        labelNames: (id) => userLabels[id]?.name,
        userEmail: accountEmail,
        data: insightData,
      }),
    [thread, userLabels, accountEmail, insightData],
  );

  if (!message) return null;

  // The insight line already says whose move it is, so the reply-tracking
  // labels would only repeat it.
  const chips = (
    insight
      ? labels.filter((label) => !REPLY_TRACKING_LABELS.has(label.name))
      : labels
  ).slice(0, layout === "list" && !compact ? 3 : 2);
  const showActions = !!rowActions && !compact;
  const isDraft = thread.messages.some((message) =>
    message.labelIds?.includes(GmailLabel.DRAFT),
  );

  return (
    // Touch has no hover or Shift, so holding a row selects it, as in the
    // platform mail apps, and swiping it archives or flips read state.
    // Text selection and iOS's callout would start on the same hold.
    <div
      className="group/swipe relative pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] data-[swiping]:overflow-hidden"
      onClickCapture={(event) => {
        swipe.handlers.onClickCapture(event);
        if (!event.isPropagationStopped()) longPress.onClickCapture(event);
      }}
      onContextMenu={longPress.onContextMenu}
      onPointerEnter={(event) => {
        // Touch has no hover, and a tap opens the row at once anyway.
        if (event.pointerType === "mouse")
          onHoverIntent?.({ thread, insightData, userLabels });
      }}
      onPointerLeave={() => onHoverIntentEnd?.(thread.id)}
      onPointerCancel={(event) => {
        longPress.onPointerCancel();
        swipe.handlers.onPointerCancel(event);
      }}
      onPointerDown={(event) => {
        onHoverIntentEnd?.(thread.id);
        longPress.onPointerDown(event);
        swipe.handlers.onPointerDown(event);
      }}
      onPointerMove={(event) => {
        longPress.onPointerMove(event);
        swipe.handlers.onPointerMove(event);
      }}
      onPointerUp={(event) => {
        longPress.onPointerUp();
        swipe.handlers.onPointerUp(event);
      }}
      ref={swipe.trackRef}
      // Vertical scrolling and zoom stay the browser's; sideways is the row's.
      style={swipeEnabled ? { touchAction: "pan-y pinch-zoom" } : undefined}
    >
      {swipeEnabled ? <RowSwipeReveal isUnread={isUnread} /> : null}
      <div
        className="relative group-data-[swiping]/swipe:bg-background"
        ref={swipe.layerRef}
      >
        <MailThreadRow
          accountAvatar={
            account ? (
              <AccountMarker
                account={account}
                colorClassName={accountColorClassName}
                inInbox={inInbox}
              />
            ) : null
          }
          compact={compact}
          date={
            <div className="relative flex items-center justify-end">
              <div
                className={cn(
                  "flex items-center justify-end gap-1.5",
                  showActions &&
                    "group-hover:invisible group-has-[:focus-visible]:invisible",
                )}
              >
                {thread.hasAttachments ? (
                  <PaperclipIcon
                    aria-label="Has attachments"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                ) : null}
                {sentMessageOpen ? (
                  <SentMessageOpenStatus compact open={sentMessageOpen} />
                ) : null}
                <EmailDate
                  className="font-normal text-xs"
                  date={internalDateToDate(message.internalDate)}
                />
              </div>
            </div>
          }
          actions={
            showActions && rowActions ? (
              // Over the date column, which the row hides on hover.
              <div
                className={cn(
                  "absolute hidden rounded-md bg-background shadow-sm group-hover:flex group-has-[:focus-visible]:flex",
                  layout === "list" ? "right-5" : "right-3.5",
                  expandedPreview ? "top-2" : "-translate-y-1/2 top-1/2",
                )}
              >
                <ThreadRowActions
                  handlers={rowActions}
                  isArchived={isThreadArchived(thread.messages)}
                  isStarred={isThreadStarred(thread.messages)}
                  isUnread={isUnread}
                  threadKey={threadKey}
                />
              </div>
            ) : null
          }
          expandedPreview={expandedPreview}
          hasAnySelection={hasAnySelection}
          index={index}
          insight={insight ? <InsightText line={insight} /> : null}
          isDraft={isDraft}
          isFocused={isFocused}
          isSelected={isSelected}
          isStarred={isThreadStarred(thread.messages)}
          isUnread={isUnread}
          labels={chips.map((label) => (
            <MailLabelChip
              color={label.color}
              key={label.id}
              name={label.name}
            />
          ))}
          layout={layout}
          messageCount={thread.messages.length}
          onOpen={onOpen}
          onSelectRangeTo={onSelectRangeTo}
          onToggleSelect={onToggleSelect}
          participantSummary={participantSummary}
          renderSelectionControl={({
            ariaLabel,
            checked,
            onClick,
            visible,
          }) => (
            // Opening above would cover the select-all checkbox for the first row.
            // A click selects at once; a tooltip it left open would also take
            // the Escape that clears the selection.
            <Tooltip openOnClick={false} shortcuts={["select"]} side="right">
              <Checkbox
                // A pointer control only: inside the option it would prefix every
                // row's name, and aria-selected already says it is selected.
                aria-hidden
                aria-label={ariaLabel}
                checked={checked}
                className={cn(
                  mailCheckboxClassName,
                  // Below `lg` there's no hover to reveal it, and a finger needs
                  // a 44px target around the small box.
                  "relative transition-opacity max-lg:before:absolute max-lg:before:-inset-[15px] max-lg:before:content-['']",
                  visible
                    ? "opacity-100"
                    : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-lg:opacity-100",
                )}
                onClick={onClick}
                // Not on the hidden checkbox: the click puts focus on its row,
                // where J/K, Enter, Space and Escape carry on.
                onMouseDown={(event) => event.preventDefault()}
                // The listbox moves focus between rows; Space, `x` and Shift+click
                // select, so a tab stop per row would only bury the rest of the page.
                tabIndex={-1}
              />
            </Tooltip>
          )}
          rowRef={rowRef}
          selectionEnabled={selectionEnabled}
          snippet={decodeSnippet(
            // The provider's thread snippet follows the newest message, a draft too.
            isDraft
              ? message.snippet || thread.snippet
              : thread.snippet || message.snippet,
          )}
          subject={message.headers.subject}
        />
      </div>
    </div>
  );
});

/**
 * What a swipe will do, revealed behind the row as it moves: muted until the
 * commit point, then the action's color. Decoration only; the same actions
 * are on the keyboard, the toolbar and the hover buttons.
 */
function RowSwipeReveal({ isUnread }: { isUnread: boolean }) {
  const ReadIcon = isUnread ? MailOpenIcon : MailIcon;
  const side =
    "absolute inset-0 hidden items-center bg-muted px-6 text-muted-foreground transition-colors duration-150";
  const icon =
    "size-5 scale-90 transition-transform duration-150 group-data-[armed]/swipe:scale-110";
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div
        className={cn(
          side,
          "justify-start group-data-[swiping=toggleRead]/swipe:flex group-data-[armed]/swipe:bg-primary group-data-[armed]/swipe:text-primary-foreground",
        )}
        data-testid="row-swipe-reveal-read"
      >
        <ReadIcon className={icon} />
      </div>
      <div
        className={cn(
          side,
          "justify-end group-data-[swiping=archive]/swipe:flex group-data-[armed]/swipe:bg-emerald-600 group-data-[armed]/swipe:text-white",
        )}
        data-testid="row-swipe-reveal-archive"
      >
        <ArchiveIcon className={icon} />
      </div>
    </div>
  );
}

const REPLY_TRACKING_LABELS = new Set([
  getRuleLabel(SystemType.TO_REPLY),
  getRuleLabel(SystemType.AWAITING_REPLY),
]);

const INSIGHT_TONE: Record<InsightLine["tone"], string> = {
  ready: "text-emerald-700 dark:text-emerald-400",
  action: "text-primary",
  pending: "text-amber-700 dark:text-amber-400",
  info: "text-muted-foreground",
};

export function InsightText({ line }: { line: InsightLine }) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1 text-xs",
        INSIGHT_TONE[line.tone],
      )}
      data-testid="thread-insight"
    >
      <span aria-hidden className="shrink-0">
        ↳
      </span>
      <span className="truncate">{line.parts.join(" · ")}</span>
    </span>
  );
}

// A color and initial rather than the profile photo: one person's accounts
// often share a photo, which would make every row look the same.
export function AccountMarker({
  account,
  colorClassName,
  inInbox = false,
}: {
  account: { email: string };
  colorClassName?: string;
  /** The row is the account's inbox mail, so the marker names an inbox. */
  inInbox?: boolean;
}) {
  const initial = account.email.trim().at(0)?.toUpperCase() || "@";

  return (
    <span
      aria-label={`${inInbox ? "Inbox" : "Account"}: ${account.email}`}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full font-medium text-[10px] text-white",
        colorClassName ?? "bg-muted-foreground",
      )}
      role="img"
      title={account.email}
    >
      {initial}
    </span>
  );
}

const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP_PX = 10;

/**
 * Selects on a touch hold, then swallows the click that ends it so the row
 * doesn't also open. Moving the finger (a scroll) cancels the hold.
 */
function useLongPressToSelect(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  return {
    onPointerDown: (event: PointerEvent) => {
      fired.current = false;
      if (event.pointerType !== "touch") return;
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        timer.current = null;
        navigator.vibrate?.(10);
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: PointerEvent) => {
      if (!start.current) return;
      if (
        Math.abs(event.clientX - start.current.x) > LONG_PRESS_SLOP_PX ||
        Math.abs(event.clientY - start.current.y) > LONG_PRESS_SLOP_PX
      )
        cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (event: MouseEvent) => {
      // A held finger opens the browser's own menu otherwise.
      if (fired.current || timer.current) event.preventDefault();
    },
    onClickCapture: (event: MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
