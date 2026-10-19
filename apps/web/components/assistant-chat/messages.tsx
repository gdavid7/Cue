import { Fragment, useMemo, useState, type ReactNode } from "react";
import { MessagePart } from "./message-part";
import { MessagingChannelHint } from "./messaging-channel-hint";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatMessage } from "@/components/assistant-chat/types";
import {
  EmailLookupProvider,
  type EmailLookup,
} from "@/components/assistant-chat/email-lookup-context";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Loader } from "@/components/ai-elements/loader";

interface MessagesProps {
  footer?: ReactNode;
  isArtifactVisible: boolean;
  messages: Array<ChatMessage>;
  persistedMessageIds: Set<string>;
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  /** The reply runs on the server but isn't streaming here. */
  replyFinishing?: boolean;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  status: UseChatHelpers<ChatMessage>["status"];
}

export function Messages({
  status,
  messages,
  persistedMessageIds,
  replyFinishing = false,
  footer,
}: MessagesProps) {
  const isAnswering = status === "streaming" || status === "submitted";
  const disableConfirm = isAnswering;
  // "Cue replied" only follows an answer seen here, not a loaded history.
  const [hasAnswered, setHasAnswered] = useState(false);
  if (isAnswering && !hasAnswered) setHasAnswered(true);
  let answerStatus = "";
  if (isAnswering) answerStatus = "Cue is thinking…";
  else if (replyFinishing) answerStatus = "Cue's reply is finishing…";
  else if (hasAnswered && status === "ready") answerStatus = "Cue replied";
  const emailLookup = useMemo(() => buildEmailLookup(messages), [messages]);
  const firstAssistantIndex = useMemo(
    () => messages.findIndex((m) => m.role === "assistant"),
    [messages],
  );

  return (
    <EmailLookupProvider value={emailLookup}>
      <Conversation className="flex min-w-0 flex-1">
        <ConversationContent
          className="mx-auto flex min-h-full flex-col max-w-[calc(var(--chat-max-w)+var(--chat-px)*2)] px-[var(--chat-px)] pt-0 pb-0"
          scrollClassName="![scrollbar-gutter:auto] scrollbar-thin"
        >
          {/* Silent while an answer streams: Markdown re-renders on every
              chunk, which screen readers read as repeated fragments. */}
          <div
            aria-live={isAnswering ? "off" : "polite"}
            className="flex flex-1 flex-col gap-4"
            role="log"
          >
            {messages.map((message, index) => (
              <Fragment key={message.id}>
                <Message from={message.role}>
                  <MessageContent variant="flat">
                    {message.parts?.map((part, partIndex) => (
                      <MessagePart
                        key={`${message.id}-${partIndex}`}
                        part={part}
                        isStreaming={
                          status === "streaming" &&
                          partIndex === message.parts.length - 1
                        }
                        disableConfirm={disableConfirm}
                        isPersistedMessage={persistedMessageIds.has(message.id)}
                        messageId={message.id}
                        partIndex={partIndex}
                        threadLookup={emailLookup}
                      />
                    ))}
                  </MessageContent>
                </Message>
                {index === firstAssistantIndex && <MessagingChannelHint />}
              </Fragment>
            ))}

            {status === "submitted" &&
              messages.length > 0 &&
              messages[messages.length - 1].role === "user" && (
                <Message from="assistant">
                  <MessageContent variant="flat">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Loader />
                      <span>Thinking...</span>
                    </div>
                  </MessageContent>
                </Message>
              )}
            {replyFinishing && !isAnswering && (
              <Message from="assistant">
                <MessageContent variant="flat">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader />
                    <span>Reply finishing…</span>
                  </div>
                </MessageContent>
              </Message>
            )}
          </div>
          <div className="sr-only" role="status">
            {answerStatus}
          </div>

          <div className="h-8 shrink-0" />

          {footer && (
            <div className="sticky bottom-0 z-10 pb-4 md:pb-6 pointer-events-none [&>*]:pointer-events-auto relative">
              <ConversationScrollButton wrapperClassName="absolute bottom-full left-1/2 -translate-x-1/2 mb-2" />
              {footer}
            </div>
          )}
        </ConversationContent>
      </Conversation>
    </EmailLookupProvider>
  );
}

function buildEmailLookup(messages: Array<ChatMessage>): EmailLookup {
  const lookup: EmailLookup = new Map();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (
        part.type === "tool-searchInbox" &&
        part.state === "output-available"
      ) {
        const output = part.output as Record<string, unknown> | undefined;
        const items = output?.messages as
          | Array<{
              messageId: string;
              threadId: string;
              from: string;
              subject: string;
              snippet: string;
              date: string;
              isUnread: boolean;
              externalUrl?: string;
              account?: string;
            }>
          | undefined;
        if (!items) continue;
        for (const item of items) {
          if (!lookup.has(item.threadId)) {
            lookup.set(item.threadId, {
              messageId: item.messageId,
              from: item.from,
              subject: item.subject,
              snippet: item.snippet,
              date: item.date,
              isUnread: item.isUnread,
              externalUrl: item.externalUrl,
              account: item.account,
            });
          }
        }
      }
    }
  }
  return lookup;
}
