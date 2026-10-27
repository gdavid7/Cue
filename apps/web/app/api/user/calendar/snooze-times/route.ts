import { NextResponse } from "next/server";
import { getSnoozeTimes } from "@/utils/calendar/snooze-times";
import { withEmailAccount } from "@/utils/middleware";

export type GetSnoozeTimesResponse = Awaited<ReturnType<typeof getSnoozeTimes>>;

// The snooze picker asks when it opens, with someone waiting on it (D-086).
export const GET = withEmailAccount(
  "user/calendar/snooze-times",
  async (request) => {
    const { emailAccountId, userId, email } = request.auth;
    const result = await getSnoozeTimes({
      emailAccountId,
      userId,
      email,
      logger: request.logger,
    });
    // Calendars change by the minute; never let a cache answer for them.
    return NextResponse.json(result satisfies GetSnoozeTimesResponse, {
      headers: { "Cache-Control": "no-store" },
    });
  },
);
