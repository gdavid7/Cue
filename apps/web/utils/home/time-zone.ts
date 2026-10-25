/**
 * The browser's IANA time zone from a Today request, which decides where
 * "today" starts; undefined when missing or not one the runtime knows.
 */
export function validTimeZone(value: string | null) {
  if (!value) return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return;
  }
}
