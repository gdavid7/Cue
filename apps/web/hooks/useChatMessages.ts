import useSWR from "swr";
import type { GetChatResponse } from "@/app/api/chats/[chatId]/route";

/**
 * A chat is read from whichever of the user's accounts the page is in: it
 * covers all of them, and its account is in the response.
 */
export function chatMessagesKey(chatId: string) {
  return `/api/chats/${chatId}`;
}

export function useChatMessages(chatId: string | null) {
  return useSWR<GetChatResponse>(chatId ? chatMessagesKey(chatId) : null);
}
