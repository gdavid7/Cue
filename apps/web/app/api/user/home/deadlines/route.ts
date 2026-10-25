import { NextResponse } from "next/server";
import { getDeadlines } from "@/utils/home/next-up";
import { validTimeZone } from "@/utils/home/time-zone";
import { withEmailAccount } from "@/utils/middleware";

export type GetHomeDeadlinesResponse = Awaited<ReturnType<typeof getDeadlines>>;

export const GET = withEmailAccount("user/home/deadlines", async (request) => {
  const deadlines = await getDeadlines({
    emailAccountId: request.auth.emailAccountId,
    // Due dates without a time end with the user's day, which the server can't see.
    timeZone: validTimeZone(request.nextUrl.searchParams.get("tz")) ?? "UTC",
    logger: request.logger,
    now: new Date(),
  });
  // The user's own tasks: the browser may keep them, nothing in between (R-1).
  return NextResponse.json(deadlines, {
    headers: { "Cache-Control": "private, no-store" },
  });
});
