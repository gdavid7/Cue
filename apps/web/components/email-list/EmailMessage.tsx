import { CalendarInvitation } from "@/components/email-list/CalendarInvitation";
import { isCalendarInvitationMessage } from "@/utils/calendar/invitations/detection";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
  useRef,
  useEffect,
} from "react";
import { ReplyAssistContext } from "@/components/email-list/reply-assist";
import { useAction } from "next-safe-action/hooks";
import {
  ForwardIcon,
  ReplyAllIcon,
  ReplyIcon,
  ChevronsUpDownIcon,
  ChevronsDownUpIcon,
  UserSearchIcon,
} from "lucide-react";
import { Tooltip } from "@/components/Tooltip";
import {
  extractEmailAddress,
  extractNameFromEmail,
  formatRecipientNames,
  getInitials,
  isSameEmailAddress,
  splitRecipientList,
} from "@/utils/email";
import { formatShortDate } from "@/utils/date";
import { ComposeEmailFormLazy } from "@/app/(app)/[emailAccountId]/compose/ComposeEmailFormLazy";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { ParsedMessage } from "@/utils/types";
import { forwardEmailHtml, forwardEmailSubject } from "@/utils/gmail/forward";
import { extractDraftComposerContent } from "@/utils/parse/extract-reply.client";
import type { ReplyingToEmail } from "@/app/(app)/[emailAccountId]/compose/ComposeEmailForm";
import { createReplyContent } from "@/utils/gmail/reply";
import { cn } from "@/utils";
import { decodeSnippet } from "@/utils/gmail/decode";
import { GmailLabel } from "@/utils/gmail/label";
import { deleteDraftAction } from "@/utils/actions/mail";
import type { ThreadMessage } from "@/components/email-list/types";
import { EmailDetails } from "@/components/email-list/EmailDetails";
import { HtmlEmail, PlainEmail } from "@/components/email-list/EmailContents";
import { EmailAttachments } from "@/components/email-list/EmailAttachments";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useComposeModal } from "@/providers/ComposeModalProvider";
import { formatReplySubject } from "@/utils/email/subject";
import {
  buildComposeReplyRecipients,
  hasReplyAllRecipients,
} from "@/utils/email/reply-all";
import { isTypingTarget } from "@/lib/shortcuts/registry";
import { useContactPhoto } from "@/hooks/useContactPhoto";
import { toastError } from "@/components/Toast";
import { LoadingMiniSpinner } from "@/components/Loading";
import { getActionErrorMessage } from "@/utils/error";
import {
  getDraftSessionMessageId,
  getReplyDraftSessionId,
  type ReplyDraftMode,
} from "@/utils/mail-engine/reply-drafts";
import {
  SentMessageOpenStatus,
  type SentMessageOpenState,
} from "@/components/email-list/SentMessageOpenStatus";
import {
  getMessageTranslation,
  useThreadTranslation,
  useTranslateThread,
} from "@/app/(app)/[emailAccountId]/mail/use-thread-translation";

type ComposeSession = { id: number; mode: ReplyDraftMode };

export function EmailMessage({
  message,
  bodyAvailable = true,
  missingBodyIds,
  menu,
  afterBody,
  refetch,
  showReplyButton,
  defaultComposeMode,
  defaultReplyAll = false,
  composerOpen = true,
  openDraftSessionId,
  dismissedDraftIds: dismissedDraftIdsProp,
  onDraftDismissedChange,
  onOpenDraft,
  onComposerClosed,
  localDraftSnippet,
  onStartCompose,
  draftMessages,
  expanded,
  onToggle,
  onExpand,
  onSendSuccess,
  onMarkDone,
  onDraftDiscarded,
  onOpenSenderContext,
  hasDraft = false,
  selected,
  onSelect,
  onNavigateMessage,
  sentMessageOpen,
  replyAnchor,
  composerSessionMessageId,
  onReplySent,
  focusComposer = false,
}: {
  message: ThreadMessage;
  bodyAvailable?: boolean;
  missingBodyIds?: Set<string>;
  menu?: React.ReactNode;
  /** Shown under the body, above any draft or reply. */
  afterBody?: React.ReactNode;
  draftMessages?: ThreadMessage[];
  refetch: () => void;
  showReplyButton: boolean;
  defaultComposeMode?: ReplyDraftMode;
  /** Opens a default reply addressed to everyone on the message. */
  defaultReplyAll?: boolean;
  /** Whether the thread's one open composer is this message's reply or forward. */
  composerOpen?: boolean;
  /** The thread's open mailbox draft, by session id, if that is what's open. */
  openDraftSessionId?: string;
  /** Left unset, the message keeps its own: it is the only one open. */
  dismissedDraftIds?: ReadonlySet<string>;
  onDraftDismissedChange?: (
    sessionMessageId: string,
    dismissed: boolean,
  ) => void;
  /** Left unset, the message's newest draft is open unless it is composing. */
  onOpenDraft?: (sessionMessageId: string) => void;
  onComposerClosed?: () => void;
  /** The text of this message's unsent local reply, shown while it is collapsed. */
  localDraftSnippet?: string;
  onStartCompose?: () => void;
  expanded: boolean;
  /** Absent when the thread has a single message, which never collapses. */
  onToggle?: () => void;
  /**
   * Keeps the message open once a composer opens in it. Otherwise a newer
   * message arriving would collapse it and hide the reply being written.
   */
  onExpand?: () => void;
  onSendSuccess: (messageId: string, threadId: string) => void;
  onMarkDone?: () => void;
  /**
   * A saved draft shown in this message was discarded. Only wired up by
   * parents for which that discard empties the conversation.
   */
  onDraftDiscarded?: () => void;
  onOpenSenderContext?: (message: ThreadMessage) => void;
  hasDraft?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onNavigateMessage?: (direction: -1 | 1) => void;
  sentMessageOpen?: SentMessageOpenState;
  /** For a reply the provider hasn't sent yet: the message replies thread on. */
  replyAnchor?: ThreadMessage;
  /** Keeps a composer's draft when this message's id changes under it. */
  composerSessionMessageId?: string;
  /** A reply or forward from this message just left its composer. */
  onReplySent?: () => void;
  /**
   * The user asked for the composer the thread opened here, so it takes focus.
   * One that opens on its own, such as a saved draft, leaves focus alone.
   */
  focusComposer?: boolean;
}) {
  const { emailAccountId } = useAccount();
  const { poppedOutDraftSessionId } = useComposeModal();
  const [replyAllOverride, setReplyAllOverride] = useState<boolean | null>(
    null,
  );
  // A new request from the reader (`r` or `a`) outranks the last button press.
  const [requestedReplyAll, setRequestedReplyAll] = useState(defaultReplyAll);
  if (requestedReplyAll !== defaultReplyAll) {
    setRequestedReplyAll(defaultReplyAll);
    setReplyAllOverride(null);
  }
  const replyAll = replyAllOverride ?? defaultReplyAll;
  const threadTranslation = useThreadTranslation(
    emailAccountId,
    message.threadId,
  );
  const translation = getMessageTranslation(threadTranslation, message.id);
  const showTranslation = Boolean(translation && !translation.showOriginal);
  // `null` follows `defaultComposeMode`, which the reader's Reply button flips
  // long after this message mounted.
  const [composeOverride, setComposeOverride] = useState<
    ReplyDraftMode | "closed" | null
  >(null);
  const requestedComposeMode = resolveComposeMode(
    composeOverride,
    defaultComposeMode,
    (mode) =>
      getReplyDraftSessionId(composerSessionMessageId ?? message.id, mode) ===
      poppedOutDraftSessionId,
  );
  const composeMode = composerOpen ? requestedComposeMode : undefined;
  const serverDrafts = (draftMessages ?? []).map((draft) => ({
    message: draft,
    sessionMessageId: getDraftSessionMessageId(emailAccountId, draft.id),
  }));
  const [ownDismissedDraftIds, setOwnDismissedDraftIds] = useState(
    () => new Set<string>(),
  );
  const setOwnDraftDismissed = useCallback(
    (sessionMessageId: string, dismissed: boolean) => {
      setOwnDismissedDraftIds((previous) => {
        if (previous.has(sessionMessageId) === dismissed) return previous;
        const next = new Set(previous);
        if (dismissed) next.add(sessionMessageId);
        else next.delete(sessionMessageId);
        return next;
      });
    },
    [],
  );
  const dismissedDraftIds = dismissedDraftIdsProp ?? ownDismissedDraftIds;
  const setDraftDismissed = onDraftDismissedChange ?? setOwnDraftDismissed;
  const visibleDrafts = serverDrafts.filter(
    (draft) =>
      !dismissedDraftIds.has(draft.sessionMessageId) &&
      getReplyDraftSessionId(draft.sessionMessageId, "reply") !==
        poppedOutDraftSessionId,
  );
  const composingMailboxReply =
    composeMode === "reply" && visibleDrafts.length > 0;
  // A reply on a message with a saved draft continues that draft.
  const openDraft =
    visibleDrafts.find(
      (draft) => draft.sessionMessageId === openDraftSessionId,
    ) ??
    (composingMailboxReply || (!onOpenDraft && !composeMode)
      ? visibleDrafts.at(-1)
      : undefined);
  const isDraftRow = serverDrafts.some(
    (draft) => draft.message.id === message.id,
  );
  const hasOpenComposer = Boolean(composeMode) || Boolean(openDraft);
  // Set only by the user's own Reply or Forward in this message.
  const takeFocus =
    focusComposer || (composeOverride !== null && composeOverride !== "closed");
  const showLocalDraftRow =
    !composerOpen &&
    Boolean(requestedComposeMode) &&
    localDraftSnippet !== undefined;

  const [showDetails, setShowDetails] = useState(false);
  const composeSessionRef = useRef(0);
  const messageRef = useRef<HTMLLIElement>(null);

  const startReply = useCallback(() => {
    onStartCompose?.();
    composeSessionRef.current += 1;
    const savedDraft = serverDrafts.at(-1);
    if (savedDraft) {
      setDraftDismissed(savedDraft.sessionMessageId, false);
      requestAnimationFrame(() => {
        messageRef.current
          ?.querySelector<HTMLElement>("[data-email-editor-content]")
          ?.focus();
      });
    }
    setComposeOverride("reply");
    onExpand?.();
  }, [onExpand, onStartCompose, serverDrafts, setDraftDismissed]);
  const onReply = useCallback(() => {
    setReplyAllOverride(false);
    startReply();
  }, [startReply]);
  const onReplyAll = useCallback(() => {
    setReplyAllOverride(true);
    startReply();
  }, [startReply]);
  const onForward = useCallback(() => {
    onStartCompose?.();
    composeSessionRef.current += 1;
    setComposeOverride("forward");
    onExpand?.();
  }, [onExpand, onStartCompose]);

  const onCloseCompose = useCallback(() => {
    setComposeOverride("closed");
    onComposerClosed?.();
  }, [onComposerClosed]);
  const closeMailboxDraft = (sessionMessageId: string) => {
    if (composeMode === "reply") onCloseCompose();
    setDraftDismissed(sessionMessageId, true);
  };
  const [composerKey, setComposerKey] = useState(0);
  const undoSendSessionRef = useRef<ComposeSession | null>(null);

  const onStartDiscard = useCallback((): ComposeSession | undefined => {
    if (!composeMode) return;
    const composeSession = {
      id: composeSessionRef.current,
      mode: composeMode,
    };
    onCloseCompose();
    return composeSession;
  }, [composeMode, onCloseCompose]);

  const onRestoreCompose = useCallback(
    (composeSession: ComposeSession) => {
      if (composeSessionRef.current !== composeSession.id) return;
      composeSessionRef.current += 1;
      onStartCompose?.();
      setComposeOverride(composeSession.mode);
    },
    [onStartCompose],
  );
  const onCloseComposeAfterSend = useCallback(() => {
    if (composeMode) {
      undoSendSessionRef.current = {
        id: composeSessionRef.current,
        mode: composeMode,
      };
    }
    onCloseCompose();
  }, [composeMode, onCloseCompose]);
  const onRestoreComposeAfterSend = useCallback(() => {
    const session = undoSendSessionRef.current;
    if (!session) return;
    composeSessionRef.current += 1;
    setComposerKey((key) => key + 1);
    onStartCompose?.();
    setComposeOverride(session.mode);
  }, [onStartCompose]);

  const toggleDetails = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDetails((prev) => !prev);
  }, []);

  const onMessageKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (
        event.target !== event.currentTarget ||
        (event.key !== "Enter" && event.key !== " ")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter" && expanded && showReplyButton) {
        onReply();
      } else {
        onToggle?.();
      }
    },
    [expanded, onReply, onToggle, showReplyButton],
  );

  // A conversation that is only drafts shows each one as a draft row.
  const collapsedDraftOnlyRow = visibleDrafts.find(
    (draft) => draft.message.id === message.id && draft !== openDraft,
  );
  if (collapsedDraftOnlyRow) {
    return (
      <li className="px-2 sm:px-5" data-thread-message-id={message.id}>
        <CollapsedDraft
          onOpen={() => onOpenDraft?.(collapsedDraftOnlyRow.sessionMessageId)}
          snippet={draftSnippet(collapsedDraftOnlyRow.message)}
        />
      </li>
    );
  }

  return (
    <li
      ref={messageRef}
      data-thread-message-id={message.id}
      data-selected={selected}
      tabIndex={selected !== undefined || hasOpenComposer ? -1 : undefined}
      aria-current={selected || undefined}
      onFocusCapture={onSelect}
      onClickCapture={onSelect}
      onKeyDown={onMessageKeyDown}
      onKeyDownCapture={(event) => {
        // Handle draft Escape before the rich-text editor consumes it.
        if (
          hasOpenComposer &&
          event.key === "Escape" &&
          !event.defaultPrevented &&
          isTypingTarget(event.target) &&
          event.target instanceof Element &&
          event.target.closest('[data-inline-reply="true"]') &&
          !event.target.closest(
            '[role="dialog"], [role="menu"], [role="listbox"], [role="combobox"][aria-expanded="true"]',
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
      className={cn(
        "group/message min-w-0 border-l-2 border-transparent outline-none transition-colors focus-within:border-primary",
        selected && "border-primary",
        expanded
          ? "my-2 px-2 py-3 sm:px-5"
          : "px-2 py-1.5 hover:bg-muted/40 sm:px-5",
      )}
    >
      <MessageHeader
        expanded={expanded}
        message={message}
        menu={menu}
        onForward={onForward}
        onOpenSenderContext={onOpenSenderContext}
        onReply={onReply}
        onReplyAll={onReplyAll}
        onToggle={onToggle}
        onToggleKeyDown={onMessageKeyDown}
        showDetails={showDetails}
        showReplyButton={showReplyButton}
        toggleDetails={toggleDetails}
        hasDraft={hasDraft || visibleDrafts.length > 0}
        sentMessageOpen={sentMessageOpen}
      />

      {expanded && (
        // Aligns the body with the sender's name rather than the avatar.
        <div className="min-w-0 pt-3 sm:pl-9">
          {showDetails && <EmailDetails message={message} />}

          {isCalendarInvitationMessage(message) && (
            <CalendarInvitation key={message.id} messageId={message.id} />
          )}

          {!bodyAvailable && !isDraftRow && composeMode !== "forward" && (
            <MessageBodyLoading />
          )}
          {!isDraftRow && threadTranslation?.loading && (
            <p className="mb-3 flex items-center gap-1.5 text-muted-foreground text-xs">
              <LoadingMiniSpinner />
              Translating…
            </p>
          )}
          {!isDraftRow && translation && (
            <TranslationNotice
              languageName={translation.languageName}
              showOriginal={translation.showOriginal}
              messageId={message.id}
              threadId={message.threadId}
            />
          )}
          {bodyAvailable && !isDraftRow && showTranslation && translation && (
            <PlainEmail text={translation.text} />
          )}
          {bodyAvailable &&
            !isDraftRow &&
            !showTranslation &&
            (message.textHtml ? (
              <HtmlEmail
                onForwardMessage={showReplyButton ? onForward : undefined}
                onReplyMessage={showReplyButton ? onReply : undefined}
                onNavigateMessage={onNavigateMessage}
                onFocusMessage={onSelect}
                emailAccountId={emailAccountId}
                html={message.textHtml}
                inlineAttachments={message.inline}
                messageId={message.id}
              />
            ) : (
              <PlainEmail text={message.textPlain || ""} />
            ))}

          {message.attachments && <EmailAttachments message={message} />}
          {afterBody}

          {visibleDrafts.map(({ message: draft, sessionMessageId }) =>
            draft === openDraft?.message ? (
              <div
                className="fade-in slide-in-from-top-1 animate-in duration-300"
                key={sessionMessageId}
              >
                <ReplyPanel
                  autoFocus={takeFocus}
                  autoScroll={!composeMode}
                  draftBodyAvailable={!missingBodyIds?.has(draft.id)}
                  draftMessage={draft}
                  draftSessionMessageId={sessionMessageId}
                  message={message}
                  onCloseCompose={() => closeMailboxDraft(sessionMessageId)}
                  onRestoreCompose={() =>
                    setDraftDismissed(sessionMessageId, false)
                  }
                  onRestore={() => {
                    onOpenDraft?.(sessionMessageId);
                    setDraftDismissed(sessionMessageId, false);
                  }}
                  onSendSuccess={onSendSuccess}
                  onSent={onReplySent}
                  onMarkDone={onMarkDone}
                  onDraftDiscarded={onDraftDiscarded}
                  onStartDiscard={() => {
                    closeMailboxDraft(sessionMessageId);
                    return {
                      id: composeSessionRef.current,
                      mode: "reply" as const,
                    };
                  }}
                  refetch={refetch}
                  composeMode="reply"
                />
              </div>
            ) : (
              !isDraftRow && (
                <CollapsedDraft
                  key={sessionMessageId}
                  onOpen={() => onOpenDraft?.(sessionMessageId)}
                  snippet={draftSnippet(draft)}
                />
              )
            ),
          )}
          {showLocalDraftRow && (
            <CollapsedDraft
              onOpen={() => onStartCompose?.()}
              snippet={localDraftSnippet ?? ""}
            />
          )}
          {composeMode && !composingMailboxReply && (
            <div className="fade-in slide-in-from-top-1 animate-in duration-300">
              <ReplyPanel
                // Remounts so the composer picks up the other recipients.
                key={`${composerKey}:${replyAll}`}
                autoFocus={takeFocus}
                replyAll={replyAll}
                autoScroll
                bodyAvailable={bodyAvailable}
                draftSessionMessageId={composerSessionMessageId}
                message={message}
                replyAnchor={replyAnchor}
                onCloseCompose={onCloseComposeAfterSend}
                onRestore={onRestoreComposeAfterSend}
                onRestoreCompose={onRestoreCompose}
                onSendSuccess={onSendSuccess}
                onSent={onReplySent}
                onMarkDone={onMarkDone}
                onStartDiscard={onStartDiscard}
                refetch={refetch}
                composeMode={composeMode}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * A draft that isn't the one being written: its label and first line, the way
 * Gmail shows a conversation's other drafts. Opening it closes the open one.
 */
function CollapsedDraft({
  snippet,
  onOpen,
}: {
  snippet: string;
  onOpen: () => void;
}) {
  return (
    <button
      className="mt-3 flex w-full min-w-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40 active:bg-muted"
      data-testid="collapsed-draft"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      type="button"
    >
      <span className="shrink-0 font-medium text-red-600 dark:text-red-400">
        Draft
      </span>
      <span className="min-w-0 truncate text-muted-foreground">
        {snippet || "(no text)"}
      </span>
    </button>
  );
}

function draftSnippet(draft: ParsedMessage) {
  return (
    decodeSnippet(draft.snippet) ||
    (draft.textPlain ?? "").replace(/\s+/g, " ").trim()
  );
}

/**
 * One row per message, and the whole thread's rhythm: an avatar, who sent it,
 * and when. Collapsed it also carries the snippet, so a thread reads top to
 * bottom without opening every message.
 */
function MessageHeader({
  message,
  menu,
  expanded,
  showDetails,
  toggleDetails,
  showReplyButton,
  onReply,
  onReplyAll,
  onForward,
  onOpenSenderContext,
  onToggle,
  onToggleKeyDown,
  hasDraft,
  sentMessageOpen,
}: {
  message: ParsedMessage;
  menu?: React.ReactNode;
  expanded: boolean;
  showDetails: boolean;
  toggleDetails: (e: React.MouseEvent) => void;
  showReplyButton: boolean;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onOpenSenderContext?: (message: ThreadMessage) => void;
  onToggle?: () => void;
  onToggleKeyDown: React.KeyboardEventHandler<HTMLElement>;
  hasDraft: boolean;
  sentMessageOpen?: SentMessageOpenState;
}) {
  const { emailAccount, emailAccountId, userEmail } = useAccount();

  const isSent = message.labelIds?.includes(GmailLabel.SENT) ?? false;
  const canReplyAll =
    !isSent && hasReplyAllRecipients(message.headers, userEmail);
  const senderEmail = extractEmailAddress(message.headers.from);
  const senderName = isSent
    ? "Me"
    : extractNameFromEmail(message.headers.from) || senderEmail;
  const contactPhoto = useContactPhoto({
    email: expanded && !isSent ? senderEmail : null,
    emailAccountId,
  });
  const senderImage = isSent ? emailAccount?.image : contactPhoto;
  const canResearchSender =
    Boolean(onOpenSenderContext) &&
    !isSent &&
    Boolean(senderEmail) &&
    !isSameEmailAddress(senderEmail, userEmail);

  // Collapsing is the thread's call, so a row is only interactive once it has
  // been handed a toggle.
  const toggleProps: React.ComponentProps<"div"> | undefined = onToggle && {
    "aria-expanded": expanded,
    onClick: onToggle,
    onKeyDown: onToggleKeyDown,
    role: "button",
    tabIndex: 0,
  };

  const compose = (open: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    open();
  };

  const avatar = (
    <Avatar aria-hidden className="size-7 shrink-0">
      <AvatarImage alt="" src={senderImage || undefined} />
      <AvatarFallback
        className={cn(
          "font-semibold text-[10px] tracking-wide",
          isSent
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground",
        )}
      >
        {getInitials(senderName)}
      </AvatarFallback>
    </Avatar>
  );
  // Fixed widths on the collapsed rows keep the snippet column aligned down
  // the thread.
  const senderNameClassName = cn(
    "truncate text-sm",
    expanded
      ? "max-w-40 shrink font-semibold text-foreground"
      : "w-24 shrink-0 font-medium text-secondary-foreground sm:w-28",
  );

  return (
    <div
      {...toggleProps}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
        onToggle && "cursor-pointer",
      )}
    >
      {expanded ? (
        <>
          <button
            aria-expanded={showDetails}
            aria-label={showDetails ? "Hide details" : "Show details"}
            className="group/details flex min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={toggleDetails}
            type="button"
          >
            {avatar}
            <span className={senderNameClassName}>{senderName}</span>
            <span className="hidden min-w-0 truncate text-muted-foreground text-xs sm:block">
              {recipientSummary(message.headers, userEmail)}
            </span>
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors group-hover/details:bg-muted group-hover/details:text-foreground">
              {showDetails ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </span>
          </button>
          {canResearchSender && (
            <Tooltip content="View public profile">
              <Button
                aria-label={`View public profile for ${senderName}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenSenderContext?.(message);
                }}
                size="iconXs"
                variant="ghostMuted"
              >
                <UserSearchIcon className="size-3.5" />
              </Button>
            </Tooltip>
          )}
        </>
      ) : (
        <>
          {avatar}
          <span className={senderNameClassName}>{senderName}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
            {decodeSnippet(message.snippet)}
          </span>
        </>
      )}

      {hasDraft &&
        (!expanded || message.labelIds?.includes(GmailLabel.DRAFT)) && (
          <span className="shrink-0 text-red-600 text-xs dark:text-red-400">
            Draft
          </span>
        )}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {(showReplyButton || menu) && (
          <span className="flex shrink-0 items-center transition-opacity focus-within:opacity-100 group-hover/message:opacity-100 has-[[data-state=open]]:opacity-100 sm:opacity-0">
            {showReplyButton && (
              <>
                <Tooltip shortcuts={["reply"]}>
                  <Button
                    onClick={compose(onReply)}
                    size="iconXs"
                    variant="ghostMuted"
                  >
                    <ReplyIcon className="size-3.5" />
                    <span className="sr-only">Reply</span>
                  </Button>
                </Tooltip>
                {canReplyAll && (
                  <Tooltip shortcuts={["replyAll"]}>
                    <Button
                      onClick={compose(onReplyAll)}
                      size="iconXs"
                      variant="ghostMuted"
                    >
                      <ReplyAllIcon className="size-3.5" />
                      <span className="sr-only">Reply all</span>
                    </Button>
                  </Tooltip>
                )}
                <Tooltip shortcuts={["forward"]}>
                  <Button
                    onClick={compose(onForward)}
                    size="iconXs"
                    variant="ghostMuted"
                  >
                    <ForwardIcon className="size-3.5" />
                    <span className="sr-only">Forward</span>
                  </Button>
                </Tooltip>
              </>
            )}
            {menu}
          </span>
        )}
        {isSent &&
          !message.labelIds?.includes(GmailLabel.DRAFT) &&
          sentMessageOpen && <SentMessageOpenStatus open={sentMessageOpen} />}
        <time
          className="shrink-0 whitespace-nowrap text-muted-foreground text-xs"
          dateTime={message.headers.date}
        >
          {formatShortDate(new Date(message.headers.date))}
        </time>
      </div>
    </div>
  );
}

function ReplyPanel({
  message,
  refetch,
  onSendSuccess,
  onSent,
  onMarkDone,
  onCloseCompose,
  onRestore,
  onRestoreCompose,
  onStartDiscard,
  onDraftDiscarded,
  composeMode,
  draftMessage,
  draftSessionMessageId,
  draftBodyAvailable = true,
  autoFocus,
  autoScroll = false,
  bodyAvailable = true,
  replyAnchor,
  replyAll = false,
}: {
  message: ParsedMessage;
  refetch: () => void;
  onSendSuccess: (messageId: string, threadId: string) => void;
  onSent?: () => void;
  onMarkDone?: () => void;
  onCloseCompose: () => void;
  onRestore?: () => void;
  onRestoreCompose: (composeSession: ComposeSession) => void;
  onStartDiscard: () => ComposeSession | undefined;
  onDraftDiscarded?: () => void;
  composeMode: ReplyDraftMode;
  draftMessage?: ThreadMessage;
  draftSessionMessageId?: string;
  draftBodyAvailable?: boolean;
  autoFocus: boolean;
  autoScroll?: boolean;
  bodyAvailable?: boolean;
  replyAnchor?: ParsedMessage;
  replyAll?: boolean;
}) {
  const { emailAccountId, userEmail } = useAccount();
  const { popOutReply } = useComposeModal();
  const replyTargetId = replyAnchor?.id ?? message.id;
  const replyAssist = useContext(ReplyAssistContext);
  const assist =
    replyAssist &&
    composeMode === "reply" &&
    !draftMessage &&
    replyAssist.messageId === message.id
      ? replyAssist
      : null;
  const [edited, setEdited] = useState(false);
  const draftSessionId = getReplyDraftSessionId(
    draftSessionMessageId ?? message.id,
    composeMode,
  );

  const replyRef = useRef<HTMLDivElement>(null);
  // A forward owns its original source once composing starts. A later cache
  // fallback must not replace that source or discard the unsent editor state.
  const [forwardSource, setForwardSource] = useState<ParsedMessage>();
  if (composeMode === "forward" && bodyAvailable && !forwardSource)
    setForwardSource(message);
  // Once open, the composer and its local draft own the reply. A saved draft
  // that sync brings back before its body loads must not replace them.
  const [draftSource, setDraftSource] = useState<ParsedMessage>();
  if (draftMessage && draftBodyAvailable && !draftSource)
    setDraftSource(draftMessage);

  // scroll to the reply panel when it first opens
  useEffect(() => {
    if (!autoScroll || !replyRef.current) return;

    // Wait for the reply panel layout before scrolling.
    const scrollTimeout = setTimeout(() => {
      replyRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }, 500);

    return () => clearTimeout(scrollTimeout);
  }, [autoScroll]);

  const replyingToEmail = useMemo((): ReplyingToEmail | undefined => {
    if (composeMode === "reply") {
      if (draftSource) return prepareDraftReplyEmail(draftSource);

      return prepareReplyingToEmail({
        message,
        threadOn: replyAnchor,
        replyAll,
        userEmail,
      });
    }
    return forwardSource
      ? prepareForwardingEmail(forwardSource, Boolean(replyAnchor))
      : undefined;
  }, [
    composeMode,
    message,
    draftSource,
    forwardSource,
    replyAnchor,
    replyAll,
    userEmail,
  ]);

  const { executeAsync: discardDraft } = useAction(
    deleteDraftAction.bind(null, emailAccountId),
  );

  const onDiscard = useCallback(
    async (draftId?: string) => {
      if (composeMode === "forward" || !draftMessage) {
        onCloseCompose();
        return true;
      }

      const discardPromise = discardDraft({
        draftMessageId: draftMessage.id,
        draftId,
      });
      const composeSession = onStartDiscard();
      if (!composeSession) return false;

      try {
        const result = await discardPromise;
        if (
          result &&
          (result.serverError !== undefined ||
            result.validationErrors !== undefined)
        ) {
          toastError({
            description: getActionErrorMessage(result, {
              prefix: "Failed to discard draft",
            }),
          });
          onRestoreCompose(composeSession);
          return false;
        }
      } catch {
        toastError({ description: "Failed to discard draft" });
        onRestoreCompose(composeSession);
        return false;
      } finally {
        refetch();
      }
      onDraftDiscarded?.();
      return true;
    },
    [
      composeMode,
      draftMessage,
      discardDraft,
      onCloseCompose,
      onDraftDiscarded,
      onRestoreCompose,
      onStartDiscard,
      refetch,
    ],
  );

  if (draftMessage && !draftSource) {
    return (
      <div className="mt-5">
        <MessageBodyLoading />
      </div>
    );
  }

  if (!replyingToEmail)
    return (
      <div className="mt-5 flex gap-2">
        <Button onClick={refetch} size="sm" variant="outline">
          Load message to forward
        </Button>
        <Button onClick={onCloseCompose} size="sm" variant="ghost">
          Cancel
        </Button>
      </div>
    );

  return (
    <div
      className={cn(
        "mt-5",
        // Suggested text crossfades in rather than appearing all at once.
        assist?.suggestedBodyHtml && "fade-in animate-in duration-150",
      )}
      onInputCapture={() => setEdited(true)}
      ref={replyRef}
    >
      <ComposeEmailFormLazy
        autoFocus={autoFocus}
        initialBodyHtml={assist?.suggestedBodyHtml}
        summaryTag={
          assist?.suggestedBodyHtml && !edited ? "Suggested by Cue" : undefined
        }
        providerDraftMessageId={
          composeMode === "reply" ? draftMessage?.id : undefined
        }
        draftKeyMessageId={replyTargetId}
        draftMode={composeMode}
        draftSessionId={draftSessionId}
        onClose={() => {
          onCloseCompose();
          onSent?.();
        }}
        onRestore={onRestore}
        onDiscard={onDiscard}
        onPopOut={() => {
          popOutReply({
            emailAccountId,
            draftSessionId,
            draftKeyMessageId: replyTargetId,
            draftMode: composeMode,
            providerDraftMessageId:
              composeMode === "reply" ? draftMessage?.id : undefined,
            replyingToEmail,
            onReturn: onRestore,
          });
          onCloseCompose();
        }}
        onMarkDone={onMarkDone}
        onSuccess={(messageId: string, threadId: string) => {
          onSendSuccess(messageId, threadId);
          onCloseCompose();
        }}
        refetch={refetch}
        replyingToEmail={replyingToEmail}
      />
      {assist?.footer ? <div className="mt-2">{assist.footer}</div> : null}
    </div>
  );
}

function resolveComposeMode(
  override: ReplyDraftMode | "closed" | null,
  defaultComposeMode: ReplyDraftMode | undefined,
  isPoppedOut: (mode: ReplyDraftMode) => boolean,
) {
  if (override === "closed") return;
  const mode = override ?? defaultComposeMode;
  // A popped-out reply is written in its own window, not inline.
  if (mode && isPoppedOut(mode)) return;
  return mode;
}

function recipientSummary(
  { to, cc }: { to?: string; cc?: string },
  userEmail: string,
) {
  const names = formatRecipientNames(
    [...splitRecipientList(to ?? ""), ...splitRecipientList(cc ?? "")],
    userEmail,
  );
  return names ? `to ${names}` : "";
}

const prepareReplyingToEmail = ({
  message,
  threadOn = message,
  replyAll,
  userEmail,
}: {
  message: ParsedMessage;
  threadOn?: ParsedMessage;
  replyAll: boolean;
  userEmail: string;
}): ReplyingToEmail => {
  const sentFromUser = message.labelIds?.includes("SENT") ?? false;

  const { html } = createReplyContent({ message });
  const recipients = buildComposeReplyRecipients({
    headers: message.headers,
    sentFromUser,
    replyAll,
    userEmail,
  });

  return {
    to: recipients.to,
    // If following an email from yourself, don't add "Re:" prefix
    subject: sentFromUser
      ? message.headers.subject
      : formatReplySubject(message.headers.subject),
    headerMessageId: threadOn.headers["message-id"] || undefined,
    messageId: threadOn.id || undefined,
    threadId: threadOn.threadId || undefined,
    cc: recipients.cc,
    bcc: recipients.bcc,
    references: threadOn.headers.references,
    draftHtml: "",
    quotedContentHtml: html,
  };
};

const prepareForwardingEmail = (
  message: ParsedMessage,
  unsent = false,
): ReplyingToEmail => ({
  to: "",
  subject: forwardEmailSubject(message.headers.subject),
  headerMessageId: undefined,
  threadId: message.threadId || undefined,
  // The provider has no copy of an unsent message to forward from.
  forwardedMessageId: unsent ? undefined : message.id || undefined,
  forwardedAttachments: message.attachments?.map((attachment) => ({
    id: attachment.attachmentId,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
  })),
  cc: "",
  references: "",
  draftHtml: forwardEmailHtml({ content: "", message }),
  quotedContentHtml: "",
});

function prepareDraftReplyEmail(draft: ParsedMessage): ReplyingToEmail {
  const splitHtml = extractDraftComposerContent(
    draft.textHtml,
    draft.textPlain,
  );

  return {
    to: draft.headers.to,
    subject: draft.headers.subject,
    headerMessageId: draft.headers["message-id"] || undefined,
    messageId: draft.id || undefined,
    threadId: draft.threadId || undefined,
    cc: draft.headers.cc,
    bcc: draft.headers.bcc,
    references: draft.headers.references,
    draftHtml: splitHtml.draftHtml,
    quotedContentHtml: splitHtml.originalHtml,
    draftHasAttachments: Boolean(
      draft.attachments?.length || draft.inline?.length,
    ),
  };
}

function TranslationNotice({
  languageName,
  showOriginal,
  messageId,
  threadId,
}: {
  languageName: string | null;
  showOriginal: boolean;
  messageId: string;
  threadId: string;
}) {
  const { emailAccountId } = useAccount();
  const translateThread = useTranslateThread();
  let status = "Showing original";
  if (!showOriginal) {
    status = languageName ? `Translated from ${languageName}` : "Translated";
  }

  return (
    <p className="mb-3 flex items-center gap-1.5 text-muted-foreground text-xs">
      {status}
      <span aria-hidden>·</span>
      <button
        className="text-primary hover:underline"
        onClick={(event) => {
          event.stopPropagation();
          translateThread({
            emailAccountId,
            threadId,
            messageIds: [messageId],
          });
        }}
        type="button"
      >
        {showOriginal ? "Show translation" : "Show original"}
      </button>
    </p>
  );
}

function MessageBodyLoading() {
  return (
    <p
      className="flex items-center gap-2 text-muted-foreground text-sm"
      role="status"
    >
      <LoadingMiniSpinner />
      Loading message…
    </p>
  );
}
