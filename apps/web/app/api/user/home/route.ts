import { NextResponse } from "next/server";
import { withEmailProvider } from "@/utils/middleware";
import { getHomeData } from "@/utils/home/get-home";

export type GetHomeResponse = Awaited<ReturnType<typeof getHomeData>>;

export const maxDuration = 30;

export const GET = withEmailProvider(
  "user/home",
  async (request) =>
    NextResponse.json(
      await getHomeData({
        emailAccountId: request.auth.emailAccountId,
        userEmail: request.auth.email,
        emailProvider: request.emailProvider,
        logger: request.logger,
        // "Today" and "after 5 pm" are the browser's, which the server can't see.
        timeZone: validTimeZone(request.nextUrl.searchParams.get("tz")),
      }),
    ),
  { maxDuration },
);

function validTimeZone(value: string | null) {
  if (!value) return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return;
  }
}
