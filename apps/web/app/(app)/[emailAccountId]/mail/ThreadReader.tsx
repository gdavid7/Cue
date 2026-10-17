"use client";

import {
  Suspense,
  useCallback,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { useMailRoute } from "@/app/(app)/[emailAccountId]/mail/use-mail-route";
import { AlertCircleIcon, Loader2Icon, MailIcon } from "lucide-react";
import { AddToCalendarButton } from "@/app/(app)/[emailAccountId]/mail/AddToCalendarButton";
import { CueStrip } from "@/app/(app)/[emailAccountId]/mail/CueStrip";
import { ReaderToolbar } from "@/app/(app)/[emailAccountId]/mail/ReaderToolbar";
import { useReaderReplySuggestion } from "@/app/(app)/[emailAccountId]/mail/use-reader-reply-suggestion";
import { MailReaderSurface } from "@inboxzero/mail-ui/MailReaderSurface";
import { isThreadStarred } from "@/app/(app)/[emailAccountId]/mail/star-state";
import { useThreadTranslation } from "@/app/(app)/[emailAccountId]/mail/use-thread-translation";
import type {
  ListThread,
  MailLayoutMode,
} from "@/app/(app)/[emailAccountId]/mail/types";
import { EmailThreadLazy } from "@/components/email-list/EmailThreadLazy";
import type { MessageExpansionControls } from "@/components/email-list/EmailThread";
import { ReplyAssistContext } from "@/components/email-list/reply-assist";
import { ThreadContextList } from "@/components/thread-context/ThreadContextList";
import type { ThreadMessage } from "@/components/email-list/types";
import { getEmailMessageCellLabels } from "@/components/EmailMessageCellLabels";
import { LoadingContent } from "@/components/LoadingContent";
import { getSWRFetchErrorMessage } from "@/providers/swr-error";
import { Button } from "@/components/ui/button";
import type { EmailLabels } from "@/providers/email-label-types";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useHiddenDraftMessageIds } from "@/hooks/useHiddenDraftMessageIds";
import {
  extractEmailAddress,
  extractNameFromEmail,
  isSameEmailAddress,
} from "@/utils/email";
import { GmailLabel } from "@/utils/gmail/label";
import { PublisherDiscussion } from "@/components/team-comments/PublisherDiscussion";
import type { OutgoingThreadMessage } from "@/utils/mail-engine/conversation-thread";

const SenderContextPanel = dynamic(
  () =>
    import("@/app/(app)/[emailAccountId]/mail/SenderContextPanel").then(
      (module) => module.SenderContextPanel,
    ),
  { ssr: false },
);

/**
 * Below this the reader would be squeezed too far by a pane beside it, so the
 * sender profile slides over the reader instead.
 */
const INLINE_SIDE_PANEL_MIN_WIDTH = 880;

export type ThreadReaderProps = {
  enableMessageNavigation: boolean;
  /** The row that is open. It may lag behind the selected thread while loading. */
  thread: ListThread | null;
  /** The selected thread, including while its row and messages are loading. */
  threadId: string | null;
  /** Whether the deferred detail selection has caught up to the open row. */
  detailSelectionSettled: boolean;
  loading: boolean;
  error?: ComponentProps<typeof LoadingContent>["error"];
  /**
   * Messages currently available to the reader, including partial local pages.
   */
  messages: ThreadMessage[];
  localAvailability?: {
    missingBodyIds: Set<string>;
    outgoing: OutgoingThreadMessage[];
    sendOperationIds: Map<string, string>;
    hasMore: boolean;
    loadingMore: boolean;
    loadMore: () => unknown;
  };
  userLabels: EmailLabels;
  layout: MailLayoutMode;
  labelHref: (labelId: string) => string;
  onRemoveLabel?: (labelId: string) => void;
  onBackToInbox: () => void;
  onArchive: () => void;
  onMoveToInbox?: () => void;
  onRestore?: () => void;
  onNotSpam?: () => void;
  onSnooze?: (until: Date) => void;
  isUnread: boolean;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  /** Refreshes the open thread after a reply is sent or a draft changes. */
  refetch: () => void;
  /** Opens a different provider thread when a sent message starts one. */
  onSendSuccess?: (
    messageId: string,
    sentThreadId: string,
    repliedThreadId: string,
  ) => void;
  /**
   * Set by the reply action. Left unset the composer still opens on its own for
   * a message that already has an AI draft.
   */
  autoOpenReplyForMessageId?: string;
  autoOpenReplyAll?: boolean;
  autoOpenForwardForMessageId?: string;
  /**
   * Opens the assistant on this conversation. Unset when the assistant belongs
   * to another account than the thread, as in All inboxes.
   */
  onAskCue?: () => void;
  /** The ⋯ dropdown, i.e. `ThreadActionsMenu`, composed by the shell. */
  menu?: ReactNode;
  renderMessageMenu?: (message: ThreadMessage) => ReactNode;
};

export function ThreadReader({
  enableMessageNavigation,
  thread,
  threadId,
  detailSelectionSettled,
  loading,
  error,
  messages,
  localAvailability,
  userLabels,
  layout,
  labelHref,
  onRemoveLabel,
  onBackToInbox,
  onArchive,
  onMoveToInbox,
  onRestore,
  onNotSpam,
  onSnooze,
  isUnread,
  onMarkRead,
  onMarkUnread,
  refetch,
  onSendSuccess,
  autoOpenReplyForMessageId,
  autoOpenReplyAll,
  autoOpenForwardForMessageId,
  onAskCue,
  menu,
  renderMessageMenu,
}: ThreadReaderProps) {
  const receivedMessages = messages.filter(
    (message) => !message.labelIds?.includes(GmailLabel.DRAFT),
  );
  const lastReceived = receivedMessages.at(-1);
  const lastReceivedId = lastReceived?.id;
  const [senderContext, setSenderContext] = useState<{
    messageId: string;
    senderEmail: string;
    senderName: string;
  } | null>(null);
  // Reported by the thread view once it has mounted; until then the toolbar
  // has no expand/collapse-all control.
  const [messageExpansion, setMessageExpansion] =
    useState<MessageExpansionControls>();
  const [readerRef, readerWidth] = useElementWidth();
  const isNarrow = readerWidth < INLINE_SIDE_PANEL_MIN_WIDTH;
  const { emailAccountId, userEmail, accountIds } = useAccount();
  // Related items help answer the newest message, so they show only while
  // it's someone else's: not once the user's reply, sent or sending, is newest.
  const newestIsIncoming =
    Boolean(lastReceived) &&
    !lastReceived?.labelIds?.includes(GmailLabel.SENT) &&
    !isSameEmailAddress(
      extractEmailAddress(lastReceived?.headers.from ?? ""),
      userEmail,
    ) &&
    !localAvailability?.outgoing.length;
  const { updateLocation } = useMailRoute();
  const openThread = (id: string) =>
    updateLocation((current) => {
      const threadAccountIndex = accountIds.indexOf(emailAccountId);
      return {
        ...current,
        threadId: id,
        threadAccountIndex:
          current.allInboxes && threadAccountIndex >= 0
            ? threadAccountIndex
            : null,
      };
    });
  // Waits for keyboard navigation to settle before fetching.
  const canAssist = Boolean(
    detailSelectionSettled && emailAccountId && threadId,
  );
  const { assist, replyStatus, reply } = useReaderReplySuggestion({
    emailAccountId,
    threadId,
    messages,
    userLabels,
    enabled: canAssist,
    onOpenThread: openThread,
  });
  // The strip's Draft reply opens the composer once Cue's suggestion settles:
  // filled when every fact in it is backed, empty with a reason otherwise.
  const [draftRequestedFor, setDraftRequestedFor] = useState<string>();
  const stripReplyFor =
    draftRequestedFor && draftRequestedFor === reply.settledFor
      ? draftRequestedFor
      : undefined;
  const requestDraftReply = () => {
    setDraftRequestedFor(lastReceivedId);
    reply.request();
  };
  const hiddenDraftMessageIds = useHiddenDraftMessageIds(emailAccountId);
  const headerMessage =
    latestShownMessage(thread?.messages ?? [], hiddenDraftMessageIds) ??
    latestShownMessage(messages, hiddenDraftMessageIds) ??
    thread?.messages.at(-1) ??
    messages.at(-1);
  const translation = useThreadTranslation(
    emailAccountId,
    headerMessage?.threadId,
  );
  const translatedSubject = translation?.showOriginal
    ? undefined
    : translation?.subject;

  if (error || (!headerMessage && !localAvailability)) {
    return (
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center"
        data-detail-selection-settled={detailSelectionSettled}
        data-testid="thread-reader"
      >
        <LoadingContent
          error={error}
          loading={loading}
          errorComponent={<ThreadReaderError error={error} onRetry={refetch} />}
          loadingComponent={
            <div role="status">
              <LoadingEmail />
            </div>
          }
        >
          <MailIcon className="size-6 text-muted-foreground" />
          <div className="text-foreground text-sm">Nothing selected</div>
          <div className="text-muted-foreground text-xs">
            Pick another view, or head back to the inbox.
          </div>
        </LoadingContent>
      </div>
    );
  }

  // Beside the list, the list's view name is the page's h1, so the subject is
  // an h2; its messages, and what sits inside them, follow one level down.
  const subjectHeadingLevel = layout === "split" ? 2 : 1;

  const labels =
    getEmailMessageCellLabels({
      labelIds: headerMessage?.labelIds,
      userLabels,
    }) ?? [];

  // Drawn outside the lazily loaded thread view, in the same place with or
  // without messages, so it never remounts: an open menu stays open and a
  // click is never lost while the thread view's code arrives.
  const toolbar = (
    <>
      <ReaderToolbar
        isStarred={isThreadStarred(
          thread?.messages.length ? thread.messages : messages,
        )}
        isUnread={isUnread}
        messageExpansion={messages.length > 0 ? messageExpansion : undefined}
        labelHref={labelHref}
        labels={labels}
        menu={menu}
        extraAction={
          emailAccountId && threadId && lastReceivedId ? (
            <AddToCalendarButton
              emailAccountId={emailAccountId}
              messageId={lastReceivedId}
              subject={headerMessage?.headers.subject ?? ""}
              threadId={threadId}
            />
          ) : null
        }
        onArchive={onArchive}
        onMoveToInbox={onMoveToInbox}
        onRestore={onRestore}
        onNotSpam={onNotSpam}
        onSnooze={onSnooze}
        onMarkRead={onMarkRead}
        onMarkUnread={onMarkUnread}
        onBackToInbox={onBackToInbox}
        onRemoveLabel={onRemoveLabel}
        subject={
          translatedSubject ?? headerMessage?.headers.subject ?? "Conversation"
        }
        subjectHeadingLevel={subjectHeadingLevel}
      />
      {emailAccountId && threadId && lastReceived ? (
        <CueStrip
          // What it held space for and loaded belongs to one thread.
          key={`${emailAccountId}:${threadId}`}
          emailAccountId={emailAccountId}
          enabled={canAssist}
          messages={receivedMessages}
          onAskCue={onAskCue}
          onDraftReply={requestDraftReply}
          reply={reply}
          newestIsIncoming={newestIsIncoming}
          threadId={threadId}
          userLabels={userLabels}
        />
      ) : null}
    </>
  );

  return (
    <MailReaderSurface
      containerRef={readerRef}
      detailSelectionSettled={detailSelectionSettled}
      layout={layout}
      // Once messages show, the thread's own earlier-messages row loads more.
      localAvailability={messages.length > 0 ? undefined : localAvailability}
      renderLoadMoreButton={({ disabled, loading, onClick }) => (
        <Button
          className="mb-4"
          disabled={disabled}
          onClick={onClick}
          variant="outline"
        >
          {loading ? "Loading earlier messages…" : "Show earlier messages"}
        </Button>
      )}
      sidePanel={
        senderContext ? (
          <SenderContextPanel
            messageId={senderContext.messageId}
            onClose={() => setSenderContext(null)}
            senderEmail={senderContext.senderEmail}
            senderName={senderContext.senderName}
            variant={isNarrow ? "sheet" : "inline"}
          />
        ) : null
      }
    >
      {toolbar}
      {messages.length > 0 ? (
        <ReplyAssistContext.Provider value={assist}>
          {/* MailShell preloads the thread view, so this rarely shows. Only
              the messages wait for it; the marker keeps BufferedThreadReader
              on the previous thread. */}
          <Suspense
            fallback={
              <div
                className="flex flex-1 items-center justify-center py-16"
                data-thread-view-loading
                role="status"
              >
                <LoadingEmail />
              </div>
            }
          >
            <EmailThreadLazy
              messageHeadingLevel={subjectHeadingLevel === 2 ? 3 : 2}
              onMessageExpansionChange={setMessageExpansion}
              renderMessageMenu={renderMessageMenu}
              enableMessageNavigation={enableMessageNavigation}
              autoOpenReplyForMessageId={
                autoOpenReplyForMessageId ?? stripReplyFor ?? assist?.messageId
              }
              focusAutoOpenedReply={Boolean(
                autoOpenReplyForMessageId ?? stripReplyFor,
              )}
              afterLatestMessage={
                canAssist && newestIsIncoming && emailAccountId && threadId ? (
                  <div className="mt-4 -mx-2">
                    <ThreadContextList
                      emailAccountId={emailAccountId}
                      heading="Related"
                      // Inside the newest message, under its heading.
                      headingLevel={subjectHeadingLevel === 2 ? 4 : 3}
                      limit={2}
                      onOpenThread={openThread}
                      threadId={threadId}
                    />
                  </div>
                ) : null
              }
              replyStatus={replyStatus}
              earlierMessages={
                localAvailability?.hasMore
                  ? {
                      loading: localAvailability.loadingMore,
                      onLoad: localAvailability.loadMore,
                    }
                  : undefined
              }
              autoOpenReplyAll={autoOpenReplyAll}
              autoOpenForwardForMessageId={autoOpenForwardForMessageId}
              key={threadId}
              messages={messages}
              missingBodyIds={localAvailability?.missingBodyIds}
              outgoing={localAvailability?.outgoing}
              sendOperationIds={localAvailability?.sendOperationIds}
              onMarkDone={onArchive}
              onOpenSenderContext={(message) => {
                const senderEmail = extractEmailAddress(message.headers.from);
                setSenderContext({
                  messageId: message.id,
                  senderEmail,
                  senderName:
                    extractNameFromEmail(message.headers.from) || senderEmail,
                });
              }}
              refetch={refetch}
              onSendSuccess={onSendSuccess}
              onThreadDiscarded={
                // A partially loaded conversation can look draft-only, so only
                // leave once every message is here to say it is.
                localAvailability?.hasMore ? undefined : onBackToInbox
              }
              showReplyButton
            />
          </Suspense>
        </ReplyAssistContext.Provider>
      ) : null}
      {emailAccountId && threadId && messages.length > 0 && (
        <PublisherDiscussion
          key={`${emailAccountId}:${threadId}`}
          emailAccountId={emailAccountId}
          threadId={threadId}
        />
      )}
    </MailReaderSurface>
  );
}

/**
 * A polite status rather than a labelled icon: an SVG's aria-label is neither
 * announced nor reliably exposed, and focus stays wherever the user left it.
 */
function LoadingEmail() {
  return (
    <>
      <Loader2Icon
        aria-hidden
        className="size-6 animate-spin text-muted-foreground"
      />
      <span className="sr-only">Loading email</span>
    </>
  );
}

/**
 * Loading a thread can fail for reasons the reader can recover from, such as a
 * message that the provider has not made readable yet, so this offers a retry
 * instead of the generic app-wide error screen.
 */
function ThreadReaderError({
  error,
  onRetry,
}: {
  error: ThreadReaderProps["error"];
  onRetry: () => void;
}) {
  return (
    <>
      <AlertCircleIcon className="size-6 text-muted-foreground" />
      <div className="text-foreground text-sm">
        Couldn't open this conversation
      </div>
      <div className="text-muted-foreground text-xs">
        {getSWRFetchErrorMessage(error?.info)}
      </div>
      <Button className="mt-2" onClick={onRetry} size="sm" variant="outline">
        Try again
      </Button>
    </>
  );
}

/**
 * A callback ref rather than an effect: the reader mounts its measured element
 * only once a thread is open, after the loading branch has come and gone.
 */
function useElementWidth() {
  const [width, setWidth] = useState(0);
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

// A draft that a pending send stands in for isn't shown, so it doesn't title
// the thread either.
function latestShownMessage<T extends { id: string }>(
  messages: T[],
  hiddenDraftMessageIds: string[],
) {
  return messages.findLast(
    (message) => !hiddenDraftMessageIds.includes(message.id),
  );
}
