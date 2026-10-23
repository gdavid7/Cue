"use client";

import { useChat as useAiChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { parseAsString, useQueryState } from "nuqs";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtomValue } from "jotai";
import { useSWRConfig } from "swr";
import { openThreadAtom } from "@/store/open-thread";
import { captureException } from "@/utils/error";
import { toastError } from "@/components/Toast";
import { convertToUIMessages } from "@/components/assistant-chat/helpers";
import type { ChatMessage } from "@/components/assistant-chat/types";
import { chatMessagesKey, useChatMessages } from "@/hooks/useChatMessages";
import { CHAT_ACCOUNT_PARAM, CHAT_ID_PARAM } from "@/utils/chat-url";
import { useAccounts } from "@/hooks/useAccounts";
import { useAccount } from "@/providers/EmailAccountProvider";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import type { MessageContext } from "@/utils/ai/assistant/chat-context-validation";
import { InlineEmailActionProvider } from "@/components/assistant-chat/inline-email-action-context";
import {
  mergeInlineEmailActions,
  type InlineEmailAction,
  type InlineEmailActionType,
} from "@/utils/ai/assistant/inline-email-actions";
import {
  ASSISTANT_CHAT_MAX_TEXT_LENGTH,
  ASSISTANT_CHAT_MAX_TEXT_LENGTH_MESSAGE,
} from "@/utils/actions/assistant-chat.validation";
import { createClientLogger } from "@/utils/logger-client";
import { getActiveMailClient } from "@/utils/mail-engine/active-client";
import { answerAssistantSearch } from "@/utils/mail-engine/assistant-search";
import { LOCAL_MAIL_SEARCH_SYNTAXES } from "@/utils/actions/assistant-chat.validation";
import { submitLocalMailSearchResult } from "@/utils/actions/assistant-chat";
import { MAX_CHAT_RUN_MS } from "@/utils/chat/max-run";
import { holdBuildReload } from "@/utils/build-reload";

const logger = createClientLogger("assistant-chat");

export type Attachment = {
  id: string;
  name: string;
  url: string;
  contentType: string;
};

export type Chat = ReturnType<typeof useAiChat<ChatMessage>>;

type ChatMessagePart =
  | { type: "file"; url: string; filename: string; mediaType: string }
  | { type: "text"; text: string };

const FINISHING_POLL_MS = 3000;

type PendingChatRequest = {
  attachmentCount: number;
  chatId: string;
  textLength: number;
};

type ChatAccount = GetEmailAccountsResponse["emailAccounts"][number];

type ChatContextType = {
  chat: Chat;
  /** The account this chat reads and acts in; tools never reach another. */
  chatAccount: ChatAccount | null;
  /** The chat works in an account other than the page's. */
  switchedAccount: boolean;
  /** The accounts list failed before the chat's account row loaded. */
  chatAccountError: Error | undefined;
  /**
   * The open email's account, when the conversation stays in another one
   * because it already has messages.
   */
  openThreadAccountId: string | null;
  /** Starts a new conversation in another of the user's accounts. */
  switchChatAccount: (emailAccountId: string) => void;
  /**
   * Takes the chat to an email's account when it is empty and idle. A
   * conversation or reply under way stays, and the chat offers the switch.
   */
  followEmailAccount: (emailAccountId: string) => void;
  /** Opens a saved chat in the account it belongs to. */
  openChat: (chat: { id: string; emailAccountId: string }) => void;
  input: string;
  chatId: string | null;
  persistedMessageIds: Set<string>;
  setInput: (input: string) => void;
  setChatId: (chatId: string | null) => void;
  setNewChat: () => void;
  submitTextMessage: (text: string) => Promise<void>;
  handleSubmit: () => void;
  stop: () => Promise<void>;
  /**
   * A reply is still running on the server but isn't streaming here, e.g.
   * its connection dropped. It shows once the run saves it.
   */
  replyFinishing: boolean;
  context: MessageContext | null;
  /**
   * Attaches context to the next message. Context about an email names the
   * email's account, and the chat moves there if it is in another one.
   */
  setContext: (
    context: MessageContext | null,
    options?: { accountId: string },
  ) => void;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  /**
   * Set by something that opens the panel for the user to type, such as
   * "Ask Cue about this email". The panel's input takes the cursor once it
   * exists, then clears the request.
   */
  inputFocusRequested: boolean;
  requestInputFocus: () => void;
  clearInputFocusRequest: () => void;
};

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { emailAccountId: routeAccountId, accountIds } = useAccount();
  const { data: accountsData, error: accountsError } = useAccounts();
  const { mutate } = useSWRConfig();
  // Chats are stored per account. In All inboxes the chat can work in another
  // account than the page's; the address names it, so a reload or a shared
  // `?chatId=` link reopens the chat where it lives. An id that is not one of
  // the user's accounts (or no longer is) falls back to the page's account.
  const [chatAccountIdParam, setChatAccountIdParam] = useQueryState(
    CHAT_ACCOUNT_PARAM,
    parseAsString,
  );
  // The chat's account was removed, or the address names another user's:
  // its chat can't be used here, so the chat starts over in the page's
  // account. A list that failed to load says nothing about the account, so
  // the chat waits for it rather than losing the conversation.
  const chatAccountMissing =
    Boolean(chatAccountIdParam) &&
    ((accountIds.length > 0 &&
      !accountIds.includes(chatAccountIdParam ?? "")) ||
      Boolean(
        accountsData &&
          !accountsData.emailAccounts.some(
            (account) => account.id === chatAccountIdParam,
          ),
      ));
  const emailAccountId =
    chatAccountIdParam && !chatAccountMissing
      ? chatAccountIdParam
      : routeAccountId;
  const chatAccount = useMemo<ChatAccount | null>(
    () =>
      accountsData?.emailAccounts.find(
        (candidate) => candidate.id === emailAccountId,
      ) ?? null,
    [accountsData, emailAccountId],
  );

  const [input, setInput] = useState<string>("");
  const [chatId, setChatId] = useQueryState(CHAT_ID_PARAM, parseAsString);
  const [context, setContext] = useState<MessageContext | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [inputFocusRequested, setInputFocusRequested] = useState(false);
  const requestInputFocus = useCallback(() => setInputFocusRequested(true), []);
  const clearInputFocusRequest = useCallback(
    () => setInputFocusRequested(false),
    [],
  );
  const [inlineActions, setInlineActions] = useState<InlineEmailAction[]>([]);
  const inlineActionsRef = useRef(inlineActions);
  const openThread = useAtomValue(openThreadAtom);
  const openThreadRef = useRef<typeof openThread>(null);
  const pendingInlineActionsRef = useRef<InlineEmailAction[] | null>(null);
  const pendingRequestRef = useRef<PendingChatRequest | null>(null);
  const pendingRequestContextRef = useRef<MessageContext | null>(null);
  const previousChatIdRef = useRef(chatId);
  const previousRouteAccountIdRef = useRef<string | null>(null);
  const followedThreadRef = useRef<string | null>(null);
  // After an explicit stop, don't reattach until the user sends again.
  const stoppedRef = useRef(false);
  // A send failed or dropped mid-reply; the run may still be going server-side.
  const interruptedRef = useRef(false);
  const resumingRef = useRef(false);
  const resumedStreamIdRef = useRef<string | null>(null);
  const messagesAtHideRef = useRef<unknown>(null);

  const { data, error: messagesError } = useChatMessages(
    chatId,
    emailAccountId,
  );
  const persistedMessageIds = useMemo(
    () => new Set(data?.messages.map((message) => message.id) ?? []),
    [data?.messages],
  );

  const setNewChat = useCallback(() => {
    setChatId(generateUUID());
  }, [setChatId]);

  const queueInlineAction = useCallback(
    (type: InlineEmailActionType, threadIds: string[]) => {
      setInlineActions((current) =>
        mergeInlineEmailActions(current, { type, threadIds }),
      );
    },
    [],
  );

  const chat = useAiChat<ChatMessage>({
    id: chatId ?? undefined,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      headers: {
        [EMAIL_ACCOUNT_HEADER]: emailAccountId,
      },
      prepareSendMessagesRequest({ messages, id, body }) {
        return {
          body: {
            id,
            message: messages.at(-1),
            supportsInlineEmailCards: true,
            inlineActions: pendingInlineActionsRef.current ?? undefined,
            openThreadId: openThreadRef.current?.threadId,
            openMessageId: openThreadRef.current?.messageId,
            localMailSearch: Boolean(getActiveMailClient()),
            localMailSearchSyntaxes: LOCAL_MAIL_SEARCH_SYNTAXES,
            ...body,
          },
        };
      },
    }),
    // messages: initialMessages, // NOTE: couldn't get this to work
    experimental_throttle: 100,
    generateId: generateUUID,
    onData: (part) => {
      if (part.type !== "data-local-mail-search") return;
      answerAssistantSearch({
        request: part.data,
        accountId: emailAccountId,
        client: getActiveMailClient(),
        submit: async (input) => {
          const result = await submitLocalMailSearchResult(
            emailAccountId,
            input,
          );
          if (result?.serverError || result?.validationErrors)
            logger.warn("Local mail search answer was not accepted");
        },
      }).catch((error) => {
        logger.warn("Local mail search failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
    },
    onFinish: async ({ isAbort }) => {
      pendingInlineActionsRef.current = null;
      pendingRequestRef.current = null;
      pendingRequestContextRef.current = null;
      // An abort is a stop or a reattach, which refetch once the server has
      // saved the reply; refetching now would drop the partial one shown.
      await Promise.all([
        mutate("/api/user/rules"),
        chatId && !isAbort
          ? mutate(chatMessagesKey(chatId, emailAccountId))
          : Promise.resolve(),
      ]);
    },
    onError: (error) => {
      if (resumingRef.current) {
        interruptedRef.current = true;
        logger.warn("Assistant chat resume failed", {
          chatId: chatId ?? chat.id,
          errorName: error.name,
        });
        return;
      }

      interruptedRef.current = true;
      if (document.visibilityState === "visible") resumeActiveRun();

      // The server already has the message once the reply starts streaming,
      // so a dropped connection is reattached rather than reported as unsent.
      if (chat.status === "streaming") {
        pendingInlineActionsRef.current = null;
        pendingRequestRef.current = null;
        pendingRequestContextRef.current = null;
        logger.warn("Assistant chat stream interrupted", {
          chatId: chatId ?? chat.id,
          errorName: error.name,
        });
        return;
      }

      const pendingRequest = pendingRequestRef.current;
      const pendingInlineActions = pendingInlineActionsRef.current;
      const pendingContext = pendingRequestContextRef.current;
      if (pendingContext) {
        setContext((current) => current ?? pendingContext);
      }
      if (pendingInlineActions?.length) {
        setInlineActions((current) =>
          pendingInlineActions.reduce(
            (merged, action) => mergeInlineEmailActions(merged, action),
            current,
          ),
        );
        pendingInlineActionsRef.current = null;
      }

      reportChatRequestError({
        emailAccountId,
        error,
        fallbackChatId: chatId ?? chat.id,
        request: pendingRequest,
      });
      pendingRequestRef.current = null;
      pendingRequestContextRef.current = null;
    },
  });

  const isRunActive =
    chat.status === "submitted" || chat.status === "streaming";
  // A reload would cut the reply off mid-stream.
  useEffect(() => (isRunActive ? holdBuildReload() : undefined), [isRunActive]);
  const activeStreamId = data?.activeStreamId ?? null;
  const activeStreamStartedAt = data?.activeStreamStartedAt ?? null;
  // Set when a run outlives the chat route's limit without clearing its
  // marker (its instance died), so the wait ends even if the data never
  // changes again.
  const [expiredStreamId, setExpiredStreamId] = useState<string | null>(null);
  const replyFinishing =
    !isRunActive &&
    Boolean(activeStreamId) &&
    activeStreamId !== expiredStreamId &&
    isRecentRun(activeStreamStartedAt);
  // The partial reply shown stays until the run saves the whole one.
  const keepPartialReply =
    replyFinishing && chat.messages.at(-1)?.id === activeStreamId;
  const handledDataRef = useRef<{ chatId: string; data: typeof data } | null>(
    null,
  );

  useEffect(() => {
    const handled = handledDataRef.current;
    if (handled?.chatId === chat.id && handled.data === data) return;
    handledDataRef.current = { chatId: chat.id, data };
    // The reply is saved only when the run ends, so data fetched mid-run (e.g.
    // on window focus) is behind the local messages. onFinish refetches once
    // the run ends, which brings in the saved reply.
    if (isRunActive || keepPartialReply) return;
    chat.setMessages(data ? convertToUIMessages(data) : []);
  }, [chat.id, chat.setMessages, data, isRunActive, keepPartialReply]);

  const resumeActiveRun = useCallback(async () => {
    if (!chatId || stoppedRef.current || resumingRef.current) return;

    resumingRef.current = true;
    interruptedRef.current = false;
    try {
      // Drop a stalled request first so two streams never write the reply.
      await chat.stop();
      await chat.resumeStream();
    } finally {
      resumingRef.current = false;
    }
    await mutate(chatMessagesKey(chatId, emailAccountId));
  }, [chat.resumeStream, chat.stop, chatId, emailAccountId, mutate]);

  // Reattach to a reply still running for this chat, e.g. after a reload or
  // when opening the chat mid-run, once its saved messages are shown.
  useEffect(() => {
    if (!activeStreamId || resumedStreamIdRef.current === activeStreamId)
      return;
    if (chat.status === "submitted" || chat.status === "streaming") return;
    if (chat.messages.at(-1)?.id === activeStreamId) return;

    resumedStreamIdRef.current = activeStreamId;
    resumeActiveRun();
  }, [activeStreamId, chat.messages, chat.status, resumeActiveRun]);

  // The server keeps no copy of a streaming reply (RD-3), so a dropped one
  // can't be reattached; its run still finishes and saves it. Until then the
  // chat says the reply is finishing and checks back for it.
  useEffect(() => {
    if (!replyFinishing || !chatId || !activeStreamId || !activeStreamStartedAt)
      return;
    const poll = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      mutate(chatMessagesKey(chatId, emailAccountId));
    }, FINISHING_POLL_MS);
    const deadline = setTimeout(
      () => setExpiredStreamId(activeStreamId),
      new Date(activeStreamStartedAt).getTime() + MAX_CHAT_RUN_MS - Date.now(),
    );
    return () => {
      clearInterval(poll);
      clearTimeout(deadline);
    };
  }, [
    activeStreamId,
    activeStreamStartedAt,
    chatId,
    emailAccountId,
    mutate,
    replyFinishing,
  ]);

  // Mobile browsers drop the connection of a backgrounded tab while the reply
  // keeps running, so reattach when the tab comes back.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        messagesAtHideRef.current = chat.messages;
        return;
      }

      const stalled =
        chat.status === "streaming" &&
        chat.messages === messagesAtHideRef.current;
      if (interruptedRef.current || stalled) resumeActiveRun();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [chat.messages, chat.status, resumeActiveRun]);

  useEffect(() => {
    inlineActionsRef.current = inlineActions;
  }, [inlineActions]);

  useEffect(() => {
    // A thread from another account means nothing to this account's chat.
    openThreadRef.current =
      openThread?.emailAccountId === emailAccountId ? openThread : null;
  }, [openThread, emailAccountId]);

  useEffect(() => {
    if (previousChatIdRef.current === chatId) return;

    previousChatIdRef.current = chatId;
    stoppedRef.current = false;
    interruptedRef.current = false;
    if (pendingRequestRef.current?.chatId === chatId) return;

    pendingInlineActionsRef.current = null;
    pendingRequestRef.current = null;
    pendingRequestContextRef.current = null;
    setInlineActions([]);
  }, [chatId]);

  // Moves the chat to another account. The conversation shown belongs to the
  // old one, so it is replaced by the chat to open, or a new one.
  const moveChatToAccount = useCallback(
    (accountId: string, nextChatId: string | null) => {
      setChatAccountIdParam(accountId === routeAccountId ? null : accountId);
      pendingInlineActionsRef.current = null;
      pendingRequestRef.current = null;
      pendingRequestContextRef.current = null;
      setChatId(nextChatId);
      chat.setMessages([]);
      setContext(null);
      setInlineActions([]);
    },
    [chat.setMessages, routeAccountId, setChatAccountIdParam, setChatId],
  );

  // The new conversation gets its id at once, so a question sent right after
  // the switch (e.g. "Continue in chat") has a chat to go to.
  const switchChatAccount = useCallback(
    (accountId: string) => {
      if (accountId === emailAccountId) return;
      moveChatToAccount(accountId, generateUUID());
    },
    [emailAccountId, moveChatToAccount],
  );

  const openChat = useCallback(
    (saved: { id: string; emailAccountId: string }) => {
      if (saved.emailAccountId === emailAccountId) {
        setChatId(saved.id);
        return;
      }
      moveChatToAccount(saved.emailAccountId, saved.id);
    },
    [emailAccountId, moveChatToAccount, setChatId],
  );

  // A thread opened from another account in All inboxes brings an empty
  // chat with it. A conversation already under way stays in its account, and
  // the chat offers the switch instead.
  const hasConversation =
    chat.messages.length > 0 || Boolean(data?.messages.length);
  // A saved chat whose messages haven't loaded may still hold a conversation.
  // Only a definite "not here" ends the wait; a failed request may be
  // retried, and the saved chat must survive it.
  const conversationUnknown =
    Boolean(chatId) && data === undefined && !isChatUnavailable(messagesError);
  const followEmailAccount = useCallback(
    (accountId: string) => {
      if (accountId === emailAccountId) return;
      if (!accountIds.includes(accountId)) return;
      if (isRunActive || hasConversation || conversationUnknown) return;
      moveChatToAccount(accountId, null);
    },
    [
      accountIds,
      conversationUnknown,
      emailAccountId,
      hasConversation,
      isRunActive,
      moveChatToAccount,
    ],
  );
  useEffect(() => {
    const threadKey = openThread
      ? `${openThread.emailAccountId}:${openThread.threadId}`
      : null;
    if (followedThreadRef.current === threadKey) return;
    if (conversationUnknown) return;
    followedThreadRef.current = threadKey;
    if (openThread) followEmailAccount(openThread.emailAccountId);
  }, [conversationUnknown, followEmailAccount, openThread]);

  useEffect(() => {
    if (!routeAccountId) return;

    if (previousRouteAccountIdRef.current === null) {
      previousRouteAccountIdRef.current = routeAccountId;
      return;
    }

    if (previousRouteAccountIdRef.current === routeAccountId) return;

    previousRouteAccountIdRef.current = routeAccountId;
    pendingInlineActionsRef.current = null;
    pendingRequestRef.current = null;
    pendingRequestContextRef.current = null;
    setChatAccountIdParam(null);
    setChatId(null);
    chat.setMessages([]);
    setInput("");
    setContext(null);
    setAttachments([]);
    setInlineActions([]);
  }, [chat.setMessages, routeAccountId, setChatAccountIdParam, setChatId]);

  useEffect(() => {
    if (!chatAccountMissing) return;
    setChatAccountIdParam(null);
    setChatId(null);
    chat.setMessages([]);
  }, [chat.setMessages, chatAccountMissing, setChatAccountIdParam, setChatId]);

  // Fix context is about one account's rules and mail, which in All inboxes
  // need not be the page's.
  const setContextForAccount = useCallback(
    (nextContext: MessageContext | null, options?: { accountId: string }) => {
      if (nextContext && options && options.accountId !== emailAccountId)
        moveChatToAccount(options.accountId, null);
      setContext(nextContext);
    },
    [emailAccountId, moveChatToAccount],
  );

  const sendMessageParts = useCallback(
    (parts: ChatMessagePart[]) => {
      const textLength = getChatTextLength(parts);
      const attachmentCount = parts.filter(
        (part) => part.type === "file",
      ).length;

      if (chatAccount?.account.disconnectedAt) {
        const message = `Reconnect ${chatAccount.email} to continue`;
        toastError({ description: message });
        throw new ChatInputValidationError(message);
      }

      if (textLength > ASSISTANT_CHAT_MAX_TEXT_LENGTH) {
        logger.warn("Assistant chat input rejected", {
          attachmentCount,
          chatId: chatId ?? chat.id,
          emailAccountId,
          failureCategory: "message_too_long",
          maxTextLength: ASSISTANT_CHAT_MAX_TEXT_LENGTH,
          statusCode: null,
          textLength,
        });
        logger.flush().catch(() => undefined);
        toastError({ description: ASSISTANT_CHAT_MAX_TEXT_LENGTH_MESSAGE });
        throw new ChatInputValidationError(
          ASSISTANT_CHAT_MAX_TEXT_LENGTH_MESSAGE,
        );
      }

      if (!chatId) setChatId(chat.id);
      stoppedRef.current = false;
      interruptedRef.current = false;

      const requestChatId = chatId ?? chat.id;
      const requestContext = context;
      pendingRequestRef.current = {
        attachmentCount,
        chatId: requestChatId,
        textLength,
      };
      pendingRequestContextRef.current = requestContext;
      pendingInlineActionsRef.current = inlineActionsRef.current.length
        ? inlineActionsRef.current
        : null;

      if (pendingInlineActionsRef.current) {
        setInlineActions([]);
      }

      const sendPromise = chat.sendMessage(
        { role: "user", parts },
        requestContext ? { body: { context: requestContext } } : undefined,
      );
      if (requestContext) {
        setContext((current) => (current === requestContext ? null : current));
      }

      return sendPromise;
    },
    [
      chat.id,
      chat.sendMessage,
      chatAccount,
      chatId,
      context,
      emailAccountId,
      setChatId,
    ],
  );

  const submitTextMessage = useCallback(
    async (text: string) => {
      const trimmedText = text.trim();
      if (!trimmedText) return;

      await sendMessageParts([{ type: "text", text: trimmedText }]);
      setInput("");
    },
    [sendMessageParts],
  );

  const stop = useCallback(async () => {
    stoppedRef.current = true;
    interruptedRef.current = false;
    if (!chatId) {
      await chat.stop();
      return;
    }

    // The reply's message id is its stream id; sending it keeps a late stop
    // from cancelling a newer reply.
    const lastMessage = chat.messages.at(-1);
    const activeStreamId =
      lastMessage?.role === "assistant" &&
      !persistedMessageIds.has(lastMessage.id)
        ? lastMessage.id
        : undefined;

    const stopRequest = fetch(`/api/chat/${chatId}/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [EMAIL_ACCOUNT_HEADER]: emailAccountId,
      },
      body: JSON.stringify({ activeStreamId }),
    });
    await chat.stop();

    try {
      const response = await stopRequest;
      if (!response.ok) throw new Error(`Status ${response.status}`);
    } catch (error) {
      logger.warn("Failed to stop assistant chat run", {
        chatId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    await mutate(chatMessagesKey(chatId, emailAccountId));
  }, [
    chat.messages,
    chat.stop,
    chatId,
    emailAccountId,
    mutate,
    persistedMessageIds,
  ]);

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    const submittedInput = input;
    const submittedAttachments = attachments;

    const fileParts = attachments.map((attachment) => ({
      type: "file" as const,
      url: attachment.url,
      filename: attachment.name,
      mediaType: attachment.contentType,
    }));

    const parts: ChatMessagePart[] = [...fileParts];

    if (text) {
      parts.push({ type: "text", text });
    }

    let sendPromise: Promise<void>;
    try {
      sendPromise = sendMessageParts(parts);
    } catch (error) {
      if (!(error instanceof ChatInputValidationError)) {
        reportChatRequestError({
          emailAccountId,
          error,
          fallbackChatId: chatId ?? chat.id,
          request: pendingRequestRef.current,
        });
      }
      return;
    }

    setAttachments([]);
    setInput("");
    sendPromise.catch(() => {
      setInput((current) =>
        current ? `${submittedInput}\n\n${current}` : submittedInput,
      );
      setAttachments((current) =>
        mergeAttachments(submittedAttachments, current),
      );
    });
  }, [attachments, chat.id, chatId, emailAccountId, input, sendMessageParts]);

  return (
    <ChatContext.Provider
      value={{
        chat,
        chatAccount,
        switchedAccount: emailAccountId !== routeAccountId,
        chatAccountError: chatAccount ? undefined : accountsError,
        openThreadAccountId:
          openThread && openThread.emailAccountId !== emailAccountId
            ? openThread.emailAccountId
            : null,
        switchChatAccount,
        followEmailAccount,
        openChat,
        chatId,
        input,
        persistedMessageIds,
        setInput,
        setChatId,
        setNewChat,
        submitTextMessage,
        handleSubmit,
        stop,
        replyFinishing,
        context,
        setContext: setContextForAccount,
        attachments,
        setAttachments,
        inputFocusRequested,
        requestInputFocus,
        clearInputFocusRequest,
      }}
    >
      <InlineEmailActionProvider value={{ queueAction: queueInlineAction }}>
        {children}
      </InlineEmailActionProvider>
    </ChatContext.Provider>
  );
}

export function useChat(): ChatContextType {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error("useChat must be used within a ChatProvider");
  }
  return context;
}

function isRecentRun(startedAt: Date | string | null) {
  if (!startedAt) return false;
  return Date.now() - new Date(startedAt).getTime() < MAX_CHAT_RUN_MS;
}

// NOTE: not sure why we don't just use the default from AI SDK
function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getChatTextLength(parts: ChatMessagePart[]) {
  return parts.reduce(
    (length, part) => length + (part.type === "text" ? part.text.length : 0),
    0,
  );
}

function mergeAttachments(
  submitted: Attachment[],
  current: Attachment[],
): Attachment[] {
  const currentIds = new Set(current.map((attachment) => attachment.id));
  return [
    ...submitted.filter((attachment) => !currentIds.has(attachment.id)),
    ...current,
  ];
}

class ChatInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatInputValidationError";
  }
}

function reportChatRequestError({
  emailAccountId,
  error,
  fallbackChatId,
  request,
}: {
  emailAccountId: string;
  error: unknown;
  fallbackChatId: string;
  request: PendingChatRequest | null;
}) {
  logger.error("Assistant chat request failed", {
    attachmentCount: request?.attachmentCount ?? 0,
    chatId: request?.chatId ?? fallbackChatId,
    emailAccountId,
    errorName: error instanceof Error ? error.name : "UnknownError",
    failureCategory: "request_error",
    statusCode: getErrorStatusCode(error),
    textLength: request?.textLength ?? 0,
  });
  logger.flush().catch(() => undefined);
  toastError({
    description:
      getRateLimitMessage(error) ??
      "We couldn't send your message. Please try again.",
  });
  console.error(error);
  // Hitting the rate limit is expected, not a bug to report.
  if (getErrorStatusCode(error) !== 429) captureException(error);
}

// The chat transport puts the server's response body on the error.
function getRateLimitMessage(error: unknown) {
  if (getErrorStatusCode(error) !== 429) return null;
  try {
    const body = JSON.parse(
      String((error as Record<string, unknown>).responseBody),
    );
    return typeof body?.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

// The SWR fetcher puts the response status on the error.
function isChatUnavailable(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const status = (error as Record<string, unknown>).status;
  return status === 403 || status === 404;
}

function getErrorStatusCode(error: unknown) {
  if (!error || typeof error !== "object") return null;

  const statusCode = (error as Record<string, unknown>).statusCode;
  return typeof statusCode === "number" ? statusCode : null;
}
