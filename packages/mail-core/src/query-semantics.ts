import type { MetadataChange } from "./commands";
import { applyMetadataChange } from "./effective-state";
import { type MessageMetadata, normalizeInternetMessageId } from "./messages";
import { MAX_MESSAGE_PREDICATE_IDS, type MailPredicate } from "./queries";

export type EffectiveMessage = MessageMetadata & {
  accountId: string;
  messageId: string;
  conversationId: string;
  pendingOperationIds: string[];
  bodyText?: string | null;
  snoozedUntilMs?: number | null;
};

export function messageMatchesPredicate(
  message: EffectiveMessage,
  predicate: MailPredicate,
): boolean {
  switch (predicate.kind) {
    case "all":
      return predicate.predicates.every((child) =>
        messageMatchesPredicate(message, child),
      );
    case "any":
      return predicate.predicates.some((child) =>
        messageMatchesPredicate(message, child),
      );
    case "not":
      return !messageMatchesPredicate(message, predicate.predicate);
    case "role":
      return message.roles.includes(predicate.role);
    case "mailbox":
      return messageMatchesMailbox(message, predicate.mailbox);
    case "read":
      return message.read === predicate.value;
    case "starred":
      return message.starred === predicate.value;
    case "inbox_section":
      return message.inboxSection === predicate.section;
    case "membership":
      if (predicate.accountId && message.accountId !== predicate.accountId) {
        return false;
      }
      if (predicate.membership === "folder") {
        return message.folderId === predicate.id;
      }
      if (predicate.membership === "label") {
        return message.labelIds.includes(predicate.id);
      }
      return message.categoryIds.includes(predicate.id);
    case "address":
      return addressMatches(
        message,
        predicate.field,
        predicate.value,
        predicate.match,
      );
    case "received":
      if (
        predicate.afterMs !== null &&
        message.receivedAtMs < predicate.afterMs
      ) {
        return false;
      }
      if (
        predicate.beforeMs !== null &&
        message.receivedAtMs >= predicate.beforeMs
      ) {
        return false;
      }
      return true;
    case "has_attachment":
      return message.hasAttachments === predicate.value;
    case "message":
      if (predicate.accountId && predicate.accountId !== message.accountId)
        return false;
      return predicate.ids.includes(message.messageId);
    case "conversation":
      if (predicate.accountId && predicate.accountId !== message.accountId)
        return false;
      return predicate.ids.includes(message.conversationId);
    // Alone, a message is its own conversation's latest; the conversation
    // matchers below decide it by the conversation's key instead.
    case "internet_message_id":
      return keyMatches(
        predicate,
        message.accountId,
        normalizeInternetMessageId(message.internetMessageId),
      );
    case "text":
      return textMatches(
        message,
        predicate.field,
        predicate.value,
        predicate.match,
      );
    case "search":
      if (
        predicate.accountIds &&
        !predicate.accountIds.includes(message.accountId)
      )
        return false;
      return messageMatchesPredicate(message, predicate.local);
    case "account":
      return predicate.ids.includes(message.accountId);
    default: {
      const exhaustive: never = predicate;
      return exhaustive;
    }
  }
}

export function conversationMatchesPredicate(
  messages: EffectiveMessage[],
  predicate: MailPredicate,
): boolean {
  if (predicate.kind === "mailbox") {
    return conversationMatchesMailbox(messages, predicate.mailbox);
  }
  const bound = withConversationKey(predicate, messages);
  return messages.some((message) => messageMatchesPredicate(message, bound));
}

export function conversationIsUnread(
  messages: EffectiveMessage[],
  predicate: MailPredicate,
): boolean {
  const bound = withConversationKey(predicate, messages);
  return messages.some(
    (message) =>
      messageMatchesPredicate(message, bound) && message.read === false,
  );
}

/**
 * A conversation's key: the normalised Message-ID of its latest message that
 * isn't a draft or in the trash (sent mail counts), else of its latest. One
 * message delivered to several accounts has the same key in each, as the
 * local store's conversation_message_keys has it.
 */
export function conversationMessageKey(
  messages: EffectiveMessage[],
): string | null {
  const latest = [...messages].sort(
    (a, b) =>
      Number(isKeyed(b)) - Number(isKeyed(a)) ||
      b.receivedAtMs - a.receivedAtMs ||
      (b.messageId > a.messageId ? 1 : b.messageId < a.messageId ? -1 : 0),
  )[0];
  return normalizeInternetMessageId(latest?.internetMessageId);
}

/**
 * Whether a conversation matches `predicate` once `change` has been applied
 * to every message in it, as conversation triage does. True or false when the
 * change alone decides it; null when the answer also depends on what the
 * change leaves alone, such as a label or the sender. Lets a view drop or keep
 * a row before the engine has written the change.
 */
export function conversationMatchesAfterChange(
  predicate: MailPredicate,
  change: MetadataChange,
): boolean | null {
  switch (predicate.kind) {
    case "all": {
      let unknown = false;
      for (const child of predicate.predicates) {
        const result = conversationMatchesAfterChange(child, change);
        if (result === false) return false;
        if (result === null) unknown = true;
      }
      return unknown ? null : true;
    }
    case "any": {
      let unknown = false;
      for (const child of predicate.predicates) {
        const result = conversationMatchesAfterChange(child, change);
        if (result === true) return true;
        if (result === null) unknown = true;
      }
      return unknown ? null : false;
    }
    case "not": {
      const result = conversationMatchesAfterChange(
        predicate.predicate,
        change,
      );
      return result === null ? null : !result;
    }
    case "search": {
      // The provider's own matches keep a conversation the local part drops
      // unless the change rules out the whole query.
      const local = conversationMatchesAfterChange(predicate.local, change);
      if (local === true) return true;
      const possible = conversationMatchesAfterChange(
        predicate.possible,
        change,
      );
      return local === false && possible === false ? false : null;
    }
    case "role":
    case "mailbox":
    case "read":
    case "starred":
    case "membership": {
      // The change sets the same value on every message. Applied to a message
      // with every flag set and to one with none, it decides the predicate
      // only where both give the same answer.
      const matchesAfter = (probe: EffectiveMessage) =>
        messageMatchesPredicate(
          { ...probe, ...applyMetadataChange(probe, change) },
          predicate,
        );
      const fromEverything = matchesAfter(probeMessage(predicate, true));
      const fromNothing = matchesAfter(probeMessage(predicate, false));
      return fromEverything === fromNothing ? fromEverything : null;
    }
    default:
      // No metadata change touches the section, addresses, dates,
      // attachments, message ids or text.
      return null;
  }
}

/**
 * The parts of a predicate the provider is asked to search for: each typed
 * search as a whole, and each text condition outside one.
 */
export function extractProviderSearches(
  predicate: MailPredicate,
): Array<Extract<MailPredicate, { kind: "text" | "search" }>> {
  if (predicate.kind === "text" || predicate.kind === "search")
    return [predicate];
  if (predicate.kind === "all" || predicate.kind === "any") {
    return predicate.predicates.flatMap(extractProviderSearches);
  }
  if (predicate.kind === "not") {
    return extractProviderSearches(predicate.predicate);
  }
  return [];
}

export type ProviderSearchMatches = Array<{
  accountId: string;
  messageIds: string[];
}>;

/**
 * Replaces each typed search with its local part, or with its local part or
 * the messages `providerMatches` says the provider's search returned for it,
 * each account's apart, that still meet the search's `possible` part. A
 * search nested in an `all` is spliced into it, so a text condition in it
 * stays at the top level, where the store drives the query from its index.
 */
export function resolveSearchPredicates(
  predicate: MailPredicate,
  providerMatches: (
    search: Extract<MailPredicate, { kind: "search" }>,
  ) => ProviderSearchMatches,
): MailPredicate {
  switch (predicate.kind) {
    case "search": {
      const local = resolveSearchPredicates(predicate.local, providerMatches);
      const messages: MailPredicate[] = providerMatches(predicate).flatMap(
        ({ accountId, messageIds }) =>
          messageIds.length
            ? [
                {
                  kind: "message" as const,
                  accountId,
                  ids: messageIds.slice(-MAX_MESSAGE_PREDICATE_IDS),
                },
              ]
            : [],
      );
      const resolved: MailPredicate = messages.length
        ? {
            kind: "any",
            predicates: [
              local,
              isAlwaysTrue(predicate.possible)
                ? chunkedAny(messages)
                : {
                    kind: "all",
                    predicates: [predicate.possible, chunkedAny(messages)],
                  },
            ],
          }
        : local;
      if (!predicate.accountIds) return resolved;
      const accounts: MailPredicate = {
        kind: "account",
        ids: predicate.accountIds,
      };
      return {
        kind: "all",
        predicates:
          resolved.kind === "all"
            ? [accounts, ...resolved.predicates]
            : [accounts, resolved],
      };
    }
    case "all":
      return {
        kind: "all",
        predicates: predicate.predicates.flatMap((child) => {
          const resolved = resolveSearchPredicates(child, providerMatches);
          return child.kind === "search" && resolved.kind === "all"
            ? resolved.predicates
            : [resolved];
        }),
      };
    case "any":
      return {
        kind: "any",
        predicates: predicate.predicates.map((child) =>
          resolveSearchPredicates(child, providerMatches),
        ),
      };
    case "not":
      return {
        kind: "not",
        predicate: resolveSearchPredicates(
          predicate.predicate,
          providerMatches,
        ),
      };
    default:
      return predicate;
  }
}

// The schema allows this many children per any.
const MAX_CHILDREN = 32;

function chunkedAny(predicates: MailPredicate[]): MailPredicate {
  if (predicates.length === 1) return predicates[0];
  if (predicates.length <= MAX_CHILDREN) return { kind: "any", predicates };
  const chunks: MailPredicate[] = [];
  for (let index = 0; index < predicates.length; index += MAX_CHILDREN)
    chunks.push(chunkedAny(predicates.slice(index, index + MAX_CHILDREN)));
  return chunkedAny(chunks);
}

function isAlwaysTrue(predicate: MailPredicate) {
  return predicate.kind === "all" && predicate.predicates.length === 0;
}

function addressMatches(
  message: EffectiveMessage,
  field: "from" | "to" | "cc" | "bcc",
  value: string,
  match: "address" | "domain",
): boolean {
  const candidates = {
    from: [message.from],
    to: message.to,
    cc: message.cc,
    bcc: message.bcc ?? [],
  }[field];
  const needle = value.toLowerCase();
  return candidates.some((candidate) => {
    const email = extractEmail(candidate).toLowerCase();
    if (match === "address")
      return email === needle || candidate.toLowerCase().includes(needle);
    const domain = email.split("@")[1] ?? "";
    return domain === needle || domain.endsWith(`.${needle}`);
  });
}

function textMatches(
  message: EffectiveMessage,
  field: "any" | "subject" | "body",
  value: string,
  match: "term" | "phrase",
): boolean {
  const haystacks =
    field === "subject"
      ? [message.subject]
      : field === "body"
        ? [message.bodyText ?? message.preview]
        : [
            message.subject,
            message.preview,
            message.bodyText ?? "",
            message.from,
          ];
  const needle = value.toLowerCase();
  return haystacks.some((haystack) => {
    const text = haystack.toLowerCase();
    if (match === "phrase") return text.includes(needle);
    return needle.split(/\s+/).every((term) => text.includes(term));
  });
}

function extractEmail(value: string): string {
  const start = value.indexOf("<");
  const end = value.indexOf(">", start + 1);
  if (start >= 0 && end > start) {
    return value.slice(start + 1, end).trim();
  }
  return value.trim();
}

function messageMatchesMailbox(
  message: EffectiveMessage,
  mailbox: Extract<MailPredicate, { kind: "mailbox" }>["mailbox"],
): boolean {
  switch (mailbox) {
    case "inbox":
      return message.roles.includes("inbox");
    case "sent":
      return message.roles.includes("sent");
    case "drafts":
      return message.roles.includes("draft");
    case "trash":
      return message.roles.includes("trash");
    case "spam":
      return message.roles.includes("spam");
    case "starred":
      return message.starred;
    case "archive":
      return (
        !message.roles.includes("inbox") &&
        !message.roles.includes("trash") &&
        !message.roles.includes("spam")
      );
    case "all":
      return (
        !message.roles.includes("trash") && !message.roles.includes("spam")
      );
    case "snoozed":
      return (message.snoozedUntilMs ?? 0) > Date.now();
  }
}

function conversationMatchesMailbox(
  messages: EffectiveMessage[],
  mailbox: Extract<MailPredicate, { kind: "mailbox" }>["mailbox"],
): boolean {
  if (messages.length === 0) return false;
  if (mailbox === "archive") {
    return messages.every((message) =>
      messageMatchesMailbox(message, "archive"),
    );
  }
  if (mailbox === "all") {
    return messages.every((message) => messageMatchesMailbox(message, "all"));
  }
  if (mailbox === "snoozed") {
    return messages.some((message) =>
      messageMatchesMailbox(message, "snoozed"),
    );
  }
  return messages.some((message) => messageMatchesMailbox(message, mailbox));
}

function probeMessage(
  predicate: Extract<
    MailPredicate,
    { kind: "role" | "mailbox" | "read" | "starred" | "membership" }
  >,
  everything: boolean,
): EffectiveMessage {
  const id = predicate.kind === "membership" ? predicate.id : "probe";
  return {
    accountId:
      predicate.kind === "membership" && predicate.accountId
        ? predicate.accountId
        : "probe",
    messageId: "probe",
    conversationId: "probe",
    pendingOperationIds: [],
    subject: "",
    preview: "",
    from: "",
    to: [],
    cc: [],
    receivedAtMs: 0,
    hasAttachments: false,
    inboxSection: null,
    read: everything,
    starred: everything,
    folderId: everything ? id : null,
    labelIds: everything ? [id] : [],
    categoryIds: everything ? [id] : [],
    roles: everything ? ["inbox", "sent", "draft", "trash", "spam"] : [],
    snoozedUntilMs: everything ? Number.MAX_SAFE_INTEGER : null,
  };
}

const ALWAYS: MailPredicate = { kind: "all", predicates: [] };
const NEVER: MailPredicate = { kind: "any", predicates: [] };

/**
 * The predicate with each `internet_message_id` decided for this
 * conversation by its key, which no single message can answer.
 */
function withConversationKey(
  predicate: MailPredicate,
  messages: EffectiveMessage[],
): MailPredicate {
  if (!mentionsMessageKeys(predicate)) return predicate;
  const key = conversationMessageKey(messages);
  const accountId = messages[0]?.accountId ?? "";
  const bind = (node: MailPredicate): MailPredicate => {
    switch (node.kind) {
      case "internet_message_id":
        return keyMatches(node, accountId, key) ? ALWAYS : NEVER;
      case "all":
      case "any":
        return { ...node, predicates: node.predicates.map(bind) };
      case "not":
        return { ...node, predicate: bind(node.predicate) };
      case "search":
        return { ...node, local: bind(node.local) };
      default:
        return node;
    }
  };
  return bind(predicate);
}

function mentionsMessageKeys(predicate: MailPredicate): boolean {
  switch (predicate.kind) {
    case "internet_message_id":
      return true;
    case "all":
    case "any":
      return predicate.predicates.some(mentionsMessageKeys);
    case "not":
      return mentionsMessageKeys(predicate.predicate);
    case "search":
      return mentionsMessageKeys(predicate.local);
    default:
      return false;
  }
}

/** Keys are compared as stored: the ids given are keys already. */
function keyMatches(
  predicate: Extract<MailPredicate, { kind: "internet_message_id" }>,
  accountId: string,
  key: string | null,
) {
  if (predicate.accountId && predicate.accountId !== accountId) return false;
  return key !== null && predicate.ids.includes(key);
}

function isKeyed(message: EffectiveMessage) {
  return !message.roles.includes("draft") && !message.roles.includes("trash");
}
