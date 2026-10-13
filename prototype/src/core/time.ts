// Time-zone helpers. People think in local time ("Thursday at 2:30"); sources
// store UTC. Mixing the two is the classic way to put an event on the wrong day.

/** YYYY-MM-DD of an instant, as seen in `tz`. */
export function localDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** e.g. "Sat Oct 18, 10:00 AM" in `tz`. */
export function formatLocal(iso: string, tz: string, withTime = true): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(new Date(iso));
}

/** The UTC instant for a wall-clock time (`YYYY-MM-DD`, hours, minutes) in `tz`. */
export function zonedToUtc(date: string, hours: number, minutes: number, tz: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hours, minutes);
  // How far is `tz` from UTC at that moment? Format the guess in tz and compare.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
  );
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (asLocal - guess)).toISOString();
}

export const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
