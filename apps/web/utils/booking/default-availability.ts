import type { AvailabilityRule } from "@inboxzero/scheduling";

// Monday to Friday, 9:00 to 17:00: the hours a new booking link starts with,
// what the weekly hours editor shows before it is saved, and what shared free
// times assume until then.
export const DEFAULT_WEEKDAY_WINDOWS: AvailabilityRule[] = [1, 2, 3, 4, 5].map(
  (weekday) => ({
    weekday,
    startMinutes: 9 * 60,
    endMinutes: 17 * 60,
  }),
);
