import { z } from "zod";

export const removeCueLabelsBody = z.object({
  labelIds: z.array(z.string().min(1)).min(1).max(20),
});
