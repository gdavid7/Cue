import { after, NextResponse } from "next/server";
import { recordActiveDay } from "@/utils/analytics/activation";
import { withEmailProvider } from "@/utils/middleware";
import { getHomeData } from "@/utils/home/get-home";

export type GetHomeResponse = Awaited<ReturnType<typeof getHomeData>>;

export const maxDuration = 30;

export const GET = withEmailProvider(
  "user/home",
  async (request) => {
    const { emailAccountId } = request.auth;
    const home = await getHomeData({
      emailAccountId,
      userEmail: request.auth.email,
      emailProvider: request.emailProvider,
      logger: request.logger,
      // "Today" and "after 5 pm" are the browser's, which the server can't see.
      timeZone: validTimeZone(request.nextUrl.searchParams.get("tz")),
    });
    after(() => recordActiveDay(emailAccountId));
    return NextResponse.json(home);
  },
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
