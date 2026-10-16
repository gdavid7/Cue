"use client";

import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronDownIcon,
  HistoryIcon,
  Loader2,
  PaperclipIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { Messages } from "./messages";
import { PreviewAttachment } from "./preview-attachment";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChats } from "@/hooks/useChats";
import { LoadingContent } from "@/components/LoadingContent";
import { Tooltip } from "@/components/Tooltip";
import { useChat } from "@/providers/ChatProvider";
import type { Attachment } from "@/providers/ChatProvider";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatMessage } from "@/components/assistant-chat/types";
import type { MessageContext } from "@/utils/ai/assistant/chat-context-validation";
import { useProductAnalytics } from "@/hooks/useProductAnalytics";
import { ChatHistoryItem } from "@/components/assistant-chat/ChatHistoryItem";
import {
  type ChatHistoryEntry,
  getChatHistoryLabel,
} from "@/components/assistant-chat/chat-history-types";
import { RenameChatDialog } from "@/components/assistant-chat/RenameChatDialog";
import { DeleteChatDialog } from "@/components/assistant-chat/DeleteChatDialog";
import { randomUuid } from "@/utils/uuid";
import { VoiceInput } from "@/components/voice/VoiceInput";
import { liveHistoryFromUiMessages } from "@/utils/voice/live-history";
import { PageHeading } from "@/components/Typography";
import { useAccounts } from "@/hooks/useAccounts";
import { EmailAccountScopeProvider } from "@/providers/EmailAccountProvider";
import { getPermissionsConsentPath } from "@/utils/permissions-consent";

const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4MB
const MAX_FILES = 5;
const ACCEPTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

export function Chat({
  open,
  onClose,
  topBarStart,
}: {
  open: boolean;
  onClose?: () => void;
  topBarStart?: React.ReactNode;
}) {
  const analytics = useProductAnalytics("assistant_chat");
  const {
    chat,
    chatId,
    input,
    persistedMessageIds,
    setInput,
    handleSubmit,
    setNewChat,
    context,
    setContext,
    attachments,
    setAttachments,
    submitTextMessage,
    stop,
    chatAccount,
  } = useChat();
  const { messages, status, regenerate, setMessages } = chat;
  // Tools would run on the dead account's tokens, so the chat is read-only.
  const readOnly = Boolean(chatAccount?.account.disconnectedAt);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadQueue, setUploadQueue] = useState<string[]>([]);

  useEffect(() => {
    if (open && !chatId && status === "ready" && messages.length === 0) {
      setNewChat();
    }
  }, [open, chatId, messages.length, setNewChat, status]);

  // Must run before the save effect below, which would overwrite the draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only run on mount
  useEffect(() => {
    const savedInput = readDraftInput();
    if (savedInput) setInput(savedInput);
  }, []);

  // Persist without setting state: a state update here queued an extra render
  // per keystroke, and fast text entry tripped React's update-depth guard.
  useEffect(() => {
    saveDraftInput(input);
  }, [input]);

  const readFileAsDataUrl = useCallback(
    (file: File): Promise<Attachment | undefined> =>
      new Promise((resolve) => {
        if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
          resolve(undefined);
          return;
        }
        if (file.size > MAX_FILE_SIZE) {
          resolve(undefined);
          return;
        }

        const reader = new FileReader();
        reader.onload = () => {
          resolve({
            id: randomUuid(),
            name: file.name,
            url: reader.result as string,
            contentType: file.type,
          });
        };
        reader.onerror = () => resolve(undefined);
        reader.readAsDataURL(file);
      }),
    [],
  );

  const processIncomingFiles = useCallback(
    async (files: File[]) => {
      const remaining = MAX_FILES - attachments.length;
      const filesToProcess = files.slice(0, remaining);

      setUploadQueue(filesToProcess.map((f) => f.name));

      const results = await Promise.all(filesToProcess.map(readFileAsDataUrl));
      const valid = results.filter((a): a is Attachment => a !== undefined);

      analytics.captureAction("chat_attachments_added", {
        requested_file_count: files.length,
        accepted_file_count: valid.length,
        existing_attachment_count: attachments.length,
      });
      setAttachments((prev) => [...prev, ...valid]);
      setUploadQueue([]);
    },
    [analytics, attachments.length, readFileAsDataUrl, setAttachments],
  );

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);
      if (files.length === 0) return;

      await processIncomingFiles(files);

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [processIncomingFiles],
  );

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;

      const imageFiles = Array.from(items)
        .filter((item) => item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);

      if (imageFiles.length === 0) return;

      event.preventDefault();
      await processIncomingFiles(imageFiles);
    },
    [processIncomingFiles],
  );

  const hasMessages = messages.length > 0;
  const hasContent =
    input.trim().length > 0 || attachments.length > 0 || !!context;

  const inputArea = (
    <PromptInput
      onSubmit={(e) => {
        e.preventDefault();
        if (
          !readOnly &&
          hasContent &&
          (status === "ready" || status === "error")
        ) {
          analytics.captureAction("chat_message_submitted", {
            has_text: input.trim().length > 0,
            attachment_count: attachments.length,
            has_context: Boolean(context),
            message_count: messages.length,
          });
          handleSubmit();
        }
      }}
    >
      {(attachments.length > 0 || uploadQueue.length > 0) && (
        <div className="flex gap-2 overflow-x-auto p-2 pb-0">
          {attachments.map((attachment) => (
            <PreviewAttachment
              key={attachment.id}
              attachment={attachment}
              onRemove={() =>
                setAttachments((prev) => prev.filter((a) => a !== attachment))
              }
            />
          ))}
          {uploadQueue.map((name) => (
            <PreviewAttachment
              key={name}
              attachment={{ name, url: "", contentType: "" }}
              isUploading
            />
          ))}
        </div>
      )}

      <PromptInputTextarea
        // The placeholder disappears once the user types.
        aria-label="Message Cue"
        data-testid="chat-input"
        value={input}
        disabled={readOnly}
        placeholder="Ask Cue about your mail, or tell it what to do"
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
          setInput(e.currentTarget.value)
        }
        onPaste={handlePaste}
        // The controls get their own row on a phone instead of a column
        // that would leave the text a third of the width.
        className="sm:pr-48"
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={handleFileChange}
        tabIndex={-1}
      />

      {/* Their own row on a phone has room for 44px touch targets. */}
      <div className="flex items-center justify-end gap-1 px-2 pb-2 max-sm:[&_button]:size-11 sm:absolute sm:right-2 sm:bottom-2 sm:p-0">
        <VoiceInput
          liveEnabled
          liveHistory={liveHistoryFromUiMessages(messages)}
          onInsert={(text) => {
            setInput(input.trim() ? `${input.trim()} ${text}` : text);
          }}
          onSend={(text) => {
            analytics.captureAction("chat_message_submitted", {
              has_text: true,
              attachment_count: attachments.length,
              has_context: Boolean(context),
              message_count: messages.length,
              via_voice: true,
            });
            submitTextMessage(text).catch(() => undefined);
          }}
        />
        <Tooltip content="Attach images">
          <Button
            type="button"
            variant="ghostMuted"
            size="icon"
            aria-label="Attach images"
            className="size-9 rounded-full"
            onClick={() => {
              analytics.captureAction("chat_attach_button_clicked", {
                attachment_count: attachments.length,
              });
              fileInputRef.current?.click();
            }}
            disabled={attachments.length >= MAX_FILES}
          >
            <PaperclipIcon className="size-4" />
          </Button>
        </Tooltip>

        <PromptInputSubmit
          status={
            status === "streaming"
              ? "streaming"
              : status === "submitted"
                ? "submitted"
                : "ready"
          }
          disabled={
            status === "ready" || status === "error"
              ? readOnly || !hasContent
              : false
          }
          onClick={(e) => {
            if (status === "streaming" || status === "submitted") {
              analytics.captureAction("chat_generation_stopped", {
                status,
              });
              e.preventDefault();
              stop();
              setMessages((messages) => messages);
            }
          }}
        />
      </div>
    </PromptInput>
  );

  return (
    <div
      className="flex h-full min-w-0 flex-col"
      style={
        {
          "--chat-px": "1.5rem",
          "--chat-max-w": "800px",
        } as React.CSSProperties
      }
    >
      <ChatTopBar
        hasMessages={hasMessages}
        onClose={onClose}
        start={topBarStart}
      />
      <ChatAccountNotice />
      {hasMessages ? (
        // Cards and actions in the conversation act in the chat's account,
        // which in All inboxes may not be the page's.
        <EmailAccountScopeProvider emailAccount={chatAccount ?? undefined}>
          <ChatMessagesView
            status={status}
            messages={messages}
            persistedMessageIds={persistedMessageIds}
            setMessages={setMessages}
            regenerate={regenerate}
            context={context}
            setContext={setContext}
            inputArea={inputArea}
          />
        </EmailAccountScopeProvider>
      ) : (
        <NewChatView
          inputArea={inputArea}
          readOnly={readOnly}
          onSuggestionClick={(text) => {
            analytics.captureAction("chat_suggestion_clicked", {
              suggestion_index: CHAT_EXAMPLES.indexOf(text),
            });
            chat.sendMessage({
              role: "user",
              parts: [{ type: "text", text }],
            });
            saveDraftInput("");
          }}
        />
      )}
    </div>
  );
}

function ChatMessagesView({
  status,
  messages,
  persistedMessageIds,
  setMessages,
  regenerate,
  context,
  setContext,
  inputArea,
}: {
  status: UseChatHelpers<ChatMessage>["status"];
  messages: ChatMessage[];
  persistedMessageIds: Set<string>;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  context: MessageContext | null;
  setContext: (context: MessageContext | null) => void;
  inputArea: React.ReactNode;
}) {
  return (
    <>
      <div className="pointer-events-none h-2 -mb-2 z-10 bg-gradient-to-b from-background to-transparent" />
      <Messages
        status={status}
        messages={messages}
        persistedMessageIds={persistedMessageIds}
        setMessages={setMessages}
        regenerate={regenerate}
        isArtifactVisible={false}
        footer={
          <>
            {context ? (
              <div className="mb-2 flex items-center gap-2">
                <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                  Fix: {context.message.headers.subject.slice(0, 60)}
                  {context.message.headers.subject.length > 60 ? "..." : ""}
                  <button
                    type="button"
                    aria-label="Remove context"
                    className="ml-1 rounded p-0.5 hover:bg-muted-foreground/10"
                    onClick={() => setContext(null)}
                  >
                    ×
                  </button>
                </span>
              </div>
            ) : null}
            <div className="relative z-10">{inputArea}</div>
            <div className="absolute w-full bottom-0 h-20 bg-background pointer-events-none" />
          </>
        }
      />
    </>
  );
}

const CHAT_EXAMPLES = [
  "Help me handle my inbox today",
  "What still needs my reply?",
  "What's on my calendar this week?",
  "Show me my rules and what they do",
];

function NewChatView({
  inputArea,
  readOnly,
  onSuggestionClick,
}: {
  inputArea: React.ReactNode;
  readOnly: boolean;
  onSuggestionClick: (text: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-[var(--chat-px)]">
      <div className="w-full max-w-[var(--chat-max-w)]">
        <PageHeading className="mb-6 text-center">Chat with Cue</PageHeading>
        {inputArea}
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {CHAT_EXAMPLES.map((example) => (
            <Button
              key={example}
              variant="outline"
              size="sm"
              className="rounded-full"
              disabled={readOnly}
              onClick={() => onSuggestionClick(example)}
            >
              {example}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ChatTopBar({
  hasMessages,
  onClose,
  start,
}: {
  hasMessages: boolean;
  onClose?: () => void;
  start?: React.ReactNode;
}) {
  return (
    <div className="relative mx-auto w-full max-w-[calc(var(--chat-max-w)+var(--chat-px)*2)] px-[var(--chat-px)] pt-2">
      <div className="flex min-w-0 items-center gap-1">
        {start}
        <ChatAccountLabel />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {hasMessages ? <NewChatButton /> : null}
          <ChatHistoryDropdown />
          {onClose ? <CloseChatButton onClose={onClose} /> : null}
        </div>
      </div>
    </div>
  );
}

function NewChatButton() {
  const { setNewChat } = useChat();

  return (
    <Tooltip content="Start a new conversation">
      <Button variant="ghost" size="icon" onClick={setNewChat}>
        <PlusIcon className="size-5" />
        <span className="sr-only">New Chat</span>
      </Button>
    </Tooltip>
  );
}

function CloseChatButton({ onClose }: { onClose: () => void }) {
  return (
    <Tooltip content="Close assistant">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onClose}
        aria-label="Close assistant"
      >
        <XIcon className="size-5" aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}

function ChatHistoryDropdown() {
  const [shouldLoadChats, setShouldLoadChats] = useState(false);
  const [open, setOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ChatHistoryEntry | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<ChatHistoryEntry | null>(
    null,
  );
  const { chatId, setChatId, openChat } = useChat();
  const { data, error, isLoading, mutate } = useChats(shouldLoadChats);

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (value) setShouldLoadChats(true);
        }}
      >
        <Tooltip content="View previous conversations">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onMouseEnter={() => setShouldLoadChats(true)}
              onClick={() => {
                setShouldLoadChats(true);
                mutate();
              }}
            >
              <HistoryIcon className="size-5" />
              <span className="sr-only">Chat History</span>
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-72">
          <LoadingContent
            loading={isLoading}
            error={error}
            loadingComponent={
              <DropdownMenuItem
                disabled
                className="flex items-center justify-center"
              >
                <Loader2 className="mr-2 size-4 animate-spin" />
                Loading chats...
              </DropdownMenuItem>
            }
            errorComponent={
              <DropdownMenuItem disabled>Error loading chats</DropdownMenuItem>
            }
          >
            {data && data.chats.length > 0 ? (
              data.chats.map((chatItem) => (
                <ChatHistoryItem
                  key={chatItem.id}
                  chat={chatItem}
                  onSelect={() => {
                    setOpen(false);
                    openChat({
                      id: chatItem.id,
                      emailAccountId: chatItem.emailAccountId,
                    });
                  }}
                  onRename={() => {
                    setOpen(false);
                    setRenameTarget(chatItem);
                  }}
                  onDelete={() => {
                    setOpen(false);
                    setDeleteTarget(chatItem);
                  }}
                />
              ))
            ) : (
              <DropdownMenuItem disabled>
                No previous chats found
              </DropdownMenuItem>
            )}
          </LoadingContent>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameChatDialog
        open={renameTarget !== null}
        onOpenChange={(value) => {
          if (!value) setRenameTarget(null);
        }}
        chatId={renameTarget?.id ?? ""}
        emailAccountId={renameTarget?.emailAccountId ?? ""}
        currentName={renameTarget?.name ?? ""}
        defaultLabel={renameTarget ? getChatHistoryLabel(renameTarget) : ""}
        onRenamed={mutate}
      />
      <DeleteChatDialog
        open={deleteTarget !== null}
        onOpenChange={(value) => {
          if (!value) setDeleteTarget(null);
        }}
        chatId={deleteTarget?.id ?? ""}
        emailAccountId={deleteTarget?.emailAccountId ?? ""}
        label={deleteTarget ? getChatHistoryLabel(deleteTarget) : ""}
        onDeleted={() => {
          if (deleteTarget && chatId === deleteTarget.id) setChatId(null);
          mutate();
        }}
      />
    </>
  );
}

/** Which account the chat reads and acts in, and a way to change it. */
function ChatAccountLabel() {
  const { chatAccount, switchChatAccount } = useChat();
  const { data } = useAccounts();
  if (!chatAccount) return null;

  const label = `Chat for ${chatAccount.email}`;
  const otherAccounts =
    data?.emailAccounts.filter((account) => account.id !== chatAccount.id) ??
    [];
  if (!otherAccounts.length) {
    return (
      <span className="min-w-0 truncate px-2 text-muted-foreground text-xs">
        {label}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 gap-1 px-2 font-normal text-muted-foreground text-xs"
        >
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-3 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {otherAccounts.map((account) => (
          <DropdownMenuItem
            key={account.id}
            disabled={Boolean(account.account.disconnectedAt)}
            onSelect={() => switchChatAccount(account.id)}
          >
            <span className="truncate">{account.email}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChatAccountNotice() {
  const {
    chatAccount,
    openThreadAccountId,
    switchChatAccount,
    switchedAccount,
  } = useChat();
  const { data } = useAccounts();
  if (!chatAccount) return null;

  let notice: React.ReactNode = null;
  if (chatAccount.account.disconnectedAt) {
    notice = (
      <>
        <span>Reconnect {chatAccount.email} to continue</span>
        <Button asChild size="xs-2" variant="outline">
          <Link
            href={getPermissionsConsentPath(chatAccount.id, { expired: true })}
          >
            Reconnect
          </Link>
        </Button>
      </>
    );
  } else if (openThreadAccountId) {
    const threadEmail = data?.emailAccounts.find(
      (account) => account.id === openThreadAccountId,
    )?.email;
    if (!threadEmail) return null;
    notice = (
      <>
        <span>The open email is in {threadEmail}</span>
        <Button
          size="xs-2"
          variant="outline"
          onClick={() => switchChatAccount(openThreadAccountId)}
        >
          Switch
        </Button>
      </>
    );
  } else if (switchedAccount) {
    notice = <span>Switched to {chatAccount.email} for this conversation</span>;
  }
  if (!notice) return null;

  return (
    <div className="mx-auto w-full max-w-[calc(var(--chat-max-w)+var(--chat-px)*2)] px-[var(--chat-px)]">
      <div
        role="status"
        className="flex min-w-0 flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-muted-foreground text-xs"
      >
        {notice}
      </div>
    </div>
  );
}

const DRAFT_INPUT_STORAGE_KEY = "input";

function readDraftInput(): string {
  try {
    const stored = window.localStorage.getItem(DRAFT_INPUT_STORAGE_KEY);
    const value: unknown = stored ? JSON.parse(stored) : "";
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function saveDraftInput(value: string) {
  try {
    window.localStorage.setItem(DRAFT_INPUT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be full or blocked; the draft just won't survive a reload.
  }
}
