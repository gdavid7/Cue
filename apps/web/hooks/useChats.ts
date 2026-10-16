import useSWR from "swr";
import type { GetUserChatsResponse } from "@/app/api/user/chats/route";

/** Every account's chats, newest first, each labelled with its account. */
export function useChats(shouldFetch: boolean) {
  return useSWR<GetUserChatsResponse>(shouldFetch ? "/api/user/chats" : null);
}
