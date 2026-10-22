import { format } from "date-fns";
import useSWR from "swr";
import type {
  GetCalendarTodayEventsResponse,
  GetCalendarUpcomingEventsResponse,
} from "@/app/api/user/calendar/upcoming-events/route";
import { getAccountScopedKey } from "@/utils/swr";

export function useCalendarUpcomingEvents() {
  return useSWR<GetCalendarUpcomingEventsResponse>(
    "/api/user/calendar/upcoming-events",
  );
}

/**
 * The meetings on the user's local day, from every calendar they connected.
 * Kept in SWR's memory only, like the rest of what the calendar returns.
 */
export function useCalendarTodayEvents(emailAccountId: string | null) {
  // The date is only in the key, so a tab left open past midnight asks for
  // the new day on its next render rather than keep showing yesterday's.
  return useSWR<GetCalendarTodayEventsResponse>(
    getAccountScopedKey(
      `/api/user/calendar/upcoming-events?range=today&tz=${encodeURIComponent(browserTimeZone())}&day=${format(new Date(), "yyyy-MM-dd")}`,
      emailAccountId,
    ),
  );
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
