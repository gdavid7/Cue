import useSWR from "swr";
import type { GetChatResponse } from "@/app/api/chats/[chatId]/route";

/** A chat is read through the account it belongs to, which may not be the page's. */
export function chatMessagesKey(chatId: string, emailAccountId: string) {
  return [`/api/chats/${chatId}`, emailAccountId] as const;
}

export function useChatMessages(chatId: string | null, emailAccountId: string) {
  return useSWR<GetChatResponse>(
    chatId && emailAccountId ? chatMessagesKey(chatId, emailAccountId) : null,
  );
}
