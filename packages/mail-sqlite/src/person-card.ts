import { messageAttachmentDescriptorSchema } from "@inboxzero/mail-core/messages";
import {
  PERSON_CARD_CONVERSATION_LIMIT,
  type PersonCard,
  type PersonCardConversation,
  type PersonCardQuery,
  type ReplyLag,
} from "@inboxzero/mail-core/queries";
import { isAutomatedAddress } from "./contact-suggestions";
import type { SqlTransaction, SqlValue } from "./driver";
import { readCoverage } from "./store-read-utils";

/** Fewer replies than this say more about one week than about the person. */
export const MIN_REPLY_LAG_EXCHANGES = 3;

// The newest messages with them per account the card reads: plenty for
// medians and open asks, and it keeps someone you've written to for a decade
// as quick to open as anyone else (each message is one index lookup).
const MESSAGE_LIMIT = 2000;
const FILE_LIMIT = 6;
// Most messages with files are read before their bodies, so only the newest
// few are looked up for stored file details.
const FILE_MESSAGE_LIMIT = 40;
const OTHER_ADDRESS_LIMIT = 3;
// Providers stamp a message's arrival per mailbox, so the same message in two
// accounts can differ by a little.
const COPY_WINDOW_MS = 5 * 60_000;

type PersonMessage = {
  accountId: string;
  messageId: string;
  conversationId: string;
  subject: string;
  receivedAtMs: number;
  from: "you" | "them" | "other";
  hasAttachments: boolean;
};

/**
 * Everything the reader's person card shows about one address, from the
 * contact index the store already keeps: each message lists the people on
 * it, so this never scans the mailbox.
 */
export async function readPersonCard(
  tx: SqlTransaction,
  input: PersonCardQuery,
): Promise<PersonCard> {
  const email = normalizeEmail(input.email);
  const own = new Set(input.ownAddresses.map(normalizeEmail));
  const accountIds = [...new Set(input.accountIds)];
  const messages: PersonMessage[] = [];
  for (const accountId of accountIds) {
    const rows = await tx.query(
      `SELECT e.message_id, e.conversation_id, e.subject, e.received_at_ms,
              e.in_sent, e.has_attachments, i.sender
       FROM (
         SELECT message_id, sender FROM contact_interactions
         WHERE account_id = ? AND email = ?
         ORDER BY last_at DESC LIMIT ?
       ) AS i
       JOIN effective_messages e
         ON e.account_id = ? AND e.message_id = i.message_id
       WHERE e.in_trash = 0 AND e.in_spam = 0 AND e.in_draft = 0`,
      [accountId, email, MESSAGE_LIMIT, accountId],
    );
    for (const row of rows) {
      const sender = String(row.sender);
      messages.push({
        accountId,
        messageId: String(row.message_id),
        conversationId: String(row.conversation_id),
        subject: String(row.subject),
        receivedAtMs: Number(row.received_at_ms),
        from:
          sender === email
            ? "them"
            : own.has(sender) || Number(row.in_sent) === 1
              ? "you"
              : "other",
        hasAttachments: Number(row.has_attachments) === 1,
      });
    }
  }

  const conversations = new Map<string, PersonCardConversation>();
  for (const message of messages) {
    const key = conversationKey(message.accountId, message.conversationId);
    const existing = conversations.get(key);
    if (existing && existing.latestMessageAtMs >= message.receivedAtMs)
      continue;
    conversations.set(key, {
      accountId: message.accountId,
      conversationId: message.conversationId,
      subject: message.subject,
      latestMessageAtMs: message.receivedAtMs,
    });
  }
  const sorted = [...conversations.values()].sort(
    (a, b) => b.latestMessageAtMs - a.latestMessageAtMs,
  );
  const originals = findCrossAccountCopies(sorted);
  const newestFirst = sorted.filter(
    (conversation) =>
      !originals.has(
        conversationKey(conversation.accountId, conversation.conversationId),
      ),
  );
  // One message to two of your accounts shows once and counts once.
  const distinct = messages.filter(
    (message) =>
      !originals.has(
        conversationKey(message.accountId, message.conversationId),
      ),
  );

  const awaitingYou: PersonCardConversation[] = [];
  const awaitingThem: PersonCardConversation[] = [];
  for (const tracking of input.replyTracking) {
    if (!accountIds.includes(tracking.accountId)) continue;
    for (const [labelId, list] of [
      [tracking.toReplyLabelId, awaitingYou],
      [tracking.awaitingReplyLabelId, awaitingThem],
    ] as const) {
      if (!labelId) continue;
      const rows = await tx.query(
        `SELECT DISTINCT conversation_id FROM effective_message_memberships
         WHERE account_id = ? AND kind = 'label' AND membership_id = ?`,
        [tracking.accountId, labelId],
      );
      for (const row of rows) {
        const key = conversationKey(
          tracking.accountId,
          String(row.conversation_id),
        );
        const conversation = originals.get(key) ?? conversations.get(key);
        if (conversation && !list.includes(conversation))
          list.push(conversation);
      }
    }
  }

  const name = await readName(tx, accountIds, email);
  return {
    email,
    automated: isAutomatedAddress(email),
    name,
    otherAddresses: name
      ? await readOtherAddresses(tx, accountIds, email, name, own)
      : [],
    conversations: newestFirst.slice(0, PERSON_CARD_CONVERSATION_LIMIT),
    files: await readFiles(tx, distinct),
    replyLag: measureReplyLag(
      distinct.flatMap((message) =>
        message.from === "other"
          ? []
          : [
              {
                conversation: conversationKey(
                  message.accountId,
                  message.conversationId,
                ),
                atMs: message.receivedAtMs,
                from: message.from,
              },
            ],
      ),
    ),
    awaitingYou: awaitingYou.sort(byNewest),
    awaitingThem: awaitingThem.sort(byNewest),
    history: await readHistory(tx, accountIds),
  };
}

/**
 * How long each side takes to answer the other, as medians. Within a
 * conversation, a reply is the first message from one side after the other
 * side wrote; it is timed from the first message of the run it answers, so
 * a nudge doesn't make a slow answer look quick. Messages from anyone else
 * are left out by the caller.
 */
export function measureReplyLag(
  messages: Array<{ conversation: string; atMs: number; from: "you" | "them" }>,
): PersonCard["replyLag"] {
  const byConversation = new Map<string, typeof messages>();
  for (const message of messages) {
    const list = byConversation.get(message.conversation);
    if (list) list.push(message);
    else byConversation.set(message.conversation, [message]);
  }
  const lags = { you: [] as number[], them: [] as number[] };
  for (const thread of byConversation.values()) {
    thread.sort((a, b) => a.atMs - b.atMs);
    let unanswered = thread[0];
    for (const message of thread.slice(1)) {
      if (message.from === unanswered.from) continue;
      lags[message.from].push(message.atMs - unanswered.atMs);
      unanswered = message;
    }
  }
  return { theirs: summarize(lags.them), yours: summarize(lags.you) };
}

function summarize(lags: number[]): ReplyLag | null {
  if (lags.length < MIN_REPLY_LAG_EXCHANGES) return null;
  const sorted = [...lags].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2
      ? sorted[middle]
      : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  return { medianMs, exchanges: sorted.length };
}

/**
 * The name you address them by in mail you sent. Names on mail you received
 * are whatever the sender chose, so the card leaves those to the header of
 * the message being read.
 */
async function readName(
  tx: SqlTransaction,
  accountIds: string[],
  email: string,
): Promise<string | null> {
  if (!accountIds.length) return null;
  const [row] = await tx.query(
    `SELECT name FROM contact_stats
     WHERE account_id IN (${placeholders(accountIds)}) AND email = ?
       AND sent = 1 AND name != ''
     GROUP BY name ORDER BY SUM(count) DESC, MAX(last_at) DESC, name LIMIT 1`,
    [...accountIds, email],
  );
  const name = row ? String(row.name) : "";
  return name && normalizeEmail(name) !== email ? name : null;
}

/**
 * Other addresses you have sent mail to under exactly this full name, newest
 * first. Only your own sent mail counts: anyone can put a name on mail they
 * send you. A lone first name is shared by too many people to say it is the
 * same one.
 */
async function readOtherAddresses(
  tx: SqlTransaction,
  accountIds: string[],
  email: string,
  name: string,
  own: Set<string>,
): Promise<string[]> {
  if (name.trim().split(/\s+/u).length < 2) return [];
  const rows = await tx.query(
    `SELECT t.email, MAX(s.last_at) AS last_at FROM contact_tokens t
     JOIN contact_stats s
       ON s.account_id = t.account_id AND s.email = t.email
       AND s.name = ? AND s.sent = 1
     WHERE t.account_id IN (${placeholders(accountIds)})
       AND t.token = ? AND t.email != ?
     GROUP BY t.email ORDER BY last_at DESC, t.email LIMIT ?`,
    [
      name,
      ...accountIds,
      name.toLowerCase(),
      email,
      OTHER_ADDRESS_LIMIT + own.size,
    ],
  );
  return rows
    .map((row) => String(row.email))
    .filter((address) => !own.has(address))
    .slice(0, OTHER_ADDRESS_LIMIT);
}

async function readFiles(
  tx: SqlTransaction,
  messages: PersonMessage[],
): Promise<PersonCard["files"]> {
  const candidates = messages
    .filter((message) => message.from === "them" && message.hasAttachments)
    .sort((a, b) => b.receivedAtMs - a.receivedAtMs)
    .slice(0, FILE_MESSAGE_LIMIT);
  const stored = new Map<string, SqlValue>();
  const byAccount = new Map<string, string[]>();
  for (const message of candidates) {
    const ids = byAccount.get(message.accountId);
    if (ids) ids.push(message.messageId);
    else byAccount.set(message.accountId, [message.messageId]);
  }
  for (const [accountId, ids] of byAccount) {
    const rows = await tx.query(
      `SELECT message_id, attachments_json FROM message_content
       WHERE account_id = ? AND message_id IN (${placeholders(ids)})`,
      [accountId, ...ids],
    );
    for (const row of rows)
      stored.set(
        conversationKey(accountId, String(row.message_id)),
        row.attachments_json,
      );
  }
  const files: PersonCard["files"] = [];
  // The same file sent again, as on every reply that keeps it, shows once.
  const seen = new Set<string>();
  for (const message of candidates) {
    const json = stored.get(
      conversationKey(message.accountId, message.messageId),
    );
    for (const attachment of parseAttachments(json)) {
      if (attachment.inline) continue;
      const identity = `${attachment.filename}\u0000${attachment.size}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      files.push({
        accountId: message.accountId,
        conversationId: message.conversationId,
        messageId: message.messageId,
        receivedAtMs: message.receivedAtMs,
        attachment,
      });
      if (files.length === FILE_LIMIT) return files;
    }
  }
  return files;
}

async function readHistory(
  tx: SqlTransaction,
  accountIds: string[],
): Promise<PersonCard["history"]> {
  const coverage = await readCoverage(tx, accountIds);
  const [backfill] = await tx.query(
    "SELECT complete FROM contact_backfill_state WHERE id = 1",
  );
  const windows = coverage.flatMap((scope) =>
    scope.windowStartMs === undefined ? [] : [scope.windowStartMs],
  );
  return {
    syncing:
      coverage.some((scope) => scope.metadata === "partial") ||
      Number(backfill?.complete ?? 0) !== 1,
    sinceMs: windows.length ? Math.min(...windows) : null,
  };
}

function parseAttachments(value: SqlValue | undefined) {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const result = messageAttachmentDescriptorSchema.safeParse(item);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Conversations another account already holds, as when a message went to two
 * of your accounts, mapped to the copy that stays. The store keeps no
 * Message-ID header, so a copy is one with the same subject whose newest
 * message landed within a few minutes, in a different account.
 */
function findCrossAccountCopies(newestFirst: PersonCardConversation[]) {
  const copies = new Map<string, PersonCardConversation>();
  const keptBySubject = new Map<string, PersonCardConversation[]>();
  for (const conversation of newestFirst) {
    const kept = keptBySubject.get(conversation.subject) ?? [];
    const original = kept.find(
      (other) =>
        other.accountId !== conversation.accountId &&
        Math.abs(other.latestMessageAtMs - conversation.latestMessageAtMs) <=
          COPY_WINDOW_MS,
    );
    if (original) {
      copies.set(
        conversationKey(conversation.accountId, conversation.conversationId),
        original,
      );
    } else {
      kept.push(conversation);
      keptBySubject.set(conversation.subject, kept);
    }
  }
  return copies;
}

function byNewest(a: PersonCardConversation, b: PersonCardConversation) {
  return b.latestMessageAtMs - a.latestMessageAtMs;
}

function conversationKey(accountId: string, id: string) {
  return `${accountId}\u0000${id}`;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(",") || "NULL";
}
