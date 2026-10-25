import { z } from "zod";

export const activationSignals = [
  "first_sync_ready",
  "first_thread_opened",
  "first_triage_action",
  "first_waiting_on_you_item",
] as const;

export const activationSignalBody = z.object({
  event: z.enum(activationSignals),
  // With first_waiting_on_you_item only: how many rows showed, and how long
  // after Today opened. Counts and timings, never what the rows say.
  itemCount: z.number().int().min(1).max(25).optional(),
  msSinceTodayOpened: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1000)
    .optional(),
});
export type ActivationSignalBody = z.infer<typeof activationSignalBody>;
export type ActivationSignal = ActivationSignalBody["event"];
