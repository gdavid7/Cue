import { ImapFlow, type MessageStructureObject } from "imapflow";
import { createTransport } from "nodemailer";

// The production robot's own Gmail account, reached with a Google app
// password. App passwords do not expire like the OAuth app's Testing-mode
// refresh tokens do, so the robot can always read its own mail.
const IMAP_HOST = "imap.gmail.com";
const SMTP_HOST = "smtp.gmail.com";

export const QA_SEED_HEADER = "X-Cue-QA-Seed";
export const QA_PROBE_SUBJECT_PREFIX = "Cue QA reply probe";

export type QaMailboxCredentials = { email: string; appPassword: string };

export function readQaMailboxCredentials(): QaMailboxCredentials | null {
  const email = process.env.CUE_QA_EMAIL?.trim().toLowerCase();
  // Google shows app passwords in groups of four; the spaces are cosmetic.
  const appPassword = process.env.CUE_QA_IMAP_APP_PASSWORD?.replaceAll(" ", "");
  if (!email || !appPassword) return null;
  return { email, appPassword };
}

export async function withImap<T>(
  credentials: QaMailboxCredentials,
  run: (client: ImapFlow) => Promise<T>,
) {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: credentials.email, pass: credentials.appPassword },
    // imapflow's logger prints raw protocol lines, which include mail content.
    logger: false,
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function findSpecialMailbox(
  client: ImapFlow,
  use: "\\All" | "\\Sent" | "\\Junk" | "\\Trash",
) {
  const mailboxes = await client.list();
  return mailboxes.find((mailbox) => mailbox.specialUse === use)?.path ?? null;
}

/**
 * Polls INBOX and Spam for a Cue sign-in code that arrived after `since`, and
 * deletes the message once read so the next run cannot pick up a stale code.
 */
export async function waitForSignInCode(
  credentials: QaMailboxCredentials,
  { since, timeoutMs }: { since: Date; timeoutMs: number },
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = await withImap(credentials, async (client) => {
      const spam = await findSpecialMailbox(client, "\\Junk");
      for (const path of ["INBOX", ...(spam ? [spam] : [])]) {
        const found = await takeSignInCode(client, path, since);
        if (found) return found;
      }
      return null;
    });
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return null;
}

export function extractSignInCode(text: string) {
  return text.match(/sign-in code is\D{0,40}?(\d{6})\b/i)?.[1] ?? null;
}

export async function sendSelfMessage(
  credentials: QaMailboxCredentials,
  message: { subject: string; text: string; messageId?: string },
) {
  const transport = createTransport({
    host: SMTP_HOST,
    port: 465,
    secure: true,
    auth: { user: credentials.email, pass: credentials.appPassword },
  });
  try {
    await transport.sendMail({
      from: credentials.email,
      // Only ever the robot's own address: nothing it sends can reach a person.
      to: credentials.email,
      subject: message.subject,
      text: message.text,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      headers: { [QA_SEED_HEADER]: "probe" },
    });
  } finally {
    transport.close();
  }
}

/** Moves reply probes older than `olderThanDays` to Trash so the inbox stays small. */
export async function pruneReplyProbes(
  credentials: QaMailboxCredentials,
  olderThanDays: number,
) {
  return withImap(credentials, async (client) => {
    const allMail = await findSpecialMailbox(client, "\\All");
    const trash = await findSpecialMailbox(client, "\\Trash");
    if (!allMail || !trash) return 0;
    const lock = await client.getMailboxLock(allMail);
    try {
      const uids = await client.search(
        {
          subject: QA_PROBE_SUBJECT_PREFIX,
          before: new Date(Date.now() - olderThanDays * 86_400_000),
        },
        { uid: true },
      );
      if (!uids || uids.length === 0) return 0;
      await client.messageMove(uids, trash, { uid: true });
      return uids.length;
    } finally {
      lock.release();
    }
  });
}

async function takeSignInCode(client: ImapFlow, path: string, since: Date) {
  const lock = await client.getMailboxLock(path);
  try {
    // IMAP SINCE is day-granular, so the exact cutoff is checked below.
    const uids = await client.search(
      {
        since: new Date(since.getTime() - 86_400_000),
        subject: "sign-in code",
      },
      { uid: true },
    );
    if (!uids || uids.length === 0) return null;
    for (const uid of [...uids].reverse()) {
      // fetchOne answers `false` when the message is gone.
      const message =
        (await client.fetchOne(
          String(uid),
          { internalDate: true, bodyStructure: true },
          { uid: true },
        )) || null;
      if (!message?.bodyStructure) continue;
      const received = new Date(message.internalDate ?? 0);
      // Allow for clock skew between the runner and Gmail.
      if (received.getTime() < since.getTime() - 30_000) continue;
      const part = findTextPart(message.bodyStructure);
      if (!part) continue;
      const { content } = await client.download(String(uid), part, {
        uid: true,
      });
      if (!content) continue;
      const code = extractSignInCode(await streamToString(content));
      if (!code) continue;
      await client.messageDelete(String(uid), { uid: true });
      return code;
    }
    return null;
  } finally {
    lock.release();
  }
}

function findTextPart(node: MessageStructureObject): string | null {
  if (node.type === "text/plain") return node.part ?? "1";
  for (const child of node.childNodes ?? []) {
    const found = findTextPart(child);
    if (found) return found;
  }
  if (node.type === "text/html") return node.part ?? "1";
  return null;
}

async function streamToString(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
