import { extractEmailAddress } from "@/utils/email";
import { getSenders } from "./get-senders";
import prisma from "@/utils/prisma";
import type { Sender } from "@/utils/categorize/senders/batch-validation";

const MAX_ITERATIONS = 200;

export async function getUncategorizedSenders({
  emailAccountId,
  offset = 0,
  limit = 100,
}: {
  emailAccountId: string;
  offset?: number;
  limit?: number;
}) {
  let uncategorizedSenders: UncategorizedSender[] = [];
  let currentOffset = offset;

  while (uncategorizedSenders.length === 0 && currentOffset < MAX_ITERATIONS) {
    const result = await getSenders({
      emailAccountId,
      limit,
      offset: currentOffset,
    });

    const senderMap = new Map<
      string,
      { name: string | null; sourceMessageId: string }
    >();
    for (const sender of result) {
      const extractedEmail = extractEmailAddress(sender.from);
      // Unparseable from headers extract to "" and can never be categorized
      if (!extractedEmail) continue;
      // Normalize so case variants of the same address dedupe to one entry
      const email = extractedEmail.toLowerCase();
      // Only set the name if we don't already have one (keep first non-null)
      if (
        !senderMap.has(email) ||
        (!senderMap.get(email)?.name && sender.fromName)
      ) {
        senderMap.set(email, {
          name: sender.fromName,
          sourceMessageId: sender.id,
        });
      }
    }

    const allSenderEmails = Array.from(senderMap.keys());

    // Sender records store canonicalized (lowercased) emails, while message
    // from headers keep their original casing — compare case-insensitively so
    // already-categorized senders aren't requeued forever.
    const existingSenders = await prisma.newsletter.findMany({
      where: {
        email: { in: allSenderEmails, mode: "insensitive" },
        emailAccountId,
        category: { isNot: null },
      },
      select: { email: true },
    });

    const existingSenderEmails = new Set(
      existingSenders.map((s) => s.email.toLowerCase()),
    );

    uncategorizedSenders = Array.from(senderMap, ([email, sender]) => ({
      email,
      ...sender,
    })).filter((sender) => !existingSenderEmails.has(sender.email));

    // Use result.length (raw query count) not allSenderEmails.length (de-duplicated count)
    // to correctly detect when there are more pages
    if (result.length < limit) {
      return { uncategorizedSenders };
    }

    currentOffset += limit;
  }

  // Only return nextOffset if we found senders (to avoid infinite loop when MAX_ITERATIONS is hit)
  if (uncategorizedSenders.length > 0) {
    return { uncategorizedSenders, nextOffset: currentOffset };
  }
  return { uncategorizedSenders };
}

/** `sourceMessageId` is a stored message the sender was found on, so a queued
 * job can name the sender without carrying the address. */
type UncategorizedSender = Sender & { sourceMessageId: string };
