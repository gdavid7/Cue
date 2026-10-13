import { z } from "zod";

export const markNeedsReplyBody = z.object({
  threadId: z.string().trim().min(1),
});

export const saveSuggestedReplyBody = z.object({
  threadId: z.string().trim().min(1),
  content: z.string().trim().min(1).max(10_000),
});
