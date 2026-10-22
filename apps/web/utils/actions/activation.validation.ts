import { z } from "zod";

export const activationSignals = [
  "first_sync_ready",
  "first_thread_opened",
  "first_triage_action",
] as const;

export const activationSignalBody = z.object({
  event: z.enum(activationSignals),
});
export type ActivationSignalBody = z.infer<typeof activationSignalBody>;
export type ActivationSignal = ActivationSignalBody["event"];
