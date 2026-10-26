import { z } from "zod";

// The most messages one searchInbox call returns, wherever it is answered.
export const SEARCH_INBOX_MAX_RESULTS = 20;

// What one local answer may hold. The browser clamps to these before it
// answers, so an oversized field shortens a result instead of losing it.
export const LOCAL_SEARCH_LIMITS = {
  messages: SEARCH_INBOX_MAX_RESULTS,
  id: 256,
  subject: 500,
  address: 500,
  recipients: 2000,
  snippet: 500,
  labels: 50,
  pageToken: 1024,
} as const;

const localUnavailableReasonSchema = z.enum([
  "no_engine",
  "unsupported_query",
  "not_synced",
  "not_indexed",
  "timeout",
  "error",
]);

// How chat's countEmails groups the mail it counts.
export const COUNT_GROUP_BY = ["sender", "month", "week", "label"] as const;
export type CountGroupBy = (typeof COUNT_GROUP_BY)[number];

// What one local count may hold: totals, a few groups and a few examples.
export const LOCAL_COUNT_LIMITS = {
  groups: 12,
  newest: 5,
  // The chat's account and the other accounts chat searches.
  accounts: 11,
  // A month (2026-10) or a week's Monday (2026-10-19), or a label id.
  groupKey: 256,
} as const;

/** One account's search in a count the assistant asks the browser for. */
export type LocalCountSearch = {
  accountId: string;
  query: string;
} & (
  | { syntax?: "gmail" }
  | {
      syntax: "outlook";
      fromEmail?: string;
      readState?: "read" | "unread";
    }
);

// A count of everything a search matches. Only ids and numbers cross the
// server (R-1): a sender group names the newest message it counted, which
// the server reads from the provider, rather than the address itself.
export const localMailCountResultSchema = z.object({
  status: z.literal("counted"),
  accounts: z
    .array(
      z.object({
        accountId: z.string().min(1).max(LOCAL_SEARCH_LIMITS.id),
        total: z.number().int().nonnegative().optional(),
        unavailable: localUnavailableReasonSchema.optional(),
      }),
    )
    .max(LOCAL_COUNT_LIMITS.accounts),
  groups: z
    .array(
      z.object({
        key: z.string().min(1).max(LOCAL_COUNT_LIMITS.groupKey).optional(),
        count: z.number().int().positive(),
        messageId: z.string().min(1).max(LOCAL_SEARCH_LIMITS.id),
        accountId: z.string().min(1).max(LOCAL_SEARCH_LIMITS.id),
      }),
    )
    .max(LOCAL_COUNT_LIMITS.groups),
  groupCount: z.number().int().nonnegative(),
  newest: z
    .array(
      z.object({
        id: z.string().min(1).max(LOCAL_SEARCH_LIMITS.id),
        threadId: z.string().min(1).max(LOCAL_SEARCH_LIMITS.id),
        accountId: z.string().min(1).max(LOCAL_SEARCH_LIMITS.id),
      }),
    )
    .max(LOCAL_COUNT_LIMITS.newest),
});
export type LocalMailCountResult = z.infer<typeof localMailCountResultSchema>;

// What a browser's local mail store answers to one of the assistant's inbox
// searches. It goes into the model's context like a Gmail result, so every
// field is bounded.
export const localMailSearchResultSchema = z.discriminatedUnion("status", [
  localMailCountResultSchema,
  z.object({
    status: z.literal("ok"),
    messages: z
      .array(
        z.object({
          id: z.string().min(1).max(LOCAL_SEARCH_LIMITS.id),
          threadId: z.string().min(1).max(LOCAL_SEARCH_LIMITS.id),
          subject: z.string().max(LOCAL_SEARCH_LIMITS.subject),
          from: z.string().max(LOCAL_SEARCH_LIMITS.address),
          to: z.string().max(LOCAL_SEARCH_LIMITS.recipients),
          snippet: z.string().max(LOCAL_SEARCH_LIMITS.snippet),
          date: z.string().datetime(),
          labelIds: z
            .array(z.string().max(LOCAL_SEARCH_LIMITS.id))
            .max(LOCAL_SEARCH_LIMITS.labels),
          hasAttachments: z.boolean(),
        }),
      )
      .max(LOCAL_SEARCH_LIMITS.messages),
    nextPageToken: z.string().max(LOCAL_SEARCH_LIMITS.pageToken).optional(),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: localUnavailableReasonSchema,
  }),
]);
export type LocalMailSearchResult = z.infer<typeof localMailSearchResultSchema>;

// Pages of a local answer carry this prefix, so a page walk stays on the
// store that started it.
export const LOCAL_PAGE_TOKEN_PREFIX = "local:";

export function isLocalPageToken(pageToken: string | null | undefined) {
  return Boolean(pageToken?.startsWith(LOCAL_PAGE_TOKEN_PREFIX));
}

export const submitLocalMailSearchResultBody = z.object({
  requestId: z.string().uuid(),
  result: localMailSearchResultSchema,
});
