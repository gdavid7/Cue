import { z } from "zod";
import {
  accountIdSchema,
  conversationKeySchema,
  localRevisionSchema,
} from "./identities";
import {
  inboxSectionSchema,
  MAX_INTERNET_MESSAGE_ID_LENGTH,
  mailboxRoleSchema,
  type MessageAttachmentDescriptor,
} from "./messages";

export const MAX_MESSAGE_PREDICATE_IDS = 10_000;

export const wellKnownMailboxSchema = z.enum([
  "inbox",
  "sent",
  "drafts",
  "archive",
  "all",
  "starred",
  "trash",
  "spam",
  "snoozed",
]);
export type WellKnownMailbox = z.infer<typeof wellKnownMailboxSchema>;

export const mailPredicateSchema: z.ZodType<MailPredicate> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("all"),
      predicates: z.array(mailPredicateSchema).max(32),
    }),
    z.object({
      kind: z.literal("any"),
      predicates: z.array(mailPredicateSchema).max(32),
    }),
    z.object({ kind: z.literal("not"), predicate: mailPredicateSchema }),
    z.object({
      kind: z.literal("role"),
      role: z.enum(["inbox", "sent", "draft", "trash", "spam"]),
    }),
    z.object({
      kind: z.literal("mailbox"),
      mailbox: wellKnownMailboxSchema,
    }),
    z.object({ kind: z.literal("read"), value: z.boolean() }),
    z.object({ kind: z.literal("starred"), value: z.boolean() }),
    z.object({
      kind: z.literal("inbox_section"),
      section: inboxSectionSchema,
    }),
    z.object({
      kind: z.literal("membership"),
      membership: z.enum(["folder", "label", "category"]),
      id: z.string().min(1).max(256),
      accountId: accountIdSchema.optional(),
    }),
    z.object({
      kind: z.literal("address"),
      field: z.enum(["from", "to", "cc", "bcc"]),
      value: z.string().min(1).max(4096),
      match: z.enum(["address", "domain"]),
    }),
    z.object({
      kind: z.literal("received"),
      afterMs: z.number().int().nullable(),
      beforeMs: z.number().int().nullable(),
    }),
    z.object({ kind: z.literal("has_attachment"), value: z.boolean() }),
    z.object({
      kind: z.literal("message"),
      ids: z.array(z.string().min(1).max(512)).max(MAX_MESSAGE_PREDICATE_IDS),
      accountId: accountIdSchema.optional(),
    }),
    z.object({
      kind: z.literal("conversation"),
      ids: z.array(z.string().min(1).max(512)).max(MAX_MESSAGE_PREDICATE_IDS),
      accountId: accountIdSchema.optional(),
    }),
    z.object({
      kind: z.literal("internet_message_id"),
      ids: z
        .array(z.string().min(1).max(MAX_INTERNET_MESSAGE_ID_LENGTH))
        .max(MAX_MESSAGE_PREDICATE_IDS),
      accountId: accountIdSchema.optional(),
    }),
    z.object({
      kind: z.literal("text"),
      field: z.enum(["any", "subject", "body"]),
      value: z.string().min(1).max(4096),
      match: z.enum(["term", "phrase"]),
    }),
    z.object({
      kind: z.literal("search"),
      query: z.string().min(1).max(4096),
      local: mailPredicateSchema,
      possible: mailPredicateSchema,
      accountIds: z.array(accountIdSchema).min(1).max(50).optional(),
    }),
    z.object({
      kind: z.literal("account"),
      ids: z.array(accountIdSchema).max(50),
    }),
  ]),
);

export type MailPredicate =
  | { kind: "all"; predicates: MailPredicate[] }
  | { kind: "any"; predicates: MailPredicate[] }
  | { kind: "not"; predicate: MailPredicate }
  | { kind: "role"; role: "inbox" | "sent" | "draft" | "trash" | "spam" }
  | { kind: "mailbox"; mailbox: WellKnownMailbox }
  | { kind: "read"; value: boolean }
  | { kind: "starred"; value: boolean }
  | { kind: "inbox_section"; section: "focused" | "other" }
  | {
      kind: "membership";
      membership: "folder" | "label" | "category";
      id: string;
      accountId?: string;
    }
  | {
      kind: "address";
      field: "from" | "to" | "cc" | "bcc";
      value: string;
      match: "address" | "domain";
    }
  | { kind: "received"; afterMs: number | null; beforeMs: number | null }
  | { kind: "has_attachment"; value: boolean }
  /** These messages, of `accountId` alone when it is set. */
  | { kind: "message"; ids: string[]; accountId?: string }
  /** Messages of these conversations, of `accountId` alone when it is set. */
  | { kind: "conversation"; ids: string[]; accountId?: string }
  /**
   * Whole conversations whose key is one of these, of `accountId` alone when
   * it is set. A conversation's key is the Message-ID of its latest message
   * that isn't a draft or in the trash (sent mail counts), normalised by
   * normalizeInternetMessageId; the ids are keys as summaries give them
   * (`latestInternetMessageId`), compared as they are. One message delivered
   * to several accounts has one key in each. Newer than the other kinds:
   * check `predicate:internet_message_id` with mailClientSupports first.
   */
  | { kind: "internet_message_id"; ids: string[]; accountId?: string }
  | {
      kind: "text";
      field: "any" | "subject" | "body";
      value: string;
      match: "term" | "phrase";
    }
  /**
   * A search the user typed, in the provider's own syntax. `local` is what the
   * store answers by itself, and never matches a message the whole query
   * wouldn't. The provider's own search for `query` finds the rest, as long
   * as they still meet `possible`, which matches every message the query
   * could: a match the reader has since archived or read drops out of an
   * `in:inbox` or `is:unread` search.
   */
  | {
      kind: "search";
      query: string;
      local: MailPredicate;
      possible: MailPredicate;
      /**
       * The accounts the query is written for, when a view across accounts
       * reads it differently per provider. Left out, every account's.
       */
      accountIds?: string[];
    }
  /** Mail of these accounts. */
  | { kind: "account"; ids: string[] };

export const conversationQuerySchema = z.object({
  accountIds: z.array(accountIdSchema).min(1).max(50),
  predicate: mailPredicateSchema,
  /**
   * Conversations by their latest matching message. Oldest first is newest
   * first reversed, ties included.
   */
  order: z.enum(["newest_first", "oldest_first"]),
  pageSize: z.number().int().min(1).max(100),
  after: z.string().max(512).nullable(),
  /**
   * False keeps the view's searches to the store, as for a search still
   * being typed: the provider is only asked once it is committed.
   */
  providerSearch: z.boolean().optional(),
});
export type ConversationQuery = z.infer<typeof conversationQuerySchema>;

export const coverageSchema = z.object({
  accountId: accountIdSchema,
  scopeId: z.string().min(1).max(256),
  metadata: z.enum(["partial", "complete"]),
  content: z.enum(["partial", "complete", "not_requested"]),
  indexedContent: z.enum(["partial", "complete", "not_requested"]),
  lastCompletedSyncAtMs: z.number().int().nullable(),
  /**
   * The scope's last full scan only reached back to this time, so older mail
   * may exist that the store has never seen. Omitted when it covers it all.
   */
  windowStartMs: z.number().int().optional(),
});
export type Coverage = z.infer<typeof coverageSchema>;

export const conversationSummarySchema = z.object({
  key: conversationKeySchema,
  subject: z.string(),
  preview: z.string(),
  from: z.string(),
  to: z.string(),
  senders: z.array(z.string()).max(500),
  latestMessageAtMs: z.number().int(),
  unread: z.boolean(),
  starred: z.boolean(),
  labelIds: z.array(z.string().max(256)).max(500),
  roles: z.array(mailboxRoleSchema).max(8),
  pendingOperationIds: z.array(z.string()),
  /** The newest message that isn't a draft or in the trash. */
  latestMessageId: z.string().optional(),
  /**
   * That message's Message-ID header, normalised (normalizeInternetMessageId),
   * once the store has read it: the key one message has in every mailbox.
   */
  latestInternetMessageId: z.string().optional(),
  hasAttachments: z.boolean().optional(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const mailboxViewSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  counts: z.object({
    matchingConversations: z.number().int().nonnegative(),
    unreadConversations: z.number().int().nonnegative(),
    extent: z.enum(["local_coverage", "complete_scope"]),
  }),
  nextPage: z.string().nullable(),
  coverage: z.array(coverageSchema),
  connection: z.enum(["ready", "offline", "blocked_auth"]).optional(),
  /**
   * For a view with a typed search, per account: whether the provider's
   * search is still running, answered, held back by quota, can't be reached,
   * needs the account reconnected, or can't run the query at all.
   */
  providerSearch: z
    .array(
      z.object({
        accountId: accountIdSchema,
        state: z.enum([
          "searching",
          "complete",
          "busy",
          "unavailable",
          "reconnect",
          "unsupported",
        ]),
        /** Whether the provider has answered any of the search yet. */
        answered: z.boolean(),
        /**
         * While searching: when the provider began reading the search, so a
         * view can time it from there rather than from when it was queued.
         * Left out while the search waits for its turn.
         */
        startedAtMs: z.number().int().optional(),
      }),
    )
    .max(50)
    .optional(),
});
export type MailboxView = z.infer<typeof mailboxViewSchema>;

export const MAX_MAILBOX_COUNT_TARGETS = 500;

export const mailboxCountsQuerySchema = z.object({
  accountIds: z.array(accountIdSchema).min(1).max(50),
  targets: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        predicate: mailPredicateSchema,
      }),
    )
    .max(MAX_MAILBOX_COUNT_TARGETS),
});
export type MailboxCountsQuery = z.infer<typeof mailboxCountsQuerySchema>;

export const mailboxCountsViewSchema = z.object({
  counts: z.array(
    z.object({
      id: z.string(),
      matchingConversations: z.number().int().nonnegative(),
      unreadConversations: z.number().int().nonnegative(),
    }),
  ),
});
export type MailboxCountsView = z.infer<typeof mailboxCountsViewSchema>;

export const querySnapshotSchema = z.object({
  status: z.enum(["loading", "ready", "unavailable", "error"]),
  revision: localRevisionSchema.nullable(),
  data: z.unknown().nullable(),
  refreshing: z.boolean(),
  error: z
    .object({
      code: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
});
export type QuerySnapshot<T> = {
  status: "loading" | "ready" | "unavailable" | "error";
  revision: z.infer<typeof localRevisionSchema> | null;
  data: T | null;
  refreshing: boolean;
  error: { code: string; retryable: boolean } | null;
};

export type QueryHandle<T> = {
  getSnapshot(): QuerySnapshot<T>;
  subscribe(listener: () => void): () => void;
  close(): void;
};

export function canonicalizeQuery(query: ConversationQuery): string {
  return JSON.stringify({
    accountIds: [...query.accountIds].sort(),
    predicate: query.predicate,
    order: query.order,
    pageSize: query.pageSize,
    after: query.after,
    ...(query.providerSearch === false ? { providerSearch: false } : {}),
  });
}

export function canonicalizeCountsQuery(query: MailboxCountsQuery): string {
  return JSON.stringify({
    accountIds: [...query.accountIds].sort(),
    targets: query.targets,
  });
}

export function mailboxPredicate(mailbox: WellKnownMailbox): MailPredicate {
  return { kind: "mailbox", mailbox };
}

export type ContactSuggestion = {
  emailAddress: string;
  name?: string;
};

export type ContactSuggestionQuery = {
  accountId: string;
  query: string;
  ownAddresses: string[];
  excludeEmails: string[];
};

/**
 * Messages, not conversations, that match a predicate, newest first: the unit
 * a provider's message search returns. `fromAddress` matches the sender's
 * address exactly, whether stored bare or as `Name <address>`.
 */
export type MessageSearchQuery = {
  accountId: string;
  predicate: MailPredicate;
  fromAddress: string | null;
  pageSize: number;
  after: string | null;
};

/**
 * A search by meaning: the messages of `accountId` whose on-device vectors
 * are nearest to `text`, at most one per conversation.
 */
export type SemanticSearchQuery = {
  accountId: string;
  text: string;
  limit: number;
};

export type SemanticMatch = {
  messageId: string;
  conversationId: string;
  /** Cosine similarity to the search, from -1 to 1. */
  similarity: number;
};

export type MessageSearchMatch = {
  messageId: string;
  conversationId: string;
  subject: string;
  preview: string;
  from: string;
  to: string[];
  receivedAtMs: number;
  read: boolean;
  starred: boolean;
  labelIds: string[];
  categoryIds: string[];
  roles: z.infer<typeof mailboxRoleSchema>[];
  hasAttachments: boolean;
};

export type MessageSearchPage = {
  messages: MessageSearchMatch[];
  nextPage: string | null;
  coverage: Coverage[];
};

/**
 * What the reader's person card shows about one correspondent, read from the
 * local store alone: it never asks the provider.
 */
export type PersonCardQuery = {
  /** The open thread's account, or every account All inboxes includes. */
  accountIds: string[];
  email: string;
  /** The user's own addresses, so their messages count as theirs. */
  ownAddresses: string[];
  /**
   * Per account, the labels Cue's reply tracking puts on conversations it
   * waits on you or them for; null where an account has no such label.
   */
  replyTracking: Array<{
    accountId: string;
    toReplyLabelId: string | null;
    awaitingReplyLabelId: string | null;
  }>;
};

export type PersonCardConversation = {
  accountId: string;
  conversationId: string;
  subject: string;
  latestMessageAtMs: number;
};

/** The median time one side took to answer the other, over `exchanges` replies. */
export type ReplyLag = { medianMs: number; exchanges: number };

export type PersonCard = {
  email: string;
  /**
   * A no-reply or other machine address. The store keeps no correspondence
   * history for those, so every list below is empty.
   */
  automated: boolean;
  /** The name they are most often shown with, if any. */
  name: string | null;
  /** Other addresses seen with exactly the same full name. */
  otherAddresses: string[];
  /** Newest first, at most `PERSON_CARD_CONVERSATION_LIMIT`. */
  conversations: PersonCardConversation[];
  /** Files on their messages whose details are stored here, newest first. */
  files: Array<{
    accountId: string;
    conversationId: string;
    messageId: string;
    receivedAtMs: number;
    attachment: MessageAttachmentDescriptor;
  }>;
  /** Null for a side with too few replies to say. */
  replyLag: { theirs: ReplyLag | null; yours: ReplyLag | null };
  /** Conversations Cue's reply tracking says wait on your reply. */
  awaitingYou: PersonCardConversation[];
  /** Conversations Cue's reply tracking says wait on theirs. */
  awaitingThem: PersonCardConversation[];
  /**
   * `syncing` while older mail is still arriving; `sinceMs` when the store
   * only ever holds mail from that time on.
   */
  history: { syncing: boolean; sinceMs: number | null };
};

/** One more than the card lists, so it can leave out the open conversation. */
export const PERSON_CARD_CONVERSATION_LIMIT = 6;

/** The groups the Files view filters attachments by. */
export const FILE_KINDS = [
  "document",
  "spreadsheet",
  "presentation",
  "pdf",
  "image",
  "other",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/**
 * Every attachment on stored mail, read from the local store alone: it never
 * asks the provider. Inline images such as signature logos are left out, as
 * local search leaves them out, and so is mail in Trash, Spam and Drafts.
 */
export type FilesQuery = {
  /** One account, or every account All inboxes includes. */
  accountIds: string[];
  kind: FileKind | null;
  /** Only files on mail from this address. */
  sender: string | null;
  /** Words in the file's name, matched the way local search matches them. */
  name: string | null;
  pageSize: number;
  after: string | null;
};

export type FileEntry = {
  accountId: string;
  conversationId: string;
  messageId: string;
  subject: string;
  /** The message's sender as stored, such as `Ana Lima <ana@example.com>`. */
  from: string;
  receivedAtMs: number;
  kind: FileKind;
  attachment: MessageAttachmentDescriptor;
  /**
   * How many messages of this conversation carry this file (same name and
   * size) among those matching the query. The entry is from the newest.
   */
  copies: number;
};

/** Newest first. */
export type FilesPage = { files: FileEntry[]; nextPage: string | null };

/** Who sent the files a Files view can list, most files first. */
export type FileSender = { email: string; name: string | null; files: number };

/**
 * Conversations that may wait on the user's reply, read from the local store
 * alone, with no model: the newest message is someone else's, it is in the
 * inbox's main tab, and nothing the user sent follows it. The sender must be
 * someone the user has written to, or the user must have written in the
 * conversation, so mailing lists and strangers stay out.
 */
export type WaitingOnYouQuery = {
  accountIds: string[];
  /** The user's own addresses: their mail is never waiting on them. */
  ownAddresses: string[];
  /** Mail received before this is left out. */
  receivedSinceMs: number;
  /** Per account, labels or categories whose mail is left out. */
  excludedLabelIds?: Record<string, string[]>;
  limit: number;
};

/** Newest first; the message is the conversation's newest. */
export type WaitingOnYouConversation = {
  accountId: string;
  conversationId: string;
  messageId: string;
  from: string;
  subject: string;
  preview: string;
  receivedAtMs: number;
  unread: boolean;
  starred: boolean;
};

/**
 * Senders who mail often and are never opened, read from the local store
 * alone, with no model: mail received since `receivedSinceMs` in each
 * account, grouped by sender address.
 */
export type NeverReadSendersQuery = {
  accountIds: string[];
  /** The user's own addresses, which are never listed. */
  ownAddresses: string[];
  receivedSinceMs: number;
  /** The most to list; read past what will show, so hidden ones can be skipped. */
  limit: number;
};

/** Most inbox messages first, then the newest. */
export type NeverReadSender = {
  accountId: string;
  email: string;
  /** The name their newest message is shown with, if any. */
  name: string | null;
  /** Their messages in the inbox, none of which, nor any other, was read. */
  count: number;
  lastReceivedAtMs: number;
};

/** Fewer messages than this say little about whether they're wanted. */
export const NEVER_READ_MIN_MESSAGES = 4;
