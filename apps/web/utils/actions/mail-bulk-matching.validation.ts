import { z } from "zod";

/**
 * A mail view or search, described the way the mail list queries it, for
 * acting on every conversation it holds rather than the loaded page.
 */
export const matchingScopeSchema = z.strictObject({
  q: z.string().trim().min(1).max(2000).optional(),
  type: z.string().trim().min(1).max(64).optional(),
  labelId: z.string().trim().min(1).max(256).optional(),
  labelIds: z.array(z.string().trim().min(1).max(256)).max(10).optional(),
  folderId: z.string().trim().min(1).max(256).optional(),
  isUnread: z.boolean().optional(),
});
export type MatchingScope = z.infer<typeof matchingScopeSchema>;

/** Narrows a scope to the messages an action would change. */
export type MatchingFilter = {
  inInbox?: boolean;
  unread?: boolean;
};

export const MATCHING_BULK_ACTIONS = [
  "archive",
  "mark_read",
  "mark_unread",
  "label",
  "trash",
  "spam",
  "delete_forever",
] as const;
export type MatchingBulkAction = (typeof MATCHING_BULK_ACTIONS)[number];

export const startMatchingBulkActionSchema = z
  .object({
    scope: matchingScopeSchema,
    action: z.enum(MATCHING_BULK_ACTIONS),
    labelId: z.string().trim().min(1).max(256).optional(),
  })
  .refine((input) => input.action !== "label" || Boolean(input.labelId), {
    message: "Choose a label to apply",
    path: ["labelId"],
  });

export const matchingBulkJobSchema = z.object({
  jobId: z.string().uuid(),
});
