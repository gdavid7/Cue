"use client";

import { PaperclipIcon } from "lucide-react";
import { memo, useMemo, type Ref } from "react";
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
  onToggleSelect,
  onSelectRangeTo,
  rowRef,
  sentMessageOpen,
  insightData,
  accountColorClassName,
  rowActions,
}: ThreadRowProps) {
  const message = thread.messages.at(-1);
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
    <MailThreadRow
      accountAvatar={
        account ? (
          <AccountMarker
            account={account}
            colorClassName={accountColorClassName}
          />
        ) : null
      }
      compact={compact}
      date={
        <div className="relative flex items-center justify-end">
          <div
            className={cn(
              "flex items-center justify-end gap-1.5",
              showActions && "group-hover:invisible",
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
          {showActions && rowActions ? (
            <div className="-translate-y-1/2 absolute top-1/2 right-0 hidden rounded-md bg-background shadow-sm group-hover:flex">
              <ThreadRowActions
                handlers={rowActions}
                isArchived={isThreadArchived(thread.messages)}
                isStarred={isThreadStarred(thread.messages)}
                isUnread={isThreadUnread(thread.messages)}
                threadKey={getListThreadKey(thread)}
              />
            </div>
          ) : null}
        </div>
      }
      expandedPreview={expandedPreview}
      hasAnySelection={hasAnySelection}
      index={index}
      insight={insight ? <InsightText line={insight} /> : null}
      isDraft={isDraft}
      isFocused={isFocused}
      isSelected={isSelected}
      isStarred={isThreadStarred(thread.messages)}
      isUnread={isThreadUnread(thread.messages)}
      labels={chips.map((label) => (
        <MailLabelChip color={label.color} key={label.id} name={label.name} />
      ))}
      layout={layout}
      messageCount={thread.messages.length}
      onOpen={onOpen}
      onSelectRangeTo={onSelectRangeTo}
      onToggleSelect={onToggleSelect}
      participantSummary={participantSummary}
      renderSelectionControl={({ ariaLabel, checked, onClick, visible }) => (
        // Opening above would cover the select-all checkbox for the first row.
        <Tooltip shortcuts={["select"]} side="right">
          <Checkbox
            aria-label={ariaLabel}
            checked={checked}
            className={cn(
              mailCheckboxClassName,
              "transition-opacity",
              visible
                ? "opacity-100"
                : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
            )}
            onClick={onClick}
          />
        </Tooltip>
      )}
      rowRef={rowRef}
      selectionEnabled={selectionEnabled}
      snippet={decodeSnippet(thread.snippet || message.snippet)}
      subject={message.headers.subject}
    />
  );
});

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

function InsightText({ line }: { line: InsightLine }) {
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
function AccountMarker({
  account,
  colorClassName,
}: {
  account: { email: string };
  colorClassName?: string;
}) {
  const initial = account.email.trim().at(0)?.toUpperCase() || "@";

  return (
    <span
      aria-label={`Inbox: ${account.email}`}
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
