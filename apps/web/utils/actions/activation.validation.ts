import { z } from "zod";

export const activationSignalBody = z.object({
  event: z.enum([
    "first_sync_ready",
    "first_thread_opened",
    "first_triage_action",
  ]),
});
export type ActivationSignalBody = z.infer<typeof activationSignalBody>;
