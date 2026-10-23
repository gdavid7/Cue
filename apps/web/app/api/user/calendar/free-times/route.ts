import { NextResponse } from "next/server";
import { getFreeTimes } from "@/utils/calendar/free-times";
import { withEmailAccount } from "@/utils/middleware";

export type GetFreeTimesResponse = Awaited<ReturnType<typeof getFreeTimes>>;

// The composer's "Share my free times": someone is waiting on it (D-086).
export const GET = withEmailAccount(
  "user/calendar/free-times",
  async (request) => {
    const result = await getFreeTimes({
      emailAccountId: request.auth.emailAccountId,
      logger: request.logger,
    });
    // Calendars change by the minute; never let a cache answer for them.
    return NextResponse.json(result satisfies GetFreeTimesResponse, {
      headers: { "Cache-Control": "no-store" },
    });
  },
);
