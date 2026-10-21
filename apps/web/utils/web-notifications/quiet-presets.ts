import { addDays, addHours, format, isSameDay, nextMonday } from "date-fns";

/** The hour a "morning" pause ends, in the reader's own time zone. */
export const QUIET_MORNING_HOUR = 8;

export function getQuietPresets(now: Date) {
  const morning = atMorning(
    now.getHours() < QUIET_MORNING_HOUR ? now : addDays(now, 1),
  );
  const monday = atMorning(nextMonday(now));
  const presets = [
    { id: "hour", label: "For 1 hour", until: addHours(now, 1) },
    {
      id: "morning",
      label: isSameDay(morning, now)
        ? "Until this morning"
        : "Until tomorrow morning",
      until: morning,
    },
    { id: "monday", label: "Until Monday morning", until: monday },
  ];
  // On a Sunday, Monday morning is tomorrow morning.
  return presets.filter(
    (preset) =>
      preset.id !== "monday" || preset.until.getTime() !== morning.getTime(),
  );
}

/** "9:30 PM" today, "tomorrow at 8:00 AM", otherwise the day as well. */
export function formatQuietUntil(until: Date, now: Date) {
  if (isSameDay(until, now)) return format(until, "p");
  if (isSameDay(until, addDays(now, 1)))
    return format(until, "'tomorrow at' p");
  return format(until, "EEE, MMM d 'at' p");
}

function atMorning(day: Date) {
  const date = new Date(day);
  date.setHours(QUIET_MORNING_HOUR, 0, 0, 0);
  return date;
}
