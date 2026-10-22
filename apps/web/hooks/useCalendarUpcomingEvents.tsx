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
  return useSWR<GetCalendarTodayEventsResponse>(
    getAccountScopedKey(
      `/api/user/calendar/upcoming-events?range=today&tz=${encodeURIComponent(browserTimeZone())}`,
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
