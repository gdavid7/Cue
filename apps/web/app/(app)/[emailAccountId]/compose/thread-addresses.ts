import { GmailLabel } from "@/utils/gmail/label";
import type { ParsedMessageHeaders } from "@/utils/types";

type ThreadAddressMessage = {
  headers: Pick<ParsedMessageHeaders, "from" | "to" | "cc" | "reply-to">;
  labelIds?: string[] | null;
};

/**
 * What the pre-send check can learn from messages already loaded in the
 * thread, without asking the provider: everyone who was on it, and the
 * addresses the user wrote from, which are send-as aliases when they differ
 * from the account's own. Unsent drafts count for neither.
 */
export function getThreadAddresses(messages: ThreadAddressMessage[]) {
  const sent = messages.filter(
    (message) => !message.labelIds?.includes(GmailLabel.DRAFT),
  );
  return {
    // The whole thread on purpose: someone re-added after being dropped
    // earlier is not a new recipient, so they raise no warning.
    participants: sent
      .flatMap(({ headers }) => [
        headers.from,
        headers.to,
        headers.cc,
        headers["reply-to"],
      ])
      .filter(Boolean)
      .join(","),
    // Outlook gives SENT to anything in Sent Items, so a received message the
    // user moved there is skipped: it sits in the inbox or has no recipients.
    sentFrom: sent
      .filter(
        (message) =>
          message.labelIds?.includes(GmailLabel.SENT) &&
          !message.labelIds.includes(GmailLabel.INBOX) &&
          (message.headers.to || message.headers.cc),
      )
      .map((message) => message.headers.from)
      .join(","),
  };
}
