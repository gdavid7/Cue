import { z } from "zod";
import { isValidTimeZone } from "@inboxzero/scheduling";

export const disconnectCalendarBody = z.object({
  connectionId: z.string(),
});
export type DisconnectCalendarBody = z.infer<typeof disconnectCalendarBody>;

export const toggleCalendarBody = z.object({
  calendarId: z.string(),
  isEnabled: z.boolean(),
});
export type ToggleCalendarBody = z.infer<typeof toggleCalendarBody>;

export const updateTimezoneBody = z.object({
  timezone: z.string().refine(isValidTimeZone, {
    message: "Use a valid IANA timezone",
  }),
});
export type UpdateTimezoneBody = z.infer<typeof updateTimezoneBody>;

export const updateBookingLinkBody = z.object({
  bookingLink: z
    .string()
    .url("Must be a valid URL")
    .optional()
    .or(z.literal("")),
});
export type UpdateBookingLinkBody = z.infer<typeof updateBookingLinkBody>;

export const addToCalendarBody = z.object({
  title: z.string().trim().min(1, "Add a title").max(500),
  // YYYY-MM-DD for an all-day item, or an ISO date-time with its offset
  start: z.string().min(1),
  end: z.string().nullish(),
  location: z.string().max(1000).nullish(),
  timezone: z.string().refine(isValidTimeZone, {
    message: "Use a valid IANA timezone",
  }),
});
export type AddToCalendarBody = z.infer<typeof addToCalendarBody>;
