import { z } from "zod";

export const dismissAwaySummaryBody = z.object({
  /** The last visit the dismissed card showed, as the summary returned it. */
  lastVisitAt: z.coerce.date(),
});
