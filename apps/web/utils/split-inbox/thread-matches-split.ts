import { internalDateToDate } from "@/utils/date";
import type {
  CueFilterValue,
  CueMembership,
} from "@/utils/split-inbox/cue-filter";
import { matchesSenderFilter } from "@/utils/split-inbox/sender-filter";
import type { ParsedMessage } from "@/utils/types";
import { mailSplitToThreadsQuery } from "@/utils/split-inbox/split-query";
import type {
  ThreadsQuery,
  ThreadsQueryLeaf,
} from "@/utils/threads/validation";

type SplitMessage = Pick<
  ParsedMessage,
  "id" | "labelIds" | "headers" | "internalDate" | "inboxSection"
>;
type SplitThread = { messages: SplitMessage[] };

export function createOtherSplitFilter(
  splits: NonNullable<ThreadsQuery["excludeSplits"]>,
  now: Date = new Date(),
  cueMembership?: CueMembership,
) {
  const matchers = splits
    .filter((split) => split.filters.length)
    .map((split) =>
      createThreadsQueryFilter(
        mailSplitToThreadsQuery(
          {
            ...split,
            filters: split.filters.map((filter) => ({
              ...filter,
              value: filter.value ?? null,
            })),
          },
          now,
        ),
        cueMembership,
      ),
    );
  return (thread: SplitThread): boolean =>
    !matchers.some((matches) => matches(thread));
}

/**
 * Evaluates a split's query against loaded conversations, for conditions the
 * provider can't answer itself. Gmail matches all AND conditions on the same
 * message, so the full conversation is inspected one message at a time.
 */
export function createThreadsQueryFilter(
  query: ThreadsQuery,
  cueMembership?: CueMembership,
) {
  const cueSets = cueMembership && {
    TO_REPLY: new Set(cueMembership.TO_REPLY),
    NEWSLETTER: new Set(cueMembership.NEWSLETTER),
    MARKETING: new Set(cueMembership.MARKETING),
  };
  return (thread: SplitThread): boolean =>
    thread.messages.some(
      (message) =>
        matchesMessage(message, query, cueSets) &&
        (!query.anyOf?.length ||
          query.anyOf.some((condition) =>
            matchesMessage(message, condition, cueSets),
          )),
    );
}

function matchesMessage(
  message: SplitMessage,
  query: ThreadsQuery | ThreadsQueryLeaf,
  cueSets: Record<CueFilterValue, Set<string>> | undefined,
): boolean {
  const labels = message.labelIds ?? [];
  if (
    "labelIds" in query &&
    query.labelIds?.some((label) => !labels.includes(label))
  )
    return false;
  if (query.labelId && !labels.includes(query.labelId)) return false;
  if (query.isUnread && !labels.includes("UNREAD")) return false;
  if (query.inboxSection && message.inboxSection !== query.inboxSection)
    return false;
  if (
    query.fromEmail &&
    !matchesSenderFilter(message.headers.from, query.fromEmail)
  )
    return false;
  if (query.before) {
    const timestamp = internalDateToDate(message.internalDate, {
      fallbackToNow: false,
    }).getTime();
    if (
      !Number.isFinite(timestamp) ||
      timestamp >= Math.floor(query.before.getTime() / 1000) * 1000
    )
      return false;
  }
  const cueValues = typeof query.cue === "string" ? [query.cue] : query.cue;
  if (cueValues?.some((value) => !cueSets?.[value].has(message.id)))
    return false;
  return true;
}
