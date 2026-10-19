import type { EmailProvider, EmailThread } from "@/utils/email/types";
import { searchReachesSpamOrTrash } from "@/utils/mail-search/search-query-predicate";
import { GmailLabel } from "@/utils/gmail/label";
import { mergePaginatedSources } from "@/utils/threads/merge-paginated-sources";
import { getThreadTimestamp } from "@/utils/threads/sort";
import type { ThreadsQuery } from "@/utils/threads/validation";

import { getCueMembership } from "@/utils/split-inbox/cue-membership.server";
import {
  createOtherSplitFilter,
  createThreadsQueryFilter,
} from "@/utils/split-inbox/thread-matches-split";

const LABEL_CONCURRENCY = 4;

/**
 * `anyLabelIds` has no provider equivalent — Gmail's `labelIds` and Graph's
 * category filter both mean "all of these". Two or more labels are served by
 * running one query per label and merging them newest-first.
 */
export async function fetchThreadsPage({
  query,
  emailProvider,
  emailAccountId,
  maxResults,
  pageToken,
  messageFormat,
}: {
  query: ThreadsQuery;
  emailProvider: EmailProvider;
  emailAccountId: string;
  maxResults: number;
  pageToken?: string;
  messageFormat: "full" | "metadata";
}): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
  if (query.excludeSplits?.length) {
    const { excludeSplits, ...base } = query;
    const usesCue = excludeSplits.some((split) =>
      split.filters.some((filter) => filter.kind === "CUE"),
    );
    const cueMembership = usesCue
      ? await getCueMembership({ emailAccountId })
      : undefined;
    return fetchFilteredPages({
      query: base,
      matches: createOtherSplitFilter(excludeSplits, new Date(), cueMembership),
      emailProvider,
      emailAccountId,
      maxResults,
      pageToken,
      messageFormat,
    });
  }

  // Mail Cue sorted itself has no mailbox label to query, so the provider
  // lists the rest of the query and Cue's own records narrow it.
  const anyOfUsesCue = query.anyOf?.some((leaf) => leaf.cue) ?? false;
  if (query.cue?.length || anyOfUsesCue) {
    const { cue, anyOf, ...rest } = query;
    const cueMembership = await getCueMembership({ emailAccountId });
    return fetchFilteredPages({
      query: anyOfUsesCue ? rest : { ...rest, anyOf },
      matches: createThreadsQueryFilter(
        { cue, anyOf: anyOfUsesCue ? anyOf : undefined },
        cueMembership,
      ),
      emailProvider,
      emailAccountId,
      maxResults,
      pageToken,
      messageFormat,
    });
  }

  if (query.q) {
    const folder = spamTrashFolder(query);
    const includeSpamTrash =
      Boolean(folder) || searchReachesSpamOrTrash(query.q, emailProvider.name);
    return emailProvider.searchThreads({
      query: query.q,
      maxResults,
      pageToken,
      messageFormat,
      ...(includeSpamTrash ? { includeSpamTrash: true } : {}),
      ...(folder ? { folder } : {}),
    });
  }

  if (query.anyOf?.length) {
    const merged = await mergePaginatedSources({
      sources: query.anyOf.map((condition, index) => ({
        id: String(index),
        condition,
      })),
      cursor: pageToken ?? null,
      limit: maxResults,
      concurrency: LABEL_CONCURRENCY,
      compare: (left, right) =>
        getThreadTimestamp(right) - getThreadTimestamp(left),
      getItemId: (thread: EmailThread) => thread.id,
      dedupeItemKey: (thread) => thread.id,
      loadPage: async ({ source, pageToken }) => {
        const { anyOf: _anyOf, ...base } = query;
        // Cue-sorted branches never reach the provider; they're handled above.
        const { labelId, cue: _cue, ...condition } = source.condition;
        let requiredLabelIds = ["INBOX"];
        if (base.labelIds?.length) requiredLabelIds = base.labelIds;
        else if (base.labelId) requiredLabelIds = [base.labelId];
        const page = await emailProvider.getThreadsWithQuery({
          query: {
            ...base,
            ...condition,
            labelIds: labelId
              ? [...requiredLabelIds, labelId]
              : requiredLabelIds,
          },
          maxResults,
          pageToken,
          messageFormat,
        });
        return { items: page.threads, nextPageToken: page.nextPageToken };
      },
      onSourceError: ({ error }) => {
        throw error;
      },
    });
    return {
      threads: merged.items,
      nextPageToken: merged.nextPageToken ?? undefined,
    };
  }

  // A repeated label would run the same query twice and collide in the cursor.
  const anyLabelIds = [...new Set(query.anyLabelIds ?? [])];
  let requiredLabelIds = query.labelIds ?? [];
  if (!requiredLabelIds.length && query.labelId) {
    requiredLabelIds = [query.labelId];
  }
  const queryForLabels = (labelIds: string[]): ThreadsQuery => ({
    ...query,
    anyLabelIds: undefined,
    labelIds: [...requiredLabelIds, ...labelIds],
  });

  if (anyLabelIds.length < 2) {
    return emailProvider.getThreadsWithQuery({
      query: anyLabelIds.length ? queryForLabels(anyLabelIds) : query,
      maxResults,
      pageToken,
      messageFormat,
    });
  }

  const merged = await mergePaginatedSources({
    sources: anyLabelIds.map((labelId) => ({ id: labelId })),
    cursor: pageToken ?? null,
    limit: maxResults,
    concurrency: LABEL_CONCURRENCY,
    compare: (left, right) =>
      getThreadTimestamp(right) - getThreadTimestamp(left),
    getItemId: (thread: EmailThread) => thread.id,
    // A thread carrying several of the labels must still show up once.
    dedupeItemKey: (thread) => thread.id,
    loadPage: async ({ source, pageToken: labelPageToken }) => {
      const page = await emailProvider.getThreadsWithQuery({
        query: queryForLabels([source.id]),
        maxResults,
        pageToken: labelPageToken,
        messageFormat,
      });
      return { items: page.threads, nextPageToken: page.nextPageToken };
    },
    // Dropping a failed label would silently narrow the split.
    onSourceError: ({ error }) => {
      throw error;
    },
  });

  return {
    threads: merged.items,
    nextPageToken: merged.nextPageToken ?? undefined,
  };
}

function spamTrashFolder(query: ThreadsQuery): "spam" | "trash" | undefined {
  if (query.type === "spam" || query.type === "trash") return query.type;
  const labels = [query.labelId, ...(query.labelIds ?? [])];
  if (labels.includes(GmailLabel.SPAM)) return "spam";
  if (labels.includes(GmailLabel.TRASH)) return "trash";
}

/**
 * Bounds sparse scans per request. Returning the continuation, even with an
 * empty page, lets the reader keep going without losing messages.
 */
async function fetchFilteredPages({
  query,
  matches,
  emailProvider,
  emailAccountId,
  maxResults,
  pageToken,
  messageFormat,
}: {
  query: ThreadsQuery;
  matches: (thread: EmailThread) => boolean;
  emailProvider: EmailProvider;
  emailAccountId: string;
  maxResults: number;
  pageToken?: string;
  messageFormat: "full" | "metadata";
}): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
  const threads: EmailThread[] = [];
  let nextPageToken = pageToken;
  for (let page = 0; page < 5; page++) {
    const result = await fetchThreadsPage({
      query,
      emailProvider,
      emailAccountId,
      maxResults: maxResults - threads.length,
      pageToken: nextPageToken,
      messageFormat,
    });
    threads.push(...result.threads.filter(matches));
    nextPageToken = result.nextPageToken;
    if (!nextPageToken || threads.length >= maxResults) break;
  }
  return { threads, nextPageToken };
}
