import type { GetUserChatsResponse } from "@/app/api/user/chats/route";

export type ChatHistoryEntry = GetUserChatsResponse["chats"][number];

export function getChatHistoryLabel(
  chat: Pick<ChatHistoryEntry, "name" | "createdAt">,
): string {
  return chat.name ?? `Chat from ${new Date(chat.createdAt).toLocaleString()}`;
}
