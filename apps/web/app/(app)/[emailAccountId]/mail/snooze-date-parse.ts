import * as chrono from "chrono-node";

// chrono-node and its locale grammars are large, so this lives apart from the
// snooze presets every mail screen renders and loads only when someone types
// a snooze time.
export function parseSnoozeDate(
  input: string,
  now = new Date(),
  { defaultHour = 9 }: { defaultHour?: number } = {},
) {
  const result = chrono.casual.parse(input.trim(), now, {
    forwardDate: true,
  })[0];
  if (!result) return null;

  const date = result.start.date();
  if (!result.start.isCertain("hour")) date.setHours(defaultHour, 0, 0, 0);
  if (date <= now) return null;

  return date;
}

export type SnoozeDateParser = typeof parseSnoozeDate;
