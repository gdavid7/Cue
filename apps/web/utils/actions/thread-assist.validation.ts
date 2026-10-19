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
