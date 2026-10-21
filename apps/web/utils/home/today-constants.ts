import type { Priority } from "@/utils/home/get-home";
import type { NextUpItem } from "@/utils/home/next-up";

// Shared by the server's Today and the browser's merge across accounts, so
// one account and all of them sort and cap alike. Free of server imports.

/** Each of Today's lanes holds at most this many conversations. */
export const HOME_LANE_LIMIT = 10;
/** Next up shows this many meetings and deadlines. */
export const NEXT_UP_SHOWN = 4;
/** Before your meeting shows this many meetings. */
export const MEETING_NEWS_SHOWN = 3;
/** Mail Cue filed this recently is its to handle, not the rest of the inbox. */
export const HANDLED_WINDOW_DAYS = 7;
// A rough per-email estimate, shown with a "~" so nobody reads it as measured.
export const MINUTES_PER_REPLY = 3;
export const PRIORITY_ORDER: Record<Priority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** Soonest first; ties broken by source, then title, so the order never flickers. */
export function sortByDue(items: NextUpItem[]) {
  return [...items].sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      a.source.localeCompare(b.source) ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id),
  );
}
