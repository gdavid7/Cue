import { z } from "zod";

// What a browser's local mail store answers to one of the assistant's inbox
// searches. It goes into the model's context like a Gmail result, so every
// field is bounded.
export const localMailSearchResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    messages: z
      .array(
        z.object({
          id: z.string().min(1).max(256),
          threadId: z.string().min(1).max(256),
          subject: z.string().max(1000),
          from: z.string().max(1000),
          to: z.string().max(4000),
          snippet: z.string().max(1000),
          date: z.string().datetime(),
          labelIds: z.array(z.string().max(256)).max(100),
          hasAttachments: z.boolean(),
        }),
      )
      .max(100),
    nextPageToken: z.string().max(2048).optional(),
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
