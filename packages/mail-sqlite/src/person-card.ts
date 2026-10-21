import { messageAttachmentDescriptorSchema } from "@inboxzero/mail-core/messages";
import {
  PERSON_CARD_CONVERSATION_LIMIT,
  type PersonCard,
  type PersonCardConversation,
  type PersonCardQuery,
  type ReplyLag,
} from "@inboxzero/mail-core/queries";
import { isAutomatedAddress, parseAddress } from "./contact-suggestions";
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
const COPY_WINDOW_MS = 60_000;
// Anyone can start a conversation with you under a friend's name, and a
// reply copies that name back. So a name only counts once mail you sent
// under it reaches beyond one exchange they set up: at least two
// conversations, the first and last a week or more apart, in one account.
const NAME_MIN_CONVERSATIONS = 2;
const NAME_MIN_SPAN_MS = 7 * 24 * 3_600_000;

type PersonMessage = {
  accountId: string;
  messageId: string;
  conversationId: string;
  /** Its account and conversation, as one key. */
  conversation: string;
  subject: string;
  receivedAtMs: number;
  from: "you" | "them" | "other";
  hasAttachments: boolean;
  sender: string;
  recipients: [to: SqlValue, cc: SqlValue];
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
              e.in_sent, e.has_attachments, e.to_json, e.cc_json, i.sender
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
        conversation: conversationKey(accountId, String(row.conversation_id)),
        subject: String(row.subject),
        receivedAtMs: Number(row.received_at_ms),
        from:
          sender === email
            ? "them"
            : own.has(sender) || Number(row.in_sent) === 1
              ? "you"
              : "other",
        hasAttachments: Number(row.has_attachments) === 1,
        sender,
        recipients: [row.to_json, row.cc_json],
      });
    }
  }

  const conversations = new Map<string, PersonCardConversation>();
  for (const message of messages) {
    const key = message.conversation;
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
  // One message to two of your accounts shows once and counts once.
  const { hidden, distinct, threadOf } = findCrossAccountCopies(
    messages,
    conversations,
    accountIds,
  );
  const newestFirst = [...conversations.entries()]
    .filter(([key]) => !hidden.has(key))
    .map(([, conversation]) => conversation)
    .sort(byNewest);

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
        const conversation = hidden.get(key) ?? conversations.get(key);
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
                conversation: threadOf(message),
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
 * The name you address them by in mail you sent, when that mail is enough
 * to vouch for it (see NAME_MIN_CONVERSATIONS). Names on mail you received
 * are whatever the sender chose, so the card leaves those, and names you
 * have only used in a short exchange, to the header of the message being
 * read.
 */
async function readName(
  tx: SqlTransaction,
  accountIds: string[],
  email: string,
): Promise<string | null> {
  if (!accountIds.length) return null;
  // Same bar as readOtherAddresses: NAME_MIN_CONVERSATIONS, NAME_MIN_SPAN_MS.
  // Only names that pass compete, so a short exchange under a new name
  // neither replaces nor blanks one you have used for longer.
  const [row] = await tx.query(
    `SELECT i.name, COUNT(*) AS times, MAX(i.last_at) AS latest
     FROM contact_interactions i
     CROSS JOIN messages m
       ON m.account_id = i.account_id AND m.message_id = i.message_id
     WHERE i.account_id IN (${placeholders(accountIds)})
       AND i.email = ? AND i.sent = 1 AND i.name != ''
       AND lower(trim(i.name)) != ?
     GROUP BY i.account_id, i.name
     HAVING COUNT(DISTINCT m.conversation_id) >= ?
       AND MAX(i.last_at) - MIN(i.last_at) >= ?
     ORDER BY times DESC, latest DESC, i.name LIMIT 1`,
    [...accountIds, email, email, NAME_MIN_CONVERSATIONS, NAME_MIN_SPAN_MS],
  );
  return row ? String(row.name) : null;
}

/**
 * Other addresses you have sent mail to under exactly this full name, newest
 * first. The name comes from readName, so your mail to the card's address
 * already vouches for it, and each other address needs the same from your
 * mail to it; otherwise someone who borrowed a friend's name for a short
 * exchange would have their card vouch for the friend. A lone first name is
 * shared by too many people to say it is the same one.
 */
async function readOtherAddresses(
  tx: SqlTransaction,
  accountIds: string[],
  email: string,
  name: string,
  own: Set<string>,
): Promise<string[]> {
  if (name.trim().split(/\s+/u).length < 2) return [];
  // Same bar as readName: NAME_MIN_CONVERSATIONS, NAME_MIN_SPAN_MS. CROSS
  // JOIN keeps the plan on the name's tokens; left to itself SQLite walks
  // every contact in the account.
  const rows = await tx.query(
    `SELECT email, MAX(last_at) AS last_at FROM (
       SELECT t.email, MAX(i.last_at) AS last_at,
              MAX(i.last_at) - MIN(i.last_at) AS span,
              COUNT(DISTINCT m.conversation_id) AS conversations
       FROM contact_tokens t
       CROSS JOIN contact_interactions i
         ON i.account_id = t.account_id AND i.email = t.email
         AND i.name = ? AND i.sent = 1
       CROSS JOIN messages m
         ON m.account_id = i.account_id AND m.message_id = i.message_id
       WHERE t.account_id IN (${placeholders(accountIds)})
         AND t.token = ? AND t.email != ?
       GROUP BY t.email, t.account_id
     )
     GROUP BY email HAVING MAX(conversations >= ? AND span >= ?)
     ORDER BY last_at DESC, email LIMIT ?`,
    [
      name,
      ...accountIds,
      name.toLowerCase(),
      email,
      NAME_MIN_CONVERSATIONS,
      NAME_MIN_SPAN_MS,
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
 * Messages that reached more than one of your accounts. The store keeps no
 * Message-ID header, so two messages in different accounts are copies when
 * they have the same sender, subject and recipients and arrived within a
 * minute. Each copy is counted once; a conversation is hidden only when
 * another one shown holds a copy of every message in it, and conversations
 * sharing a copy are one thread for reply times.
 */
function findCrossAccountCopies(
  messages: PersonMessage[],
  conversations: Map<string, PersonCardConversation>,
  accountIds: string[],
) {
  if (new Set(messages.map((message) => message.accountId)).size < 2)
    return {
      hidden: new Map<string, PersonCardConversation>(),
      distinct: messages,
      threadOf: (message: PersonMessage) => message.conversation,
    };
  const groupOf = new Map<PersonMessage, PersonMessage[]>();
  // Per fingerprint, its groups in arrival order. Messages come in arrival
  // order too, so a group that started over a minute ago takes no more
  // copies (head moves past it), and each account's next group to join only
  // moves forward (next), which keeps a long run of look-alike messages linear.
  const queues = new Map<
    string,
    { groups: PersonMessage[][]; head: number; next: Map<string, number> }
  >();
  const byArrival = [...messages].sort(
    (a, b) =>
      a.receivedAtMs - b.receivedAtMs ||
      accountIds.indexOf(a.accountId) - accountIds.indexOf(b.accountId),
  );
  // Look-alike messages repeat the same headers, so each is parsed once.
  const fingerprints = new Map<string, string>();
  for (const message of byArrival) {
    const raw = [
      message.sender,
      message.subject,
      ...message.recipients.map(String),
    ].join("\u0000");
    let fingerprint = fingerprints.get(raw);
    if (fingerprint === undefined) {
      // What two copies of one message share.
      fingerprint = [
        message.sender,
        message.subject.trim().replace(/\s+/gu, " ").toLowerCase(),
        ...recipients(...message.recipients),
      ].join("\u0000");
      fingerprints.set(raw, fingerprint);
    }
    let queue = queues.get(fingerprint);
    if (!queue) {
      queue = { groups: [], head: 0, next: new Map() };
      queues.set(fingerprint, queue);
    }
    const { groups } = queue;
    while (
      queue.head < groups.length &&
      message.receivedAtMs - groups[queue.head][0].receivedAtMs > COPY_WINDOW_MS
    )
      queue.head++;
    let index = Math.max(queue.next.get(message.accountId) ?? 0, queue.head);
    while (
      index < groups.length &&
      groups[index].some((member) => member.accountId === message.accountId)
    )
      index++;
    if (index === groups.length) groups.push([]);
    const group = groups[index];
    group.push(message);
    queue.next.set(message.accountId, index + 1);
    groupOf.set(message, group);
  }

  const messagesByConversation = new Map<string, PersonMessage[]>();
  for (const message of messages) {
    const key = message.conversation;
    const list = messagesByConversation.get(key);
    if (list) list.push(message);
    else messagesByConversation.set(key, [message]);
  }
  // The fuller conversation stays, so a later reply in one account keeps it.
  const ranked = [...messagesByConversation.keys()].sort((a, b) => {
    const left = conversations.get(a) as PersonCardConversation;
    const right = conversations.get(b) as PersonCardConversation;
    return (
      (messagesByConversation.get(b)?.length ?? 0) -
        (messagesByConversation.get(a)?.length ?? 0) ||
      right.latestMessageAtMs - left.latestMessageAtMs ||
      accountIds.indexOf(left.accountId) -
        accountIds.indexOf(right.accountId) ||
      (a < b ? -1 : 1)
    );
  });
  const hidden = new Map<string, PersonCardConversation>();
  const shown = new Set<string>();
  for (const key of ranked) {
    const own = messagesByConversation.get(key) ?? [];
    const keeper = (groupOf.get(own[0]) ?? [])
      .map((copy) => copy.conversation)
      .find(
        (other) =>
          shown.has(other) &&
          own.every((message) =>
            groupOf.get(message)?.some((copy) => copy.conversation === other),
          ),
      );
    if (keeper)
      hidden.set(key, conversations.get(keeper) as PersonCardConversation);
    else shown.add(key);
  }

  const rank = new Map(ranked.map((key, index) => [key, index]));
  // A copy in a conversation that stays wins over one in a hidden conversation.
  const rankOf = (message: PersonMessage) => {
    const key = message.conversation;
    return (hidden.has(key) ? ranked.length : 0) + (rank.get(key) ?? 0);
  };
  const distinct = messages.filter((message) => {
    const group = groupOf.get(message) ?? [message];
    const kept = group.reduce((best, copy) =>
      rankOf(copy) < rankOf(best) ? copy : best,
    );
    return kept === message;
  });

  const thread = new Map<string, string>();
  const root = (key: string) => {
    let top = key;
    for (let parent = thread.get(top); parent && parent !== top; ) {
      top = parent;
      parent = thread.get(top);
    }
    for (let node = key; node !== top; ) {
      const parent = thread.get(node) as string;
      thread.set(node, top);
      node = parent;
    }
    return top;
  };
  for (const group of new Set(groupOf.values()))
    for (const copy of group.slice(1))
      thread.set(root(copy.conversation), root(group[0].conversation));

  return {
    hidden,
    distinct,
    threadOf: (message: PersonMessage) => root(message.conversation),
  };
}

function recipients(...lists: SqlValue[]) {
  const emails = new Set<string>();
  for (const list of lists) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(list ?? "[]"));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const address of parsed) {
      const contact =
        typeof address === "string" ? parseAddress(address) : null;
      if (contact) emails.add(contact.email);
    }
  }
  return [...emails].sort();
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
