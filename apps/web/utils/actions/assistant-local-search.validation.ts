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

// What a browser's local mail store answers to one of the assistant's inbox
// searches. It goes into the model's context like a Gmail result, so every
// field is bounded.
export const localMailSearchResultSchema = z.discriminatedUnion("status", [
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
    reason: z.enum([
      "no_engine",
      "unsupported_query",
      "not_synced",
      "not_indexed",
      "timeout",
      "error",
    ]),
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
