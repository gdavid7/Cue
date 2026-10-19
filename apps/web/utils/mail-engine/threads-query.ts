import {
  MAX_MESSAGE_PREDICATE_IDS,
  type ConversationQuery,
  type MailPredicate,
} from "@inboxzero/mail-core/queries";
import { isOutlookInboxSection } from "@/utils/outlook/inbox-sections";
import {
  type CueMembership,
  isCueFilterValue,
  splitUsesCue,
} from "@/utils/split-inbox/cue-filter";
import {
  gmailTokenToPredicate,
  type SearchQueryContext,
  searchQueryToPredicate,
} from "@/utils/mail-search/search-query-predicate";
import type {
  ThreadsQuery,
  ThreadsQueryLeaf,
} from "@/utils/threads/validation";

export function threadsQueryToConversationQuery(input: {
  accountIds: string[];
  query: ThreadsQuery;
  pageSize?: number;
  after?: string | null;
  search?: Partial<SearchQueryContext>;
}): ConversationQuery {
  return {
    accountIds: input.accountIds,
    predicate: threadsQueryToPredicate(input.query, undefined, input.search),
    order: "newest_first",
    pageSize: input.pageSize ?? 50,
    after: input.after ?? null,
  };
}

/**
 * Leaves out drafts that a pending send stands in for, so a conversation counts
 * as a draft only through drafts that are still shown.
 */
export function withoutHiddenDrafts(
  predicate: MailPredicate,
  hiddenDraftMessageIds: string[],
): MailPredicate {
  if (!hiddenDraftMessageIds.length) return predicate;
  return {
    kind: "all",
    predicates: [
      predicate,
      {
        kind: "not",
        predicate: {
          kind: "message",
          ids: hiddenDraftMessageIds.slice(-MAX_MESSAGE_PREDICATE_IDS),
        },
      },
    ],
  };
}

export function threadsQueryUsesCue(query: ThreadsQuery) {
  return Boolean(
    query.cue?.length ||
      query.anyOf?.some((leaf) => leaf.cue) ||
      query.excludeSplits?.some(splitUsesCue),
  );
}

/**
 * `cueMembership` backs conditions on mail Cue sorted itself. Without it those
 * conditions match nothing, so a tab never widens to the whole inbox while its
 * membership loads.
 */
export function threadsQueryToPredicate(
  query: ThreadsQuery,
  cueMembership?: CueMembership,
  search?: Partial<SearchQueryContext>,
): MailPredicate {
  const clauses: MailPredicate[] = [];
  const searched = query.q
    ? searchQueryToPredicate(query.q, { now: new Date(), ...search })
    : null;
  // Kept flat, so the search's text stays where the store's index drives it.
  if (searched?.kind === "all") clauses.push(...searched.predicates);
  else if (searched) clauses.push(searched);
  if (query.type === "unread") {
    clauses.push({ kind: "role", role: "inbox" });
    clauses.push({ kind: "read", value: false });
  } else if (
    query.type === "inbox" ||
    query.type === "sent" ||
    query.type === "draft" ||
    query.type === "trash" ||
    query.type === "spam"
  ) {
    clauses.push({
      kind: "mailbox",
      mailbox: query.type === "draft" ? "drafts" : query.type,
    });
  } else if (query.type === "archive") {
    clauses.push({ kind: "mailbox", mailbox: "archive" });
  } else if (query.type === "starred") {
    clauses.push({ kind: "mailbox", mailbox: "starred" });
  } else if (query.type === "snoozed") {
    clauses.push({ kind: "mailbox", mailbox: "snoozed" });
  } else if (query.type === "all") {
    clauses.push({ kind: "mailbox", mailbox: "all" });
  } else if (query.type === "important") {
    // Gmail's Important view spans the mailbox, not just the inbox.
    clauses.push({ kind: "mailbox", mailbox: "all" });
    clauses.push(gmailTokenToPredicate("IMPORTANT"));
  } else if (query.type?.startsWith("CATEGORY_")) {
    clauses.push(gmailTokenToPredicate(query.type));
  } else if (
    !query.q &&
    !query.labelId &&
    !query.folderId &&
    !query.labelIds?.length
  ) {
    clauses.push({ kind: "role", role: "inbox" });
  }
  if (query.inboxSection) {
    clauses.push({ kind: "inbox_section", section: query.inboxSection });
  }
  if (query.isUnread) clauses.push({ kind: "read", value: false });
  if (query.fromEmail) {
    clauses.push({
      kind: "address",
      field: "from",
      value: query.fromEmail,
      match: "address",
    });
  }
  if (query.labelId) clauses.push(gmailTokenToPredicate(query.labelId));
  for (const labelId of query.labelIds ?? []) {
    clauses.push(gmailTokenToPredicate(labelId));
  }
  if (query.anyLabelIds?.length) {
    clauses.push({
      kind: "any",
      predicates: query.anyLabelIds.map(gmailTokenToPredicate),
    });
  }
  if (query.folderId) {
    clauses.push({
      kind: "membership",
      membership: "folder",
      id: query.folderId,
    });
  }
  if (query.after || query.before) {
    clauses.push({
      kind: "received",
      afterMs: query.after ? query.after.getTime() : null,
      beforeMs: query.before ? query.before.getTime() : null,
    });
  }
  for (const value of query.cue ?? []) {
    clauses.push(cuePredicate(value, cueMembership));
  }
  if (query.anyOf?.length) {
    clauses.push({
      kind: "any",
      predicates: query.anyOf.map((leaf) =>
        leafToPredicate(leaf, cueMembership),
      ),
    });
  }
  if (query.excludeSplits?.length) {
    clauses.push({
      kind: "not",
      predicate: {
        kind: "any",
        predicates: query.excludeSplits.map((split) => ({
          kind: split.matchAll ? "all" : "any",
          predicates: split.filters.map((filter) =>
            splitFilterToPredicate(filter, cueMembership),
          ),
        })),
      },
    });
  }
  if (clauses.length === 0) return { kind: "role", role: "inbox" };
  if (clauses.length === 1) return clauses[0];
  return { kind: "all", predicates: clauses };
}

function leafToPredicate(
  leaf: ThreadsQueryLeaf,
  cueMembership: CueMembership | undefined,
): MailPredicate {
  if (leaf.cue) return cuePredicate(leaf.cue, cueMembership);
  if (leaf.inboxSection) {
    return { kind: "inbox_section", section: leaf.inboxSection };
  }
  if (leaf.labelId) return gmailTokenToPredicate(leaf.labelId);
  if (leaf.fromEmail) {
    return {
      kind: "address",
      field: "from",
      value: leaf.fromEmail,
      match: "address",
    };
  }
  return { kind: "read", value: false };
}

function splitFilterToPredicate(
  filter: { kind: string; value?: string | null },
  cueMembership: CueMembership | undefined,
): MailPredicate {
  if (filter.kind === "CUE") {
    return isCueFilterValue(filter.value)
      ? cuePredicate(filter.value, cueMembership)
      : { kind: "message", ids: [] };
  }
  if (filter.kind === "UNREAD") return { kind: "read", value: false };
  if (filter.kind === "STARRED") return { kind: "starred", value: true };
  if (filter.kind === "FROM" && filter.value) {
    return {
      kind: "address",
      field: "from",
      value: filter.value,
      match: "address",
    };
  }
  if (
    filter.kind === "CATEGORY" &&
    filter.value &&
    isOutlookInboxSection(filter.value)
  ) {
    return { kind: "inbox_section", section: filter.value };
  }
  return gmailTokenToPredicate(filter.value || "INBOX");
}

function cuePredicate(
  value: keyof CueMembership,
  cueMembership: CueMembership | undefined,
): MailPredicate {
  return {
    kind: "message",
    ids: (cueMembership?.[value] ?? []).slice(0, MAX_MESSAGE_PREDICATE_IDS),
  };
}
