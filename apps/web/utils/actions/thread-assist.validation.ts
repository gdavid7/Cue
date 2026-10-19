import { z } from "zod";

export const markNeedsReplyBody = z.object({
  threadId: z.string().trim().min(1),
});

export const saveSuggestedReplyBody = z.object({
  threadId: z.string().trim().min(1),
  content: z.string().trim().min(1).max(10_000),
  /**
   * The suggestion as Cue wrote it, kept by the browser: the server keeps no
   * suggestions (RD-3). Compared with the sent reply to learn from edits.
   */
  suggested: z.string().trim().min(1).max(10_000).optional(),
});

export const recordSuggestedReplyDraftBody = z
  .object({
    threadId: z.string().trim().min(1).max(512),
    /** The message the reply answers. */
    messageId: z.string().trim().min(1).max(512),
    /** The mailbox draft the user's first edit of the suggestion became. */
    draftId: z.string().trim().min(1).max(512),
    /** A rule's suggestion: the server reads its text itself. */
    executedActionId: z.string().trim().min(1).max(64).optional(),
    /** A suggestion only this browser kept (RD-3), as Cue wrote it. */
    suggested: z.string().trim().min(1).max(10_000).optional(),
  })
  .refine((body) => body.executedActionId || body.suggested, {
    message: "Which suggestion the draft started from is required.",
  });

export const dismissReplySuggestionBody = z.object({
  executedActionId: z.string().trim().min(1).max(64),
});
