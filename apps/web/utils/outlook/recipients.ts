import type { Recipient } from "@microsoft/microsoft-graph-types";
import {
  extractEmailAddress,
  extractNameFromEmail,
  splitRecipientList,
} from "@/utils/email";
import type { Logger } from "@/utils/logger";

// Graph needs one entry per recipient. Callers pass the same comma-separated
// string the Gmail RFC-822 path accepts, so split it rather than sending the
// whole list as a single malformed address.
export function toGraphRecipients(
  recipientList: string | undefined,
  logger: Logger,
): Recipient[] {
  const recipients: Recipient[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of splitRecipientList(recipientList ?? "")) {
    const address = extractEmailAddress(candidate);
    if (!address) {
      dropped.push(candidate);
      continue;
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const name = extractNameFromEmail(candidate).trim();
    recipients.push({
      emailAddress: {
        address,
        ...(name && name !== address ? { name } : {}),
      },
    });
  }

  if (dropped.length > 0) {
    logger.warn("Dropped recipients without a parseable email address", {
      droppedCount: dropped.length,
    });
    logger.trace("Dropped malformed recipients", { dropped });
  }

  return recipients;
}
