import { z } from "zod";

export const muteThreadsBody = z.object({
  threadIds: z.array(z.string().min(1).max(512)).min(1).max(1000),
});
