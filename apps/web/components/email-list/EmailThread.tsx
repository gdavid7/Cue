import { OpenedConversationAttachments } from "./OpenedConversationAttachments";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { useHotkeys } from "react-hotkeys-hook";
import { isTypingTarget } from "@/lib/shortcuts/registry";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { Tooltip } from "@/components/Tooltip";
import type { ThreadMessage } from "@/components/email-list/types";
import { EmailMessage } from "@/components/email-list/EmailMessage";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useReplyDrafts } from "@/hooks/useReplyDrafts";
import { ThreadDeliveryStatus } from "@/components/email-list/ThreadDeliveryStatus";
import { useHiddenDraftMessageIds } from "@/hooks/useHiddenDraftMessageIds";
import { useComposeModal } from "@/providers/ComposeModalProvider";
import { Button } from "@/components/ui/button";
import {
  getDraftSessionMessageId,
  getLatestDraftMessageId,
  getReplyDraftMode,
  getReplyDraftSessionId,
  type ReplyDraftMode,
  type StoredReplyDraft,
} from "@/utils/mail-engine/reply-drafts";
import { internalDateToDate } from "@/utils/date";
import { GmailLabel } from "@/utils/gmail/label";
import { useSentMessageOpens } from "@/hooks/useSentMessageOpens";
import type { OutgoingThreadMessage } from "@/utils/mail-engine/conversation-thread";

const NO_OUTGOING: OutgoingThreadMessage[] = [];
/** Fewer earlier messages than this stay as rows of their own. */
const MIN_FOLDED_MESSAGES = 2;

export function EmailThread({
  messages,
  missingBodyIds,
  outgoing = NO_OUTGOING,
  sendOperationIds,
  refetch,
  showReplyButton,
  autoOpenReplyForMessageId,
  autoOpenReplyAll = false,
  autoOpenForwardForMessageId,
  focusAutoOpenedReply = true,
  topRightComponent,
  onSendSuccess,
  onMarkDone,
  onOpenSenderContext,
  onThreadDiscarded,
  withHeader,
  renderToolbar,
  renderMessageMenu,
  enableMessageNavigation = false,
  afterLatestMessage,
  replyStatus,
  earlierMessages,
}: {
  messages: ThreadMessage[];
  missingBodyIds?: Set<string>;
  /** Sends queued on this device, shown after the thread until they sync. */
  outgoing?: OutgoingThreadMessage[];
  /** The send each confirmed message came from, so it replaces its outgoing copy in place. */
  sendOperationIds?: Map<string, string>;
  refetch: () => void;
  showReplyButton: boolean;
  autoOpenReplyForMessageId?: string;
  /** Addresses the auto-opened reply to everyone on the message. */
  autoOpenReplyAll?: boolean;
  autoOpenForwardForMessageId?: string;
  /** False when Cue, not the user, opened the reply, so it leaves focus alone. */
  focusAutoOpenedReply?: boolean;
  topRightComponent?: React.ReactNode;
  onSendSuccess?: (
    messageId: string,
    sentThreadId: string,
    repliedThreadId: string,
  ) => void;
  onMarkDone?: () => void;
  onOpenSenderContext?: (message: ThreadMessage) => void;
  /** The conversation's only message was a draft, and it has been discarded. */
  onThreadDiscarded?: () => void;
  withHeader?: boolean;
  enableMessageNavigation?: boolean;
  /** Shown under the newest message, above where its reply is written. */
  afterLatestMessage?: ReactNode;
  /** A line under the newest message's reply actions. */
  replyStatus?: ReactNode;
  /** Set while older messages exist that haven't been loaded yet. */
  earlierMessages?: { loading: boolean; onLoad: () => unknown };
  renderMessageMenu?: (message: ThreadMessage) => ReactNode;
  renderToolbar?: (controls: {
    allExpanded: boolean;
    canExpand: boolean;
    onToggleAll: () => void;
  }) => ReactNode;
}) {
  const { emailAccountId, userEmail } = useAccount();
  const threadId = messages[0]?.threadId ?? "";
  const { drafts: localDrafts, isLoading: draftsLoading } = useReplyDrafts(
    emailAccountId,
    threadId,
    [
      ...messages
        .filter((message) => !message.labelIds?.includes(GmailLabel.DRAFT))
        .map((message) => getComposerMessageId(message.id, sendOperationIds)),
      ...outgoing.map((item) => item.message.id),
    ],
  );
  const { data: sentMessageOpens } = useSentMessageOpens(threadId || null);
  const hiddenDraftMessageIds = useHiddenDraftMessageIds(emailAccountId);
  const organizedMessages = useMemo(
    (): Array<{
      message: ThreadMessage;
      draftMessages: ThreadMessage[];
      outgoing?: OutgoingThreadMessage;
    }> => [
      ...organizeThreadMessages(
        withoutDraftMessages(withoutReplacedDrafts(messages, emailAccountId), [
          ...localDrafts.flatMap(
            (draft) => draft.content?.providerDraftMessageIds ?? [],
          ),
          ...hiddenDraftMessageIds,
          // Opening a mailbox copy before the local lookup creates a second session.
          ...(draftsLoading ? messages.map((message) => message.id) : []),
        ]),
      ),
      ...outgoing.map((item) => ({
        message: {
          ...item.message,
          headers: { ...item.message.headers, from: userEmail },
        },
        draftMessages: [],
        outgoing: item,
      })),
    ],
    [
      messages,
      emailAccountId,
      localDrafts,
      draftsLoading,
      hiddenDraftMessageIds,
      outgoing,
      userEmail,
    ],
  );

  // A conversation whose only message is a draft — how the Drafts folder lists
  // one — stops existing the moment that draft is discarded.
  const isDraftOnlyConversation =
    organizedMessages.length === 1 &&
    Boolean(organizedMessages[0].message.labelIds?.includes(GmailLabel.DRAFT));
  const lastMessageId = organizedMessages.at(-1)?.message.id;
  // A reply that hasn't reached the provider has no id to thread on yet, so
  // replying to it threads on the newest message the provider has.
  const replyAnchor = organizedMessages.findLast(
    ({ message, outgoing }) =>
      !outgoing && !message.labelIds?.includes(GmailLabel.DRAFT),
  )?.message;

  const [expansionOverrides, setExpansionOverrides] = useState<
    Map<string, boolean>
  >(
    () =>
      new Map(
        organizedMessages
          .filter(({ message }) =>
            message.labelIds?.includes(GmailLabel.UNREAD),
          )
          .map(({ message }) => [message.id, true]),
      ),
  );
  // Like Gmail, one composer is open at a time: the one the user last opened,
  // else the newest draft. Every other draft is a row that opens on click.
  const [openRequest, setOpenRequest] = useState<OpenComposerRequest>();
  const requestOpen = useCallback(
    (request: Omit<OpenComposerRequest, "threadId" | "previous">) =>
      setOpenRequest((previous) => ({
        ...request,
        threadId,
        previous: previous?.threadId === threadId ? previous : undefined,
      })),
    [threadId],
  );
  const { poppedOutDraftSessionId } = useComposeModal();
  const [dismissedDraftIds, setDismissedDraftIds] = useState(
    () => new Set<string>(),
  );
  const setDraftDismissed = useCallback(
    (sessionMessageId: string, dismissed: boolean) => {
      setDismissedDraftIds((previous) => {
        if (previous.has(sessionMessageId) === dismissed) return previous;
        const next = new Set(previous);
        if (dismissed) next.add(sessionMessageId);
        else next.delete(sessionMessageId);
        return next;
      });
    },
    [],
  );
  const isDraftShown = (sessionMessageId: string) =>
    !dismissedDraftIds.has(sessionMessageId) &&
    getReplyDraftSessionId(sessionMessageId, "reply") !==
      poppedOutDraftSessionId;
  const shownDraftsOf = (draftMessages: ThreadMessage[]) =>
    draftMessages
      .map((draft) => ({
        draft,
        sessionMessageId: getDraftSessionMessageId(emailAccountId, draft.id),
      }))
      .filter(({ sessionMessageId }) => isDraftShown(sessionMessageId));
  const [recoveredReply, setRecoveredReply] = useState<{
    messageId: string;
    mode: ReplyDraftMode;
    version: number;
  }>();
  useEffect(() => {
    const messageId = autoOpenForwardForMessageId ?? autoOpenReplyForMessageId;
    if (messageId) {
      requestOpen({
        kind: "compose",
        id: messageId,
        focus: Boolean(autoOpenForwardForMessageId) || focusAutoOpenedReply,
      });
      setExpansionOverrides((previous) =>
        new Map(previous).set(messageId, true),
      );
    }
  }, [
    autoOpenForwardForMessageId,
    autoOpenReplyForMessageId,
    focusAutoOpenedReply,
    requestOpen,
  ]);
  const expanded = (id: string, hasDraft: boolean) =>
    expansionOverrides.get(id) ?? (id === lastMessageId || hasDraft);
  const localDraftFor = (message: ThreadMessage) => {
    if (message.labelIds?.includes(GmailLabel.DRAFT)) return;
    return getLatestLocalDraft(
      localDrafts,
      getComposerMessageId(message.id, sendOperationIds),
    );
  };
  const localDraftModeFor = (message: ThreadMessage) => {
    const draft = localDraftFor(message);
    return draft && getLocalDraftMode(draft);
  };
  const composerIdOf = (messageId: string) =>
    getComposerMessageId(messageId, sendOperationIds);
  const shownDraftIds = new Set(
    organizedMessages.flatMap(({ draftMessages }) =>
      shownDraftsOf(draftMessages).map((draft) => draft.sessionMessageId),
    ),
  );
  const latestRequest =
    openRequest?.threadId === threadId ? openRequest : undefined;
  let request = latestRequest;
  // A closed or discarded draft hands the composer back to the one before it.
  while (request?.kind === "draft" && !shownDraftIds.has(request.id))
    request = request.previous;
  // A composer handed back that way, or opened on its own, leaves focus alone.
  const focusOpenComposer =
    Boolean(request?.focus) && request === latestRequest;
  const openComposer: Pick<OpenComposerRequest, "kind" | "id"> | undefined =
    request ??
    newestDraft([
      ...organizedMessages.flatMap(({ draftMessages }) =>
        shownDraftsOf(draftMessages).map(({ draft, sessionMessageId }) => ({
          kind: "draft" as const,
          id: sessionMessageId,
          recency: draftRecency(draft),
        })),
      ),
      ...organizedMessages.flatMap(({ message }) => {
        const local = localDraftFor(message);
        return local
          ? [
              {
                kind: "compose" as const,
                id: message.id,
                recency: local.updatedAt,
              },
            ]
          : [];
      }),
    ]);
  const onComposerClosed = (messageId: string) =>
    setOpenRequest((request) =>
      request?.threadId === threadId &&
      request.kind === "compose" &&
      composerIdOf(request.id) === composerIdOf(messageId)
        ? request.previous
        : request,
    );
  const hasLocalDraft = (message: ThreadMessage) =>
    Boolean(localDraftModeFor(message));
  const isRowExpanded = ({
    message,
    draftMessages,
  }: (typeof organizedMessages)[number]) =>
    expanded(
      message.id,
      autoOpenReplyForMessageId === message.id ||
        autoOpenForwardForMessageId === message.id ||
        recoveredReply?.messageId === message.id ||
        draftMessages.length > 0 ||
        hasLocalDraft(message),
    );
  const allExpanded = organizedMessages.every(isRowExpanded);

  // Like Gmail, a run of read messages between the first and the newest folds
  // into one row that says how many it holds. While older messages are still
  // to load, everything before the newest folds into that row, and opening it
  // loads them too: one way to see the rest of the conversation.
  const [showEarlier, setShowEarlier] = useState(false);
  const foldableRows = earlierMessages
    ? organizedMessages.slice(0, -1)
    : organizedMessages.slice(1, -1);
  const foldedIds =
    !showEarlier &&
    foldableRows.length >= (earlierMessages ? 1 : MIN_FOLDED_MESSAGES) &&
    !foldableRows.some(isRowExpanded)
      ? new Set(foldableRows.map(({ message }) => message.id))
      : undefined;
  const showEarlierMessages = () => {
    // The row goes away once it has done its job, so focus moves to the
    // first message it revealed rather than falling back to the page.
    const focusId = foldedIds
      ? foldableRows[0]?.message.id
      : organizedMessages[0]?.message.id;
    flushSync(() => setShowEarlier(true));
    earlierMessages?.onLoad();
    if (!focusId) return;
    setSelectedMessageId(focusId);
    focusMessage(focusId);
  };

  const toggleAll = () => {
    if (allExpanded) setShowEarlier(false);
    setExpansionOverrides(
      new Map(
        organizedMessages.map(({ message }) => [
          message.id,
          allExpanded ? message.id === lastMessageId : true,
        ]),
      ),
    );
  };
  const [selectedMessageId, setSelectedMessageId] = useState<string>();
  const selectedId = organizedMessages.some(
    ({ message }) => message.id === selectedMessageId,
  )
    ? selectedMessageId
    : lastMessageId;
  const threadRef = useRef<HTMLDivElement>(null);
  const selectRelativeMessage = (direction: -1 | 1, fromId = selectedId) => {
    const currentIndex = organizedMessages.findIndex(
      ({ message }) => message.id === fromId,
    );
    const nextIndex = Math.max(
      0,
      Math.min(organizedMessages.length - 1, currentIndex + direction),
    );
    const nextId = organizedMessages[nextIndex]?.message.id;
    if (!nextId) return;
    // Arrowing into the folded row unfolds it, so the message can take focus.
    if (foldedIds?.has(nextId)) flushSync(() => setShowEarlier(true));
    setSelectedMessageId(nextId);
    focusMessage(nextId);
  };
  function focusMessage(messageId: string) {
    const element = Array.from(
      threadRef.current?.querySelectorAll<HTMLElement>(
        "[data-thread-message-id]",
      ) ?? [],
    ).find((item) => item.dataset.threadMessageId === messageId);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView?.({ block: "nearest" });
  }
  useHotkeys(
    "arrowup,arrowdown",
    (event) => selectRelativeMessage(event.key === "ArrowUp" ? -1 : 1),
    {
      enabled: enableMessageNavigation,
      scopes: ["mail"],
      useKey: true,
      preventDefault: true,
      ignoreEventWhen: (event: KeyboardEvent) =>
        event.isComposing ||
        window.getSelection()?.isCollapsed === false ||
        isTypingTarget(event.target) ||
        (event.target instanceof Element &&
          Boolean(
            event.target.closest(
              '[role="dialog"], [role="menu"], [role="listbox"]',
            ),
          )),
    },
  );

  return (
    // White regardless of the surface it is dropped on: an email body renders
    // on white inside its iframe, so anything else leaves each message boxed.
    <OpenedConversationAttachments
      allowUncached
      emailAccountId={emailAccountId}
      threadId={threadId}
    >
      <div className="min-w-0 bg-card" ref={threadRef}>
        {renderToolbar?.({
          allExpanded,
          canExpand: organizedMessages.length > 1,
          onToggleAll: toggleAll,
        })}
        {withHeader && (
          <div className="flex items-center justify-between">
            <div className="font-semibold text-2xl text-foreground">
              {messages[0]?.headers.subject}
            </div>
            {topRightComponent && (
              <div className="flex items-center gap-2">{topRightComponent}</div>
            )}
          </div>
        )}

        {!renderToolbar && organizedMessages.length > 1 && (
          <div className="flex justify-end pt-2">
            <Tooltip
              content={
                allExpanded ? "Collapse all messages" : "Expand all messages"
              }
            >
              <Button
                aria-label={
                  allExpanded ? "Collapse all messages" : "Expand all messages"
                }
                onClick={toggleAll}
                size="iconXs"
                variant="ghostMuted"
              >
                {allExpanded ? (
                  <ChevronsDownUpIcon className="size-3.5" />
                ) : (
                  <ChevronsUpDownIcon className="size-3.5" />
                )}
              </Button>
            </Tooltip>
          </div>
        )}

        <ul className="pt-1">
          {earlierMessages && !foldedIds && (
            <EarlierMessagesRow
              loading={earlierMessages.loading}
              onShow={showEarlierMessages}
            />
          )}
          {organizedMessages.map(({ message, draftMessages, outgoing }) => {
            if (foldedIds?.has(message.id))
              return message.id === foldableRows[0]?.message.id ? (
                <EarlierMessagesRow
                  count={earlierMessages ? undefined : foldedIds.size}
                  key="folded-messages"
                  loading={earlierMessages?.loading ?? false}
                  onShow={showEarlierMessages}
                />
              ) : null;
            const sendOperationId =
              outgoing?.operationId ?? sendOperationIds?.get(message.id);
            let autoOpenMode: ReplyDraftMode | undefined;
            if (autoOpenForwardForMessageId === message.id)
              autoOpenMode = "forward";
            else if (autoOpenReplyForMessageId === message.id)
              autoOpenMode = "reply";
            const recoveredMode =
              recoveredReply?.messageId === message.id
                ? recoveredReply.mode
                : undefined;
            const defaultComposeMode =
              recoveredMode ?? autoOpenMode ?? localDraftModeFor(message);
            return (
              <EmailMessage
                bodyAvailable={!missingBodyIds?.has(message.id)}
                missingBodyIds={missingBodyIds}
                onNavigateMessage={
                  enableMessageNavigation
                    ? (direction) =>
                        selectRelativeMessage(direction, message.id)
                    : undefined
                }
                selected={
                  enableMessageNavigation
                    ? message.id === selectedId
                    : undefined
                }
                onSelect={
                  enableMessageNavigation
                    ? () => setSelectedMessageId(message.id)
                    : undefined
                }
                composerOpen={
                  openComposer?.kind === "compose" &&
                  composerIdOf(openComposer.id) === composerIdOf(message.id)
                }
                openDraftSessionId={
                  openComposer?.kind === "draft" ? openComposer.id : undefined
                }
                dismissedDraftIds={dismissedDraftIds}
                onDraftDismissedChange={setDraftDismissed}
                onOpenDraft={(sessionMessageId) =>
                  requestOpen({
                    kind: "draft",
                    id: sessionMessageId,
                    focus: true,
                  })
                }
                onComposerClosed={() => onComposerClosed(message.id)}
                localDraftSnippet={localDraftSnippet(localDraftFor(message))}
                onStartCompose={() =>
                  requestOpen({ kind: "compose", id: message.id, focus: true })
                }
                focusComposer={focusOpenComposer}
                defaultComposeMode={defaultComposeMode}
                defaultReplyAll={autoOpenMode === "reply" && autoOpenReplyAll}
                draftMessages={draftMessages}
                expanded={expanded(
                  message.id,
                  Boolean(defaultComposeMode) || draftMessages.length > 0,
                )}
                hasDraft={draftMessages.length > 0 || hasLocalDraft(message)}
                // A draft-only row follows its draft across Gmail's per-save
                // message IDs, and a sent row keeps the place of its outgoing copy.
                key={`${sendOperationId ?? getDraftSessionMessageId(emailAccountId, message.id)}:${recoveredReply?.messageId === message.id ? recoveredReply.version : 0}`}
                message={message}
                menu={renderMessageMenu?.(message)}
                afterBody={
                  message.id === replyAnchor?.id
                    ? afterLatestMessage
                    : undefined
                }
                replyAnchor={outgoing ? replyAnchor : undefined}
                composerSessionMessageId={
                  sendOperationId ? `outgoing:${sendOperationId}` : undefined
                }
                onReplySent={() => {
                  // The sent reply lands below as the newest message; keep this
                  // one open and let selection fall through to the reply.
                  setExpansionOverrides((prev) =>
                    new Map(prev).set(message.id, true),
                  );
                  setSelectedMessageId(undefined);
                }}
                onOpenSenderContext={onOpenSenderContext}
                onMarkDone={onMarkDone}
                onDraftDiscarded={
                  isDraftOnlyConversation ? onThreadDiscarded : undefined
                }
                onExpand={() =>
                  setExpansionOverrides((prev) =>
                    new Map(prev).set(message.id, true),
                  )
                }
                onSendSuccess={(messageId, sentThreadId) => {
                  setExpansionOverrides((prev) =>
                    new Map(prev).set(messageId, true),
                  );

                  onSendSuccess?.(messageId, sentThreadId, threadId);
                }}
                // A one-message thread has nothing to collapse back to.
                onToggle={
                  organizedMessages.length === 1
                    ? undefined
                    : () => {
                        setExpansionOverrides((prev) =>
                          new Map(prev).set(
                            message.id,
                            !expanded(
                              message.id,
                              Boolean(defaultComposeMode) ||
                                draftMessages.length > 0,
                            ),
                          ),
                        );
                      }
                }
                refetch={refetch}
                sentMessageOpen={sentMessageOpens?.opens[message.id]}
                showReplyButton={
                  showReplyButton &&
                  !message.labelIds?.includes(GmailLabel.DRAFT)
                }
                showReplyBar={message.id === replyAnchor?.id && !openComposer}
                replyStatus={
                  message.id === replyAnchor?.id ? replyStatus : undefined
                }
              />
            );
          })}
        </ul>
        {threadId && (
          <ThreadDeliveryStatus
            emailAccountId={emailAccountId}
            canEditReply={showReplyButton}
            threadId={threadId}
            messageIds={messages.map((message) => message.id)}
            refetch={refetch}
            onEditReply={(messageId, mode) => {
              requestOpen({ kind: "compose", id: messageId, focus: true });
              setExpansionOverrides((previous) =>
                new Map(previous).set(messageId, true),
              );
              setRecoveredReply((previous) => ({
                messageId,
                mode,
                version: (previous?.version ?? 0) + 1,
              }));
            }}
          />
        )}
      </div>
    </OpenedConversationAttachments>
  );
}

/**
 * The one way to reveal the rest of a conversation: the messages folded here,
 * and any older ones still to load. `count` is left out when it isn't known.
 */
function EarlierMessagesRow({
  count,
  loading,
  onShow,
}: {
  count?: number;
  loading: boolean;
  onShow: () => void;
}) {
  let label =
    count === undefined ? "Show earlier messages" : `${count} earlier messages`;
  if (loading) label = "Loading earlier messages…";
  return (
    <li className="flex items-center gap-3 px-2 py-1.5 sm:px-5">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <button
        // Not `disabled`: that would drop keyboard focus while it loads.
        aria-disabled={loading || undefined}
        aria-label={
          count === undefined || loading
            ? undefined
            : `Show ${count} earlier messages`
        }
        className="shrink-0 rounded-md px-2 py-1 font-medium text-muted-foreground text-xs outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none"
        onClick={loading ? undefined : onShow}
        type="button"
      >
        {label}
      </button>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </li>
  );
}

function getComposerMessageId(
  messageId: string,
  sendOperationIds?: Map<string, string>,
) {
  const operationId = sendOperationIds?.get(messageId);
  return operationId ? `outgoing:${operationId}` : messageId;
}

type OpenComposerRequest = {
  threadId: string;
  /** A mailbox draft by its session id, or a message's own reply or forward. */
  kind: "draft" | "compose";
  id: string;
  /** The user asked for it, so it takes focus when it opens. */
  focus: boolean;
  previous?: OpenComposerRequest;
};

function newestDraft<T extends { recency: number }>(drafts: T[]) {
  return drafts.reduce<T | undefined>(
    (newest, draft) =>
      !newest || draft.recency >= newest.recency ? draft : newest,
    undefined,
  );
}

function getLatestLocalDraft(drafts: StoredReplyDraft[], messageId: string) {
  return drafts
    .filter(
      (draft) =>
        draft.messageId === getReplyDraftSessionId(messageId, "reply") ||
        draft.messageId === getReplyDraftSessionId(messageId, "forward"),
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function getLocalDraftMode(draft: StoredReplyDraft) {
  return draft.messageId.endsWith(":forward")
    ? ("forward" as const)
    : getReplyDraftMode(draft);
}

function localDraftSnippet(draft: StoredReplyDraft | undefined) {
  if (!draft) return;
  const html = draft.content?.draft?.editableHtml ?? "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Drafts without reply headers still belong to this conversation. Keep each
// composer, falling back to the latest message when its parent is unavailable.
export function organizeThreadMessages(messages: ThreadMessage[]) {
  const drafts: ThreadMessage[] = [];
  const regularMessages: ThreadMessage[] = [];

  for (const message of messages) {
    if (message.labelIds?.includes(GmailLabel.DRAFT)) drafts.push(message);
    else regularMessages.push(message);
  }

  if (regularMessages.length === 0) {
    return sortDraftsOldestFirst(drafts).map((draft) => ({
      message: draft,
      draftMessages: [draft],
    }));
  }

  const messagesByHeaderId = new Map<string, ThreadMessage>();
  for (const message of regularMessages) {
    const headerId = message.headers["message-id"];
    if (headerId && !messagesByHeaderId.has(headerId)) {
      messagesByHeaderId.set(headerId, message);
    }
  }
  const draftsByMessageId = new Map<string, ThreadMessage[]>();
  for (const draft of drafts) {
    const parentId =
      draft.headers.references?.trim().split(/\s+/).at(-1) ||
      draft.headers["in-reply-to"]?.trim();
    const parent = parentId ? messagesByHeaderId.get(parentId) : undefined;
    const target = parent ?? regularMessages.at(-1);
    if (!target) continue;
    const existing = draftsByMessageId.get(target.id);
    if (existing) existing.push(draft);
    else draftsByMessageId.set(target.id, [draft]);
  }

  return regularMessages.map((message) => ({
    message,
    draftMessages: sortDraftsOldestFirst(
      draftsByMessageId.get(message.id) ?? [],
    ),
  }));
}

// A saved draft's old and new Gmail messages can both be in the conversation
// until sync removes the old one. Only the latest save is the draft being edited.
function withoutReplacedDrafts(
  messages: ThreadMessage[],
  emailAccountId: string,
) {
  const messageIds = new Set(messages.map((message) => message.id));
  return messages.filter((message) => {
    if (!message.labelIds?.includes(GmailLabel.DRAFT)) return true;
    const latest = getLatestDraftMessageId(
      emailAccountId,
      getDraftSessionMessageId(emailAccountId, message.id),
    );
    return !latest || latest === message.id || !messageIds.has(latest);
  });
}

// A reply with files is saved to the mailbox while its composer is open, and
// stays there until a scheduled send goes out from it. The composer or the
// delivery status already shows it, so the saved copy would be a second editor.
function withoutDraftMessages(messages: ThreadMessage[], draftIds: string[]) {
  if (!draftIds.length) return messages;
  return messages.filter(
    (message) =>
      !message.labelIds?.includes(GmailLabel.DRAFT) ||
      !draftIds.includes(message.id),
  );
}

function sortDraftsOldestFirst(drafts: ThreadMessage[]) {
  return [...drafts].sort(
    (left, right) => draftRecency(left) - draftRecency(right),
  );
}

function draftRecency(draft: ThreadMessage) {
  const value = draft.internalDate ?? draft.headers.date;
  const time = internalDateToDate(value, { fallbackToNow: false }).getTime();
  return Number.isNaN(time) ? 0 : time;
}
