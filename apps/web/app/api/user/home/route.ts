import { after, NextResponse } from "next/server";
import { recordActiveDay } from "@/utils/analytics/activation";
import { withEmailProvider } from "@/utils/middleware";
import { getHomeData } from "@/utils/home/get-home";
import { validTimeZone } from "@/utils/home/time-zone";
import type { Logger } from "@/utils/logger";
import { getUserOwnAddresses } from "@/utils/user/own-addresses";

export type GetHomeResponse = Awaited<ReturnType<typeof getHomeData>>;

export const maxDuration = 30;

export const GET = withEmailProvider(
  "user/home",
  async (request) => {
    const { emailAccountId, userId } = request.auth;
    const home = await getHomeData({
      emailAccountId,
      userEmail: request.auth.email,
      // Only Next up needs them, late: they load alongside Today's reads.
      ownAddresses: ownAddresses({
        userId,
        email: request.auth.email,
        logger: request.logger,
      }),
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

// Today still loads when the addresses can't be read; it then checks the
// account's own address only.
async function ownAddresses({
  userId,
  email,
  logger,
}: {
  userId: string;
  email: string;
  logger: Logger;
}) {
  const addresses = await getUserOwnAddresses(userId).catch((error) => {
    logger.warn("Failed to load own addresses for Today", { error });
    return [];
  });
  return [email, ...addresses];
}
