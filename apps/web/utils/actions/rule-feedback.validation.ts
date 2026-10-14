import { z } from "zod";

export const markNoReplyNeededBody = z.object({
  threadId: z.string().trim().min(1).max(512),
});
