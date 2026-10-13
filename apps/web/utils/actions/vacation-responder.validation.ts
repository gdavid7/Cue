import { z } from "zod";

export const vacationResponderBody = z
  .object({
    enabled: z.boolean(),
    /** Gmail only: Outlook automatic replies have no subject of their own. */
    subject: z.string().trim().max(500),
    message: z.string().trim().max(10_000),
    startTime: z.coerce.date().nullish(),
    endTime: z.coerce.date().nullish(),
  })
  .refine((body) => !body.enabled || body.message.length > 0, {
    message: "Write the reply people will get",
    path: ["message"],
  })
  .refine(
    (body) =>
      !body.startTime ||
      !body.endTime ||
      body.startTime.getTime() < body.endTime.getTime(),
    {
      message: "The last day must come after the first day",
      path: ["endTime"],
    },
  );
export type VacationResponderBody = z.infer<typeof vacationResponderBody>;
