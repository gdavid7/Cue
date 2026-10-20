/**
 * A built search with its dates written the way the person reads them
 * ("after Oct 3, 2026", in their locale) rather than as the epoch seconds
 * Gmail is sent or the ISO days Outlook is. For display only: it can't be
 * parsed back into a search.
 */
export function describeSearch(
  search: string,
  { timeZone, locale }: { timeZone: string; locale?: string },
): string {
  const day = (ms: number, zone: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeZone: zone,
    }).format(new Date(ms));
  return search
    .replace(
      /\b(after|before):(\d{9,11})\b/g,
      (_, name: string, seconds: string) =>
        `${name} ${day(Number(seconds) * 1000, timeZone)}`,
    )
    .replace(
      /\breceived(>=|<)(\d{4})-(\d{2})-(\d{2})\b/g,
      (
        _,
        comparator: string,
        year: string,
        month: string,
        dayOfMonth: string,
      ) => {
        // A whole day, so the same day in every zone.
        const ms = Date.UTC(
          Number(year),
          Number(month) - 1,
          Number(dayOfMonth),
        );
        return `${comparator === ">=" ? "from" : "before"} ${day(ms, "UTC")}`;
      },
    );
}
