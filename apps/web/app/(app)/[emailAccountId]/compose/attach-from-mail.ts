import type { MessageAttachmentDescriptor } from "@inboxzero/mail-core/messages";
import {
  extractEmailAddress,
  extractNameFromEmail,
  isValidEmail,
  splitRecipientList,
} from "@/utils/email";

// Each recipient is its own query, and the list should still open on files.
const MAX_SENDERS = 3;

export type AttachFromMailSender = { email: string; label: string };

/**
 * Whose files Attach from mail lists first: the people the message is going
 * to, since a reply most often sends back something they sent.
 */
export function attachFromMailSenders({
  fields,
  ownAddresses,
}: {
  /** The composer's To, Cc and Bcc values. */
  fields: Array<string | undefined>;
  ownAddresses: string[];
}): AttachFromMailSender[] {
  const own = new Set(ownAddresses.map((address) => address.toLowerCase()));
  const senders: AttachFromMailSender[] = [];
  for (const recipient of fields.flatMap((field) =>
    splitRecipientList(field ?? ""),
  )) {
    const email = extractEmailAddress(recipient).toLowerCase();
    if (!isValidEmail(email) || own.has(email)) continue;
    if (senders.some((sender) => sender.email === email)) continue;
    const name = extractNameFromEmail(recipient).trim();
    senders.push({
      email,
      label: name && name.toLowerCase() !== email ? name : email,
    });
    if (senders.length === MAX_SENDERS) break;
  }
  return senders;
}

/**
 * The downloaded bytes as the file the composer attaches. The provider often
 * serves bytes with a generic type, so the type stored with the mail wins.
 */
export function toComposeFile(
  blob: Blob,
  {
    filename,
    mimeType,
  }: Pick<MessageAttachmentDescriptor, "filename" | "mimeType">,
) {
  return new File([blob], filename, { type: mimeType || blob.type });
}
