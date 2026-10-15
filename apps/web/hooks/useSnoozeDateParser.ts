import { useEffect, useState } from "react";
import type { SnoozeDateParser } from "@/app/(app)/[emailAccountId]/mail/snooze-date-parse";

/**
 * The natural-language date parser, loaded once it is first needed so it
 * stays out of every page's first load. A chunk that fails to load is asked
 * for again the next time it is needed.
 */
export function useSnoozeDateParser(
  needed: boolean,
  load: () => Promise<SnoozeDateParser> = loadSnoozeDateParser,
) {
  const [parser, setParser] = useState<SnoozeDateParser | null>(null);
  useEffect(() => {
    if (!needed || parser) return;
    let cancelled = false;
    load().then(
      (loaded) => {
        if (!cancelled) setParser(() => loaded);
      },
      () => {
        if (!cancelled) setParser(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [needed, parser, load]);
  return parser;
}

async function loadSnoozeDateParser() {
  const { parseSnoozeDate } = await import(
    "@/app/(app)/[emailAccountId]/mail/snooze-date-parse"
  );
  return parseSnoozeDate;
}
