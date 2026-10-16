import type { ParsedMessageHeaders } from "@/utils/types";
import { extractEmailAddress, splitRecipientList } from "@/utils/email";

export interface ReplyAllRecipients {
  cc: string[];
  to: string;
}

/**
 * Builds reply-all recipients by including original TO and CC recipients.
 * The reply goes to the original sender, and CC includes all other recipients.
 *
 * @param headers - Original email headers
 * @param overrideTo - Optional override for the TO field (e.g., for drafts)
 * @param currentUserEmails - Current user's email addresses to exclude from CC
 * @returns Object with TO and CC recipients for reply-all
 */
export function buildReplyAllRecipients(
  headers: ParsedMessageHeaders,
  overrideTo: string | undefined,
  currentUserEmails: string | string[],
): ReplyAllRecipients {
  // Determine the primary recipient (TO field)
  const replyToRaw = overrideTo || headers["reply-to"] || headers.from;
  const replyTo = extractEmailAddress(replyToRaw);

  const currentUserEmailSet = new Set(
    (Array.isArray(currentUserEmails) ? currentUserEmails : [currentUserEmails])
      .map((email) => extractEmailAddress(email).toLowerCase())
      .filter(Boolean),
  );

  // Build CC list for reply-all behavior
  const ccSet = new Set<string>();
  const seenEmails = new Set<string>();

  addHeaderRecipientsToCcSet({
    headerValue: headers.cc,
    replyTo,
    currentUserEmailSet,
    seenEmails,
    ccSet,
  });
  addHeaderRecipientsToCcSet({
    headerValue: headers.to,
    replyTo,
    currentUserEmailSet,
    seenEmails,
    ccSet,
  });

  return {
    to: replyToRaw, // Keep the original format for the TO field
    cc: Array.from(ccSet),
  };
}

/**
 * Recipients the inline composer opens with. Following up on your own message
 * keeps its recipients; replying to someone else goes back to them, and reply
 * all also copies everyone else on the message except you. "You" is every
 * address the user has connected, not only the one replying.
 */
export function buildComposeReplyRecipients({
  headers,
  sentFromUser,
  replyAll,
  ownEmails,
}: {
  headers: ParsedMessageHeaders;
  sentFromUser: boolean;
  replyAll: boolean;
  ownEmails: string[];
}): { to: string; cc: string; bcc: string } {
  if (sentFromUser) {
    return { to: headers.to, cc: headers.cc ?? "", bcc: headers.bcc ?? "" };
  }
  if (!replyAll) return { to: headers.from, cc: headers.cc ?? "", bcc: "" };

  const recipients = buildReplyAllRecipients(headers, undefined, ownEmails);
  const ownKeys = new Set(ownEmails.map(addressKey));
  const isOwn = (recipient: string) => ownKeys.has(addressKey(recipient));

  // Sent from another of the user's mailboxes: reply all to everyone else.
  if (isOwn(recipients.to)) {
    const to = splitRecipientList(headers.to).filter(
      (recipient) => !isOwn(recipient),
    );
    if (to.length) {
      const toKeys = new Set(to.map(addressKey));
      return {
        to: to.join(", "),
        cc: recipients.cc
          .filter((recipient) => !toKeys.has(addressKey(recipient)))
          .join(", "),
        bcc: "",
      };
    }
    // Only the user was on To, so the people copied become the recipients.
    if (recipients.cc.length)
      return { to: recipients.cc.join(", "), cc: "", bcc: "" };
  }

  return { to: recipients.to, cc: recipients.cc.join(", "), bcc: "" };
}

/** Reply all only means something when someone besides the sender and you is on it. */
export function hasReplyAllRecipients(
  headers: ParsedMessageHeaders,
  ownEmails: string[],
) {
  return buildReplyAllRecipients(headers, undefined, ownEmails).cc.length > 0;
}

/**
 * Converts array of CC recipients to a comma-separated string.
 * Returns undefined if the array is empty.
 */
export function formatCcList(ccList: string[]): string | undefined {
  return ccList.length > 0 ? ccList.join(", ") : undefined;
}

/**
 * Merges manual CC/BCC recipients with existing recipients,
 * ensuring deduplication and sanitization.
 */
export function mergeAndDedupeRecipients(
  existing: string[],
  manual: string | undefined,
): string[] {
  const result = [...existing];
  const seen = new Set(
    existing.map((e) => extractEmailAddress(e).toLowerCase()),
  );

  if (manual) {
    const manualEntries = splitRecipientList(manual);

    for (const entry of manualEntries) {
      const email = extractEmailAddress(entry);
      if (email) {
        const key = email.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          result.push(entry);
        }
      }
    }
  }

  return result;
}

function addressKey(recipient: string) {
  return extractEmailAddress(recipient).toLowerCase();
}

function addHeaderRecipientsToCcSet({
  headerValue,
  replyTo,
  currentUserEmailSet,
  seenEmails,
  ccSet,
}: {
  headerValue: string | undefined;
  replyTo: string;
  currentUserEmailSet: Set<string>;
  seenEmails: Set<string>;
  ccSet: Set<string>;
}) {
  if (!headerValue) return;

  const headerEmails = splitRecipientList(headerValue)
    .map((entry) => extractEmailAddress(entry))
    .filter((email) => {
      if (!email) return false;

      const normalizedEmail = email.toLowerCase();
      return (
        normalizedEmail !== replyTo.toLowerCase() &&
        !currentUserEmailSet.has(normalizedEmail)
      );
    });

  for (const email of headerEmails) {
    const key = email.toLowerCase();
    if (!seenEmails.has(key)) {
      seenEmails.add(key);
      ccSet.add(email);
    }
  }
}
