import { z } from "zod";

export const dismissHintBody = z.object({
  hintId: z.string().max(200),
});
