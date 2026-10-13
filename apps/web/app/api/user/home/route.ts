import { NextResponse } from "next/server";
import { withEmailProvider } from "@/utils/middleware";
import { getHomeData } from "@/utils/home/get-home";

export type GetHomeResponse = Awaited<ReturnType<typeof getHomeData>>;

export const maxDuration = 30;

export const GET = withEmailProvider("user/home", async (request) =>
  NextResponse.json(
    await getHomeData({
      emailAccountId: request.auth.emailAccountId,
      userEmail: request.auth.email,
      emailProvider: request.emailProvider,
      logger: request.logger,
    }),
  ),
);
