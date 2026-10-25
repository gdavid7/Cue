import { extractEmailAddress } from "@/utils/email";
import { getMessageTimestamp } from "@/utils/email/message-timestamp";
import type { ParsedMessage } from "@/utils/types";

export type ThreadHeadline = {
  subject: string;
  from: string;
  snippet: string;
};

/**
 * A conversation's subject and preview, from its newest message, and the
 * newest sender who isn't the account itself: a muted thread the user last
 * replied to still reads as the person they were talking with.
 */
export function pickThreadHeadline({
  messages,
  ownEmail,
  isDraft,
}: {
  messages: ParsedMessage[];
  ownEmail: string;
  isDraft: (message: ParsedMessage) => boolean;
}): ThreadHeadline | null {
  const newestFirst = messages
    .filter((message) => !isDraft(message))
    .sort((a, b) => getMessageTimestamp(b) - getMessageTimestamp(a));
  const newest = newestFirst[0];
  if (!newest) return null;

  const own = extractEmailAddress(ownEmail).toLowerCase();
  const sender =
    newestFirst.find(
      (message) =>
        extractEmailAddress(message.headers.from).toLowerCase() !== own,
    ) ?? newest;

  return {
    subject: newest.headers.subject || newest.subject || "",
    from: sender.headers.from || "",
    snippet: newest.snippet || "",
  };
}
