/**
 * Plants realistic mail into the production robot's Gmail account: the Cue
 * demo inbox (newsletters, emails that need a reply, receipts, a sent thread
 * awaiting a reply), a meeting invite, and a long back-and-forth thread.
 *
 * Messages are written with IMAP APPEND, so they keep their fixture senders
 * and dates without anything being sent. Every address other than the robot's
 * own is rewritten to the reserved example.com domain, so nothing the app or
 * the robot does with this mail can reach a real person. Each message carries
 * a stable Message-ID and is skipped when already present, so the script is
 * safe to run repeatedly.
 *
 *   CUE_QA_EMAIL=... CUE_QA_IMAP_APP_PASSWORD=... \
 *     pnpm -F inbox-zero-ai exec tsx scripts/qa/seed-test-inbox.ts
 */
import MailComposer from "nodemailer/lib/mail-composer";
import {
  findSpecialMailbox,
  QA_SEED_HEADER,
  readQaMailboxCredentials,
  withImap,
} from "./qa-mailbox";
import { buildSeedMessages } from "./seed-messages";

main().catch((error: unknown) => {
  // The message names the failing step without echoing credentials or mail.
  console.error(
    `Seeding failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});

async function main() {
  const credentials = readQaMailboxCredentials();
  if (!credentials) {
    console.log(
      "NOT CONFIGURED: CUE_QA_EMAIL / CUE_QA_IMAP_APP_PASSWORD are not set; skipping inbox seeding.",
    );
    return;
  }
  const messages = buildSeedMessages({ email: credentials.email });
  const result = await withImap(credentials, async (client) => {
    const allMail = await findSpecialMailbox(client, "\\All");
    const sent = await findSpecialMailbox(client, "\\Sent");
    if (!allMail || !sent) {
      throw new Error("Gmail All Mail or Sent folder not found over IMAP");
    }
    const existing = new Set<string>();
    const lock = await client.getMailboxLock(allMail);
    try {
      for (const message of messages) {
        const uids = await client.search(
          { header: { "message-id": message.messageId } },
          { uid: true },
        );
        if (uids && uids.length > 0) existing.add(message.key);
      }
    } finally {
      lock.release();
    }

    let added = 0;
    for (const message of messages) {
      if (existing.has(message.key)) continue;
      const raw = await new MailComposer({
        ...message.mail,
        messageId: message.messageId,
        date: message.date,
        headers: { [QA_SEED_HEADER]: message.key },
      })
        .compile()
        .build();
      const folder =
        message.folder === "inbox"
          ? "INBOX"
          : message.folder === "sent"
            ? sent
            : allMail;
      await client.append(
        folder,
        raw,
        message.unread ? [] : ["\\Seen"],
        message.date,
      );
      added += 1;
    }
    return { added, skipped: existing.size };
  });
  // Counts only: subjects and addresses stay out of CI logs.
  console.log(
    `Seeded test inbox: ${result.added} added, ${result.skipped} already present, ${messages.length} total.`,
  );
}
