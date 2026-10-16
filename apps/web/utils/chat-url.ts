/** The open assistant chat, in any page's address. */
export const CHAT_ID_PARAM = "chatId";

/**
 * The account the open chat works in, when it isn't the page's (a chat
 * following a thread in All inboxes).
 */
export const CHAT_ACCOUNT_PARAM = "chatAccountId";

/**
 * Query parameters to drop from an address once the account list changes:
 * a chat whose account is gone can't be opened any more.
 */
export function staleChatParams(
  search: string,
  accountIds: readonly string[],
): string[] {
  const chatAccountId = new URLSearchParams(search).get(CHAT_ACCOUNT_PARAM);
  if (!chatAccountId || accountIds.includes(chatAccountId)) return [];
  return [CHAT_ACCOUNT_PARAM, CHAT_ID_PARAM];
}
