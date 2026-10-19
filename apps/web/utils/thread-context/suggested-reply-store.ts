import type { GetSuggestedReplyResponse } from "@/app/api/user/suggested-reply/route";
import { createBrowserCache } from "@/utils/browser-cache";

/**
 * Suggested replies this browser was given, kept per conversation's newest
 * message and per pass: the server keeps none (RD-3). A new message gets a
 * fresh suggestion; a day later the context it was checked against may have
 * changed, so it is worked out again.
 */
export const keptSuggestions = createBrowserCache<GetSuggestedReplyResponse>({
  name: "suggested-reply",
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 150,
});

export function suggestionKey({
  threadId,
  messageId,
  web,
}: {
  threadId: string;
  messageId: string;
  web: boolean;
}) {
  return `${threadId}:${messageId}:${web ? "web" : "plain"}`;
}

/** The answer the reader shows for a message: the web pass's when there was one. */
export function keptSuggestionFor({
  emailAccountId,
  threadId,
  messageId,
}: {
  emailAccountId: string;
  threadId: string;
  messageId: string;
}) {
  const kept = (web: boolean) =>
    keptSuggestions.get(
      emailAccountId,
      suggestionKey({ threadId, messageId, web }),
    );
  return (kept(true) ?? kept(false))?.suggestion ?? null;
}
